import { requireAuth } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { ApiError, handle } from "@/lib/errors";
import { createPost, getProfileTimezone, listPosts, type PostStatus } from "@/lib/posts";
import { readContent, readJson, readSchedule, readStatus } from "@/lib/validation";

const STATUSES: PostStatus[] = ["draft", "scheduled", "publishing", "published", "failed", "cancelled"];

// GET /api/v1/posts?status=&limit=&cursor=
export const GET = handle(async (request: Request) => {
  const auth = await requireAuth(request);
  const params = new URL(request.url).searchParams;

  const status = params.get("status");
  if (status && !STATUSES.includes(status as PostStatus)) {
    throw new ApiError(400, "invalid_status", `status debe ser uno de: ${STATUSES.join(", ")}`);
  }
  const limit = Number(params.get("limit") ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(400, "invalid_limit", "limit debe estar entre 1 y 100");
  }

  const page = await withTenant(auth.tenantId, (client) =>
    listPosts(client, { status: (status as PostStatus) || null, limit, cursor: params.get("cursor") }),
  );
  return Response.json({ items: page.items, next_cursor: page.nextCursor });
});

// POST /api/v1/posts  { content, status: "draft"|"scheduled", scheduled_at? | scheduled_local? }
export const POST = handle(async (request: Request) => {
  const auth = await requireAuth(request);
  const body = await readJson(request);
  const content = readContent(body.content);
  const status = readStatus(body.status ?? "draft");

  const post = await withTenant(auth.tenantId, async (client) => {
    const timezone = await getProfileTimezone(client, auth.profileId);
    const scheduledAt = readSchedule(body, timezone) ?? null;
    if (status === "scheduled" && !scheduledAt) {
      throw new ApiError(400, "invalid_schedule", "Un post scheduled necesita scheduled_at o scheduled_local");
    }
    return createPost(client, { tenantId: auth.tenantId, profileId: auth.profileId, content, status, scheduledAt });
  });

  return Response.json({ post }, { status: 201 });
});
