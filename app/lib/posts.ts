import type { PoolClient } from "pg";
import { ApiError } from "./errors";

// Capa de query. Ninguna query filtra por tenant a mano: lo hace RLS en
// Postgres con el app.tenant_id que fija withTenant(). Si alguien olvida un
// filtro, la base de datos sigue sin devolver filas de otro tenant.

export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";

const COLUMNS = `id, profile_id, content, status, scheduled_at, attempts, next_attempt_at,
  external_id, last_error_code, last_error_message, published_at, created_at, updated_at`;

// Estados en los que el usuario aún puede tocar el post
const EDITABLE = ["draft", "scheduled", "failed"];

async function addEvent(
  client: PoolClient,
  post: { id: string; profile_id: string },
  tenantId: string,
  from: string | null,
  to: string,
  detail: string,
) {
  await client.query(
    `INSERT INTO post_events (post_id, tenant_id, profile_id, from_status, to_status, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [post.id, tenantId, post.profile_id, from, to, detail],
  );
}

export async function createPost(
  client: PoolClient,
  input: {
    tenantId: string;
    profileId: string;
    content: string;
    status: "draft" | "scheduled";
    scheduledAt: Date | null;
  },
) {
  const { rows } = await client.query(
    `INSERT INTO posts (tenant_id, profile_id, content, status, scheduled_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
    [input.tenantId, input.profileId, input.content, input.status, input.scheduledAt],
  );
  await addEvent(client, rows[0], input.tenantId, null, input.status, "api:create");
  return rows[0];
}

export async function getPost(client: PoolClient, id: string) {
  const { rows } = await client.query(`SELECT ${COLUMNS} FROM posts WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// Paginación keyset (cursor = último created_at + id): estable y rápida con
// millones de filas, a diferencia de OFFSET. Usa posts_tenant_status_idx.
export async function listPosts(
  client: PoolClient,
  opts: { status: PostStatus | null; limit: number; cursor: string | null },
) {
  let cursorTs: string | null = null;
  let cursorId: string | null = null;
  if (opts.cursor) {
    try {
      [cursorTs, cursorId] = Buffer.from(opts.cursor, "base64url").toString("utf8").split("|");
    } catch {
      throw new ApiError(400, "invalid_cursor", "Cursor no válido");
    }
    if (!cursorTs || !cursorId) throw new ApiError(400, "invalid_cursor", "Cursor no válido");
  }

  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM posts
     WHERE ($1::post_status IS NULL OR status = $1)
       AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
     ORDER BY created_at DESC, id DESC
     LIMIT $4`,
    [opts.status, cursorTs, cursorId, opts.limit + 1],
  );

  const hasMore = rows.length > opts.limit;
  const items = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? Buffer.from(`${new Date(last.created_at).toISOString()}|${last.id}`).toString("base64url") : null;
  return { items, nextCursor };
}

// Si el UPDATE no toca ninguna fila: o no existe (para este tenant) o no es editable
async function notFoundOrConflict(client: PoolClient, id: string): Promise<never> {
  const current = await getPost(client, id);
  if (!current) throw new ApiError(404, "not_found", "Post no encontrado");
  throw new ApiError(409, "post_not_editable", `No se puede modificar un post en estado ${current.status}`, {
    status: current.status,
  });
}

export async function updatePost(
  client: PoolClient,
  tenantId: string,
  id: string,
  patch: {
    content?: string;
    scheduledAt?: Date | null;
    status?: "draft" | "scheduled";
  },
) {
  // El "WHERE status IN (...)" se evalúa con la fila bloqueada: si el worker
  // la acaba de pasar a "publishing", este UPDATE no la toca (sin carreras).
  const { rows } = await client.query(
    `UPDATE posts SET
       content = COALESCE($2, content),
       scheduled_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE scheduled_at END,
       status = COALESCE($5::post_status, status),
       attempts = CASE WHEN $5 = 'scheduled' THEN 0 ELSE attempts END,
       next_attempt_at = CASE WHEN $5 = 'scheduled' THEN NULL ELSE next_attempt_at END,
       updated_at = now()
     WHERE id = $1 AND status = ANY($6::post_status[])
     RETURNING ${COLUMNS}`,
    [
      id,
      patch.content ?? null,
      patch.scheduledAt !== undefined,
      patch.scheduledAt ?? null,
      patch.status ?? null,
      EDITABLE,
    ],
  );
  if (!rows[0]) return notFoundOrConflict(client, id);
  await addEvent(client, rows[0], tenantId, null, rows[0].status, "api:update");
  return rows[0];
}

export async function cancelPost(client: PoolClient, tenantId: string, id: string) {
  const { rows } = await client.query(
    `UPDATE posts SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND status = ANY($2::post_status[])
     RETURNING ${COLUMNS}`,
    [id, EDITABLE],
  );
  if (!rows[0]) return notFoundOrConflict(client, id);
  await addEvent(client, rows[0], tenantId, null, "cancelled", "api:cancel");
  return rows[0];
}

// Publicar ya = programarlo para "ahora". Lo publica el worker, que es quien
// gobierna los rate limits; el Route Handler nunca llama al proveedor.
// Idempotency-Key: repetir la misma petición devuelve la misma respuesta.
export async function publishNow(client: PoolClient, tenantId: string, id: string, key: string) {
  const previous = await client.query<{ post_id: string; response: { status: number; body: unknown } }>(
    "SELECT post_id, response FROM idempotency_keys WHERE key = $1",
    [key],
  );
  if (previous.rows[0]) return replay(previous.rows[0], id);

  const { rows } = await client.query(
    `UPDATE posts SET status = 'scheduled', scheduled_at = now(), next_attempt_at = NULL, attempts = 0,
            last_error_code = NULL, last_error_message = NULL, updated_at = now()
     WHERE id = $1 AND status = ANY($2::post_status[])
     RETURNING ${COLUMNS}`,
    [id, EDITABLE],
  );
  if (!rows[0]) return notFoundOrConflict(client, id);

  const response = { status: 202, body: { post: rows[0] } };
  // Si llega a la vez la misma clave, el segundo INSERT espera al primero y
  // no inserta nada: entonces devolvemos lo que guardó el primero.
  const inserted = await client.query(
    `INSERT INTO idempotency_keys (tenant_id, key, post_id, response) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [tenantId, key, id, JSON.stringify(response)],
  );
  if (inserted.rowCount === 0) {
    const winner = await client.query("SELECT post_id, response FROM idempotency_keys WHERE key = $1", [key]);
    return replay(winner.rows[0], id);
  }

  await addEvent(client, rows[0], tenantId, null, "scheduled", "api:publish_now");
  return { ...response, replayed: false };
}

function replay(stored: { post_id: string; response: { status: number; body: unknown } }, id: string) {
  if (stored.post_id !== id) {
    throw new ApiError(422, "idempotency_key_reused", "Esta Idempotency-Key ya se usó para otro post");
  }
  return { ...stored.response, replayed: true };
}

export async function listProfileLag(client: PoolClient) {
  const { rows } = await client.query(
    `SELECT profile_id, display_name, blocked_until, token_status, token_expires_at,
            overdue_posts, oldest_overdue_at, in_flight, last_error_code
     FROM profile_lag ORDER BY overdue_posts DESC, display_name`,
  );
  return rows;
}

export async function getProfileTimezone(client: PoolClient, profileId: string): Promise<string> {
  const { rows } = await client.query<{ timezone: string }>("SELECT timezone FROM profiles WHERE id = $1", [profileId]);
  if (!rows[0]) throw new ApiError(403, "forbidden", "Perfil no encontrado en este tenant");
  return rows[0].timezone;
}
