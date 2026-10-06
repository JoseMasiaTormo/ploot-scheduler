import pg from "pg";

// Un pool por instancia. En serverless cada instancia abre sus propias
// conexiones, por eso el pool es pequeño y en producción DATABASE_URL apunta
// a un pooler (PgBouncer en transaction mode / pooler de Neon).
const globalForPg = globalThis as unknown as { pgPool?: pg.Pool };

export function getPool(): pg.Pool {
  if (!globalForPg.pgPool) {
    globalForPg.pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL ?? "postgres://app_user:app_dev_only@localhost:55432/ploot",
      max: Number(process.env.PG_POOL_MAX ?? 5),
      idleTimeoutMillis: 10_000,
    });
  }
  return globalForPg.pgPool;
}

// Abre una transacción con el tenant fijado. Todas las queries de la app
// pasan por aquí: RLS filtra por app.tenant_id a nivel de Postgres.
// set_config(..., true) = solo para esta transacción → seguro con PgBouncer
// en transaction mode (la conexión se reutiliza sin "arrastrar" el tenant).
export async function withTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
