import { jwtVerify } from "jose";
import { ApiError } from "./errors";

export type Auth = { tenantId: string; profileId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error("JWT_SECRET no configurado (mínimo 32 caracteres)");
  return new TextEncoder().encode(value);
}

// El tenant y el Embajador salen SIEMPRE del token firmado, nunca del body
export async function requireAuth(request: Request): Promise<Auth> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) throw new ApiError(401, "unauthorized", "Falta el token");

  try {
    const { payload } = await jwtVerify(header.slice(7), secret(), { algorithms: ["HS256"] });
    const tenantId = payload.tenant_id;
    const profileId = payload.profile_id;
    if (
      typeof tenantId !== "string" ||
      !UUID.test(tenantId) ||
      typeof profileId !== "string" ||
      !UUID.test(profileId)
    ) {
      throw new Error("claims inválidos");
    }
    return { tenantId, profileId };
  } catch {
    throw new ApiError(401, "unauthorized", "Token no válido o caducado");
  }
}

export function isUuid(value: string) {
  return UUID.test(value);
}
