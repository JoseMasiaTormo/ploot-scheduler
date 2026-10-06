import { isUuid, requireAuth } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { ApiError, handle } from "@/lib/errors";
import { cancelPost, getPost, getProfileTimezone, updatePost } from "@/lib/posts";
import { readContent, readJson, readSchedule, readStatus } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

async function readId(ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_id", "id no válido");
  return id;
}

// GET /api/v1/posts/:id
export const GET = handle(async (request: Request, ctx: Ctx) => {
  const auth = await requireAuth(request);
  const id = await readId(ctx);
  const post = await withTenant(auth.tenantId, (client) => getPost(client, id));
  // Un post de otro tenant es invisible por RLS: 404, no 403 (no revelamos que existe)
  if (!post) throw new ApiError(404, "not_found", "Post no encontrado");
  return Response.json({ post });
});

// PATCH /api/v1/posts/:id  → 409 si ya está publicado o publicándose
export const PATCH = handle(async (request: Request, ctx: Ctx) => {
  const auth = await requireAuth(request);
  const id = await readId(ctx);
  const body = await readJson(request);

  const post = await withTenant(auth.tenantId, async (client) => {
    const timezone = await getProfileTimezone(client, auth.profileId);
    return updatePost(client, auth.tenantId, id, {
      content: body.content !== undefined ? readContent(body.content) : undefined,
      status: body.status !== undefined ? readStatus(body.status) : undefined,
      scheduledAt: readSchedule(body, timezone),
    });
  });
  return Response.json({ post });
});

// DELETE /api/v1/posts/:id  → cancela (no borra: queda el historial)
export const DELETE = handle(async (request: Request, ctx: Ctx) => {
  const auth = await requireAuth(request);
  const id = await readId(ctx);
  const post = await withTenant(auth.tenantId, (client) => cancelPost(client, auth.tenantId, id));
  return Response.json({ post });
});
