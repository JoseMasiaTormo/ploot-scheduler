import { requireAuth } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { handle } from "@/lib/errors";
import { listProfileLag } from "@/lib/posts";

// GET /api/v1/ops/lag → "¿por qué va atrasado el Embajador X?" sin leer código:
// posts vencidos, el más antiguo, si está bloqueado por 429, estado del token
// y último error. Solo ve su tenant (la vista usa security_invoker + RLS).
export const GET = handle(async (request: Request) => {
  const auth = await requireAuth(request);
  const profiles = await withTenant(auth.tenantId, (client) => listProfileLag(client));
  return Response.json({ profiles });
});
