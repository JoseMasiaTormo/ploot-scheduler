import { isUuid, requireAuth } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { ApiError, handle } from "@/lib/errors";
import { publishNow } from "@/lib/posts";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/v1/posts/:id/publish  (header Idempotency-Key obligatorio)
// 202 Accepted: queda en cola para "ahora"; lo publica el worker.
export const POST = handle(async (request: Request, ctx: Ctx) => {
  const auth = await requireAuth(request);
  const { id } = await ctx.params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_id", "id no válido");

  const key = request.headers.get("idempotency-key");
  if (!key || key.length > 200) {
    throw new ApiError(400, "missing_idempotency_key", "Falta la cabecera Idempotency-Key");
  }

  const result = await withTenant(auth.tenantId, (client) => publishNow(client, auth.tenantId, id, key));
  return Response.json(result.body, {
    status: result.status,
    headers: { "idempotent-replayed": String(result.replayed) },
  });
});
