// Aislamiento de tenant a nivel SQL (RLS), conectando como app_user.
// Requiere la BD del docker compose con el seed:  npm test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { getPool, withTenant } from "../lib/db";
import { getPost, updatePost, cancelPost, listPosts } from "../lib/posts";

const ACME = "11111111-1111-4111-8111-111111111111";
const GLOBEX = "22222222-2222-4222-8222-222222222222";

after(async () => {
  await getPool().end();
});

async function anAcmePostId(): Promise<string> {
  const page = await withTenant(ACME, (c) => listPosts(c, { status: null, limit: 1, cursor: null }));
  assert.ok(page.items[0], "El seed debería tener posts de Acme");
  return page.items[0].id;
}

test("Globex no puede LEER un post de Acme aunque conozca su id", async () => {
  const acmePost = await anAcmePostId();
  const seen = await withTenant(GLOBEX, (c) => getPost(c, acmePost));
  assert.equal(seen, null);
});

test("Globex no puede MODIFICAR ni CANCELAR un post de Acme (404, no se toca)", async () => {
  const acmePost = await anAcmePostId();
  const before = await withTenant(ACME, (c) => getPost(c, acmePost));

  await assert.rejects(
    withTenant(GLOBEX, (c) => updatePost(c, GLOBEX, acmePost, { content: "hackeado" })),
    { status: 404 },
  );
  await assert.rejects(
    withTenant(GLOBEX, (c) => cancelPost(c, GLOBEX, acmePost)),
    { status: 404 },
  );

  const afterwards = await withTenant(ACME, (c) => getPost(c, acmePost));
  assert.equal(afterwards.content, before.content);
  assert.equal(afterwards.status, before.status);
});

test("Un SELECT sin WHERE solo devuelve filas del tenant fijado", async () => {
  const { rows } = await withTenant(GLOBEX, (c) => c.query("SELECT DISTINCT tenant_id FROM posts"));
  assert.deepEqual(
    rows.map((r) => r.tenant_id),
    [GLOBEX],
  );
});

test("Sin tenant fijado no se ve nada (falla cerrado)", async () => {
  const { rows } = await getPool().query("SELECT count(*)::int AS n FROM posts");
  assert.equal(rows[0].n, 0);
});

test("No se puede INSERTAR un post a nombre de otro tenant (WITH CHECK)", async () => {
  await assert.rejects(
    withTenant(GLOBEX, (c) =>
      c.query("INSERT INTO posts (tenant_id, profile_id, content, status) VALUES ($1, $2, 'x', 'draft')", [
        ACME,
        "a1111111-1111-4111-8111-111111111111",
      ]),
    ),
    /row-level security/,
  );
});

test("La app no puede leer los tokens cifrados (permiso por columnas)", async () => {
  await assert.rejects(
    withTenant(ACME, (c) => c.query("SELECT access_token_enc FROM oauth_tokens")),
    /permission denied/,
  );
});
