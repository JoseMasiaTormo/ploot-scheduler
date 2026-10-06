// Ejecutar con la BD y el mock levantados y el worker PARADO:
//   docker compose up -d db mock && docker compose stop worker
//   cd worker && npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { config } from "../src/config.js";
import { claimBatch, markPublished, reapStuck } from "../src/queue.js";
import { publish } from "../src/provider.js";
import { backoffSeconds } from "../src/processor.js";

const admin = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
const TENANT = crypto.randomUUID();
const runTag = crypto.randomBytes(3).toString("hex");

async function createProfile(name: string) {
  const id = crypto.randomUUID();
  await admin.query("INSERT INTO profiles (id, tenant_id, display_name) VALUES ($1, $2, $3)", [id, TENANT, name]);
  await admin.query(
    `INSERT INTO oauth_tokens (profile_id, tenant_id, access_token_enc, refresh_token_enc, expires_at)
     VALUES ($1, $2, pgp_sym_encrypt($3, $5), pgp_sym_encrypt($4, $5), now() + interval '1 hour')`,
    [id, TENANT, `tok_ok_test_${runTag}_${name}`, `ref_ok_test_${name}`, config.tokenEncKey],
  );
  return id;
}

async function createDuePost(profileId: string, content: string) {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO posts (tenant_id, profile_id, content, status, scheduled_at)
     VALUES ($1, $2, $3, 'scheduled', now() - interval '1 second') RETURNING id`,
    [TENANT, profileId, content],
  );
  return rows[0].id;
}

// Devuelve a la cola los posts del seed que un test haya podido reclamar
async function releaseForeignClaims() {
  await admin.query(
    `UPDATE posts SET status = 'scheduled', locked_by = NULL, locked_at = NULL,
            attempts = GREATEST(attempts - 1, 0)
     WHERE status = 'publishing' AND locked_by LIKE 'test-%' AND tenant_id <> $1`,
    [TENANT],
  );
}

before(async () => {
  await admin.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [TENANT, `test-${runTag}`]);
});

after(async () => {
  await releaseForeignClaims();
  await admin.query("DELETE FROM posts WHERE tenant_id = $1", [TENANT]);
  await admin.query("DELETE FROM profiles WHERE tenant_id = $1", [TENANT]);
  await admin.query("DELETE FROM tenants WHERE id = $1", [TENANT]);
  await admin.end();
});

test("N réplicas reclamando a la vez: ningún post se reclama dos veces", async () => {
  const myPosts: string[] = [];
  for (let i = 0; i < 20; i++) {
    const profile = await createProfile(`p${i}`);
    myPosts.push(await createDuePost(profile, `post ${i}`));
  }

  // 8 "réplicas", cada una con su propio pool de conexiones, a la vez
  const replicas = Array.from({ length: 8 }, (_, i) => ({
    id: `test-replica-${i}`,
    pool: new pg.Pool({ connectionString: config.databaseUrl, max: 2 }),
  }));
  const results = await Promise.all(replicas.map((r) => claimBatch(r.pool, r.id, 1000)));
  await Promise.all(replicas.map((r) => r.pool.end()));

  const claimedIds = results.flat().map((p) => p.id);
  assert.equal(new Set(claimedIds).size, claimedIds.length, "Hay un post reclamado por dos réplicas");
  for (const id of myPosts) assert.ok(claimedIds.includes(id), `El post ${id} no lo reclamó nadie`);

  // En BD, cada post tiene exactamente un dueño
  const { rows } = await admin.query("SELECT locked_by FROM posts WHERE id = ANY($1)", [myPosts]);
  assert.ok(rows.every((r) => r.locked_by?.startsWith("test-replica-")));

  await admin.query("DELETE FROM posts WHERE tenant_id = $1", [TENANT]);
  await releaseForeignClaims();
});

test("Máximo 1 publicación en vuelo por Embajador, aunque haya N réplicas", async () => {
  const profile = await createProfile("solo");
  for (let i = 0; i < 5; i++) await createDuePost(profile, `solo ${i}`);

  const pools = Array.from({ length: 5 }, () => new pg.Pool({ connectionString: config.databaseUrl, max: 2 }));
  const results = await Promise.all(pools.map((p, i) => claimBatch(p, `test-solo-${i}`, 1000)));
  await Promise.all(pools.map((p) => p.end()));

  const mine = results.flat().filter((p) => p.profile_id === profile);
  assert.equal(mine.length, 1, `Se reclamaron ${mine.length} posts del mismo Embajador a la vez`);

  await admin.query("DELETE FROM posts WHERE tenant_id = $1", [TENANT]);
  await releaseForeignClaims();
});

test("Crash a mitad de publicación: el reaper lo recupera y NO se publica dos veces", async () => {
  const profile = await createProfile("crash");
  const postId = await createDuePost(profile, "post que sobrevive a un crash");

  // Worker A reclama y publica en el proveedor...
  const [claimA] = (await claimBatch(admin, "test-A", 1000)).filter((p) => p.id === postId);
  assert.ok(claimA, "A no pudo reclamar el post");
  const { rows: tokenRows } = await admin.query<{ token: string }>(
    "SELECT pgp_sym_decrypt(access_token_enc, $2) AS token FROM oauth_tokens WHERE profile_id = $1",
    [profile, config.tokenEncKey],
  );
  let firstExternalId: string | undefined;
  for (let i = 0; i < 15 && !firstExternalId; i++) {
    const r = await publish(tokenRows[0].token, claimA.content, postId);
    if (r.kind === "ok") firstExternalId = r.externalId;
    else await new Promise((res) => setTimeout(res, 1000)); // el mock falla al azar
  }
  assert.ok(firstExternalId, "El mock no aceptó la publicación");
  // ...y se "muere" antes de guardar el resultado (no llama a markPublished)
  await releaseForeignClaims();

  // El reaper ve el lock caducado y lo devuelve a la cola
  await admin.query("UPDATE posts SET locked_at = now() - interval '10 minutes' WHERE id = $1", [postId]);
  assert.ok((await reapStuck(admin, 60)) >= 1);

  // Worker B lo reclama y reintenta con la MISMA Idempotency-Key
  const [claimB] = (await claimBatch(admin, "test-B", 1000)).filter((p) => p.id === postId);
  assert.ok(claimB, "B no pudo reclamar el post tras el reaper");
  const retry = await publish(tokenRows[0].token, claimB.content, postId);
  assert.equal(retry.kind, "ok");
  assert.equal(retry.kind === "ok" && retry.externalId, firstExternalId, "El proveedor creó una segunda publicación");
  assert.ok(await markPublished(admin, claimB, "test-B", firstExternalId));

  // A "resucita" e intenta cerrar el post: no puede pisar el trabajo de B
  assert.equal(await markPublished(admin, claimA, "test-A", "ext_fantasma"), false);

  const { rows } = await admin.query("SELECT status, external_id FROM posts WHERE id = $1", [postId]);
  assert.deepEqual(rows[0], { status: "published", external_id: firstExternalId });
});

test("Backoff exponencial con jitter dentro de límites", () => {
  for (let attempt = 1; attempt <= 6; attempt++) {
    for (let i = 0; i < 50; i++) {
      const s = backoffSeconds(attempt);
      assert.ok(s >= 1 && s <= Math.min(300, 2 * 2 ** (attempt - 1)), `attempt ${attempt}: ${s}`);
    }
  }
});
