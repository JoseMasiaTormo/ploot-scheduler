import { config } from "./config.js";

// Taxonomía de errores: cada respuesta del proveedor se traduce a UNA decisión
export type PublishResult =
  | { kind: "ok"; externalId: string }
  | { kind: "rate_limited"; retryAfterSec: number }
  | { kind: "token_expired" }
  | { kind: "token_revoked" }
  | { kind: "retryable"; code: string; message: string }
  | { kind: "fatal"; code: string; message: string };

export function parseRetryAfter(value: string | null): number {
  if (!value) return 5;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 1), 3600);
  const date = Date.parse(value); // también puede venir como fecha HTTP
  if (Number.isFinite(date)) return Math.min(Math.max((date - Date.now()) / 1000, 1), 3600);
  return 5;
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.providerTimeoutMs);
  try {
    const res = await fetch(`${config.providerUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, json };
  } finally {
    clearTimeout(timer);
  }
}

export async function publish(accessToken: string, content: string, idempotencyKey: string): Promise<PublishResult> {
  try {
    const { res, json } = await postJson(
      "/provider/publish",
      { content },
      { authorization: `Bearer ${accessToken}`, "idempotency-key": idempotencyKey },
    );

    if (res.ok) return { kind: "ok", externalId: String(json.id) };
    if (res.status === 429)
      return { kind: "rate_limited", retryAfterSec: parseRetryAfter(res.headers.get("retry-after")) };
    if (res.status === 401 && json.error === "token_expired") return { kind: "token_expired" };
    if (res.status === 401) return { kind: "token_revoked" };
    if (res.status >= 500) return { kind: "retryable", code: "provider_unavailable", message: `HTTP ${res.status}` };
    return { kind: "fatal", code: "provider_rejected", message: `HTTP ${res.status} ${String(json.error ?? "")}` };
  } catch (err) {
    // Timeout o red: no sabemos si llegó. Reintentar es seguro por Idempotency-Key.
    return { kind: "retryable", code: "provider_timeout", message: String(err) };
  }
}

export type RefreshResult =
  | { kind: "ok"; accessToken: string; refreshToken: string; expiresIn: number }
  | { kind: "revoked" }
  | { kind: "transient"; message: string };

export async function refreshToken(refreshTokenValue: string): Promise<RefreshResult> {
  try {
    const { res, json } = await postJson("/provider/oauth/refresh", { refresh_token: refreshTokenValue });
    if (res.ok) {
      return {
        kind: "ok",
        accessToken: String(json.access_token),
        refreshToken: String(json.refresh_token ?? refreshTokenValue),
        expiresIn: Number(json.expires_in ?? 3600),
      };
    }
    if (res.status === 400 || res.status === 401) return { kind: "revoked" };
    return { kind: "transient", message: `HTTP ${res.status}` };
  } catch (err) {
    return { kind: "transient", message: String(err) };
  }
}
