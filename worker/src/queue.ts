import type { Pool, PoolClient } from "pg";

export type ClaimedPost = {
  id: string;
  tenant_id: string;
  profile_id: string;
  content: string;
  attempts: number;
};

type Db = Pool | PoolClient;

// 1) heads: el post más antiguo vencido de CADA Embajador (su "cabeza de cola").
// 2) ready: solo si esa cabeza puede salir ya (sin backoff pendiente, Embajador
//    no bloqueado por 429 y sin otra publicación suya en vuelo).
// 3) ranked: reparto justo entre tenants (round-robin): primero la 1ª cabeza
//    de cada tenant, luego la 2ª... así un tenant grande no acapara.
// 4) picked: FOR UPDATE SKIP LOCKED bloquea las filas elegidas y se salta las
//    que otra transacción ya tiene bloqueadas.
const CLAIM_SQL = `
WITH heads AS (
  SELECT DISTINCT ON (p.profile_id)
         p.id, p.tenant_id, p.profile_id, p.scheduled_at, p.next_attempt_at
  FROM posts p
  WHERE p.status = 'scheduled' AND p.scheduled_at <= now()
  ORDER BY p.profile_id, p.scheduled_at, p.id
),
ready AS (
  SELECT h.id, h.tenant_id, h.scheduled_at
  FROM heads h
  JOIN profiles pr ON pr.id = h.profile_id
  WHERE (h.next_attempt_at IS NULL OR h.next_attempt_at <= now())
    AND (pr.blocked_until IS NULL OR pr.blocked_until <= now())
    AND NOT EXISTS (
      SELECT 1 FROM posts q
      WHERE q.profile_id = h.profile_id AND q.status = 'publishing'
    )
),
ranked AS (
  SELECT id, scheduled_at,
         row_number() OVER (PARTITION BY tenant_id ORDER BY scheduled_at) AS rn
  FROM ready
),
picked AS (
  SELECT p.id
  FROM posts p
  JOIN ranked r ON r.id = p.id
  ORDER BY r.rn, r.scheduled_at
  LIMIT $1
  FOR UPDATE OF p SKIP LOCKED
)
UPDATE posts
SET status = 'publishing', locked_by = $2, locked_at = now(),
    attempts = attempts + 1, updated_at = now()
FROM picked
WHERE posts.id = picked.id
RETURNING posts.id, posts.tenant_id, posts.profile_id, posts.content, posts.attempts`;

export async function claimBatch(pool: Pool, workerId: string, globalMax: number): Promise<ClaimedPost[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serializa SOLO el reparto entre réplicas (dura milisegundos). Así el cap
    // global y el "1 en vuelo por Embajador" son exactos aunque haya N workers.
    // Es un lock de transacción: compatible con PgBouncer en transaction mode.
    await client.query("SELECT pg_advisory_xact_lock(4242)");

    const { rows: countRows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM posts WHERE status = 'publishing'",
    );
    const slots = globalMax - countRows[0].n;
    if (slots <= 0) {
      await client.query("COMMIT");
      return [];
    }

    const { rows } = await client.query<ClaimedPost>(CLAIM_SQL, [slots, workerId]);
    for (const post of rows) {
      await addEvent(client, post, "scheduled", "publishing", null, `attempt ${post.attempts}`, workerId);
    }
    await client.query("COMMIT");
    return rows;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function addEvent(
  db: Db,
  post: Pick<ClaimedPost, "id" | "tenant_id" | "profile_id">,
  from: string | null,
  to: string,
  errorCode: string | null,
  detail: string | null,
  workerId: string | null,
) {
  await db.query(
    `INSERT INTO post_events (post_id, tenant_id, profile_id, from_status, to_status, error_code, detail, worker_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [post.id, post.tenant_id, post.profile_id, from, to, errorCode, detail, workerId],
  );
}

// Todas las transiciones exigen status = 'publishing' AND locked_by = yo.
// Si el reaper ya me quitó el post (porque tardé demasiado), no piso nada.
export async function markPublished(pool: Pool, post: ClaimedPost, workerId: string, externalId: string) {
  const res = await pool.query(
    `UPDATE posts
     SET status = 'published', external_id = $3, published_at = now(),
         locked_by = NULL, locked_at = NULL, next_attempt_at = NULL,
         last_error_code = NULL, last_error_message = NULL, updated_at = now()
     WHERE id = $1 AND status = 'publishing' AND locked_by = $2`,
    [post.id, workerId, externalId],
  );
  if (res.rowCount === 1) await addEvent(pool, post, "publishing", "published", null, externalId, workerId);
  return res.rowCount === 1;
}

export async function reschedule(
  pool: Pool,
  post: ClaimedPost,
  workerId: string,
  delaySec: number,
  countsAsAttempt: boolean,
  errorCode: string,
  message: string,
) {
  const res = await pool.query(
    `UPDATE posts
     SET status = 'scheduled', next_attempt_at = now() + make_interval(secs => $3),
         attempts = attempts - $4, locked_by = NULL, locked_at = NULL,
         last_error_code = $5, last_error_message = $6, updated_at = now()
     WHERE id = $1 AND status = 'publishing' AND locked_by = $2`,
    [post.id, workerId, delaySec, countsAsAttempt ? 0 : 1, errorCode, message],
  );
  if (res.rowCount === 1) await addEvent(pool, post, "publishing", "scheduled", errorCode, message, workerId);
  return res.rowCount === 1;
}

export async function markFailed(pool: Pool, post: ClaimedPost, workerId: string, errorCode: string, message: string) {
  const res = await pool.query(
    `UPDATE posts
     SET status = 'failed', locked_by = NULL, locked_at = NULL,
         last_error_code = $3, last_error_message = $4, updated_at = now()
     WHERE id = $1 AND status = 'publishing' AND locked_by = $2`,
    [post.id, workerId, errorCode, message],
  );
  if (res.rowCount === 1) await addEvent(pool, post, "publishing", "failed", errorCode, message, workerId);
  return res.rowCount === 1;
}

// 429: bloquea al Embajador entero, así su cola no avanza hasta el Retry-After
export async function blockProfile(pool: Pool, profileId: string, seconds: number) {
  await pool.query(
    `UPDATE profiles
     SET blocked_until = GREATEST(COALESCE(blocked_until, now()), now() + make_interval(secs => $2))
     WHERE id = $1`,
    [profileId, seconds],
  );
}

// Reaper: si un worker murió a mitad, su post se queda en "publishing" para
// siempre. Tras lockTimeoutSec se devuelve a la cola. Es seguro reintentar
// porque al proveedor se le manda Idempotency-Key = id del post.
export async function reapStuck(pool: Pool, lockTimeoutSec: number) {
  const { rows } = await pool.query<{ id: string; tenant_id: string; profile_id: string }>(
    `UPDATE posts
     SET status = 'scheduled', locked_by = NULL, locked_at = NULL, next_attempt_at = now(),
         last_error_code = 'worker_lost',
         last_error_message = 'Lock caducado: se reintenta (seguro por Idempotency-Key)',
         updated_at = now()
     WHERE status = 'publishing' AND locked_at < now() - make_interval(secs => $1)
     RETURNING id, tenant_id, profile_id`,
    [lockTimeoutSec],
  );
  for (const post of rows) {
    await addEvent(pool, post, "publishing", "scheduled", "worker_lost", "reaper", null);
  }
  return rows.length;
}
