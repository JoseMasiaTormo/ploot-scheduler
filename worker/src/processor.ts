import type { Pool } from "pg";
import { config } from "./config.js";
import { log } from "./log.js";
import { publish } from "./provider.js";
import { getAccessToken, markTokenRevoked } from "./tokens.js";
import { blockProfile, markFailed, markPublished, reschedule, type ClaimedPost } from "./queue.js";

// Backoff exponencial con "full jitter": espera aleatoria entre 0 y base·2^(n-1).
// El azar evita que todos los reintentos vuelvan a la vez (retry storm).
export function backoffSeconds(attempt: number, baseSec = 2, capSec = 300): number {
  const ceiling = Math.min(capSec, baseSec * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.random() * ceiling);
}

export async function processPost(pool: Pool, post: ClaimedPost, workerId: string): Promise<void> {
  const ctx = { post_id: post.id, tenant_id: post.tenant_id, profile_id: post.profile_id, attempt: post.attempts };

  const retryOrFail = async (code: string, message: string) => {
    if (post.attempts >= config.maxAttempts) {
      await markFailed(pool, post, workerId, code, `${message} (tras ${post.attempts} intentos)`);
      log("post_failed", { ...ctx, error_code: code, message });
    } else {
      const delay = backoffSeconds(post.attempts);
      await reschedule(pool, post, workerId, delay, true, code, message);
      log("post_retry", { ...ctx, error_code: code, delay_sec: Math.round(delay) });
    }
  };

  // 1) Token: refrescar antes si está a punto de caducar
  let token = await getAccessToken(pool, post.profile_id);
  if (token.kind === "revoked" || token.kind === "missing") {
    await markFailed(pool, post, workerId, "token_revoked", "Token revocado: el Embajador debe reconectar su cuenta");
    log("post_failed", { ...ctx, error_code: "token_revoked" });
    return;
  }
  if (token.kind === "transient") return retryOrFail("token_refresh_unavailable", token.message);

  // 2) Publicar. Idempotency-Key = id del post: un reintento nunca duplica
  let result = await publish(token.token, post.content, post.id);

  // El proveedor dice "caducado" aunque nuestra fecha no: refrescar y reintentar 1 vez
  if (result.kind === "token_expired") {
    token = await getAccessToken(pool, post.profile_id, true);
    if (token.kind !== "ok") {
      if (token.kind === "transient") return retryOrFail("token_refresh_unavailable", token.message);
      await markFailed(
        pool,
        post,
        workerId,
        "token_revoked",
        "Refresh rechazado: el Embajador debe reconectar su cuenta",
      );
      log("post_failed", { ...ctx, error_code: "token_revoked" });
      return;
    }
    result = await publish(token.token, post.content, post.id);
  }

  // 3) Decidir según la taxonomía
  switch (result.kind) {
    case "ok":
      await markPublished(pool, post, workerId, result.externalId);
      log("post_published", { ...ctx, external_id: result.externalId });
      return;

    case "rate_limited":
      // No cuenta como intento y bloquea al Embajador: su cola no avanza
      await blockProfile(pool, post.profile_id, result.retryAfterSec);
      await reschedule(
        pool,
        post,
        workerId,
        result.retryAfterSec,
        false,
        "rate_limited",
        `429 del proveedor: esperando Retry-After ${result.retryAfterSec}s`,
      );
      log("post_rate_limited", { ...ctx, retry_after_sec: result.retryAfterSec });
      return;

    case "token_revoked":
      await markTokenRevoked(pool, post.profile_id);
      // Revocado = irrecuperable: no se queman reintentos
      await markFailed(pool, post, workerId, "token_revoked", "Token revocado por el proveedor");
      log("post_failed", { ...ctx, error_code: "token_revoked" });
      return;

    case "token_expired":
      await markFailed(pool, post, workerId, "token_revoked", "Sigue caducado tras refrescar");
      log("post_failed", { ...ctx, error_code: "token_revoked" });
      return;

    case "retryable":
      return retryOrFail(result.code, result.message);

    case "fatal":
      await markFailed(pool, post, workerId, result.code, result.message);
      log("post_failed", { ...ctx, error_code: result.code, message: result.message });
      return;
  }
}
