import type { Pool } from "pg";
import { config } from "./config.js";
import { refreshToken } from "./provider.js";
import { log } from "./log.js";

export type TokenResult =
  | { kind: "ok"; token: string }
  | { kind: "revoked" }
  | { kind: "missing" }
  | { kind: "transient"; message: string };

// Devuelve un access token usable. Si caduca en menos de refreshMarginSec
// (o forceRefresh), lo refresca ANTES de publicar.
// No hay carrera entre réplicas: solo hay 1 publicación en vuelo por Embajador.
export async function getAccessToken(pool: Pool, profileId: string, forceRefresh = false): Promise<TokenResult> {
  const { rows } = await pool.query<{
    status: string;
    expires_at: Date;
    access_token: string;
    refresh_token: string;
  }>(
    `SELECT status, expires_at,
            pgp_sym_decrypt(access_token_enc, $2) AS access_token,
            pgp_sym_decrypt(refresh_token_enc, $2) AS refresh_token
     FROM oauth_tokens WHERE profile_id = $1`,
    [profileId, config.tokenEncKey],
  );

  const row = rows[0];
  if (!row) return { kind: "missing" };
  if (row.status === "revoked") return { kind: "revoked" };

  const expiresSoon = row.expires_at.getTime() - Date.now() < config.refreshMarginSec * 1000;
  if (!expiresSoon && !forceRefresh) return { kind: "ok", token: row.access_token };

  const refreshed = await refreshToken(row.refresh_token);

  if (refreshed.kind === "ok") {
    await pool.query(
      `UPDATE oauth_tokens
       SET access_token_enc = pgp_sym_encrypt($2, $5),
           refresh_token_enc = pgp_sym_encrypt($3, $5),
           expires_at = now() + make_interval(secs => $4),
           updated_at = now()
       WHERE profile_id = $1`,
      [profileId, refreshed.accessToken, refreshed.refreshToken, refreshed.expiresIn, config.tokenEncKey],
    );
    log("token_refreshed", { profile_id: profileId });
    return { kind: "ok", token: refreshed.accessToken };
  }

  if (refreshed.kind === "revoked") {
    await pool.query("UPDATE oauth_tokens SET status = 'revoked', updated_at = now() WHERE profile_id = $1", [
      profileId,
    ]);
    log("token_revoked", { profile_id: profileId });
    return { kind: "revoked" };
  }

  return { kind: "transient", message: refreshed.message };
}

export async function markTokenRevoked(pool: Pool, profileId: string) {
  await pool.query("UPDATE oauth_tokens SET status = 'revoked', updated_at = now() WHERE profile_id = $1", [profileId]);
}
