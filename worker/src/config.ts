import os from "node:os";

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/ploot",
  providerUrl: process.env.PROVIDER_URL ?? "http://localhost:4000",
  tokenEncKey: process.env.TOKEN_ENC_KEY ?? "dev-only-token-key",
  workerId: process.env.WORKER_ID ?? `worker-${os.hostname()}-${process.pid}`,
  pollMs: Number(process.env.POLL_MS ?? 1000),
  // Cap global (por app): máximo de publicaciones en vuelo entre TODAS las réplicas
  globalMaxInFlight: Number(process.env.GLOBAL_MAX_IN_FLIGHT ?? 10),
  maxAttempts: Number(process.env.MAX_ATTEMPTS ?? 5),
  // Si un worker muere con un post en "publishing", tras este tiempo se reintenta
  lockTimeoutSec: Number(process.env.LOCK_TIMEOUT_SEC ?? 60),
  providerTimeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS ?? 10_000),
  // Margen para refrescar el token ANTES de que caduque
  refreshMarginSec: Number(process.env.REFRESH_MARGIN_SEC ?? 60),
  healthPort: process.env.PORT ? Number(process.env.PORT) : undefined,
};
