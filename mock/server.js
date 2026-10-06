import express from "express";
import crypto from "node:crypto";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 4000);
const RATE_429 = Number(process.env.MOCK_429_RATE ?? 0.1);
const RATE_5XX = Number(process.env.MOCK_5XX_RATE ?? 0.1);
const MAX_LATENCY_MS = Number(process.env.MOCK_MAX_LATENCY_MS ?? 3000);
const USER_LIMIT = Number(process.env.MOCK_USER_LIMIT ?? 3);
const APP_LIMIT = Number(process.env.MOCK_APP_LIMIT ?? 20);
const WINDOW_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const published = new Map(); // Idempotency-Key -> external_id
const hits = new Map(); // clave de límite -> timestamps

// Devuelve los segundos a esperar si se pasa del límite, o 0
function overLimit(key, limit) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return Math.max(1, Math.ceil((WINDOW_MS - (now - recent[0])) / 1000));
  }
  recent.push(now);
  hits.set(key, recent);
  return 0;
}

function tooMany(res, seconds) {
  res.set("Retry-After", String(seconds));
  return res.status(429).json({ error: "rate_limited" });
}

app.post("/provider/publish", async (req, res) => {
  await sleep(Math.random() * MAX_LATENCY_MS);

  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "missing_token" });
  const token = auth.slice(7);

  if (token.startsWith("tok_rev")) return res.status(401).json({ error: "token_revoked" });
  if (token.startsWith("tok_exp")) return res.status(401).json({ error: "token_expired" });
  if (!token.startsWith("tok_ok")) return res.status(401).json({ error: "invalid_token" });

  if (typeof req.body?.content !== "string" || req.body.content.trim() === "") {
    return res.status(400).json({ error: "invalid_content" });
  }

  // Idempotencia del proveedor: reintentar con la misma clave no duplica
  const key = req.headers["idempotency-key"];
  if (key && published.has(key)) {
    return res.json({ id: published.get(key), replay: true });
  }

  // Límites duros: por usuario y por app
  const wait = overLimit(`user:${token}`, USER_LIMIT) || overLimit("app", APP_LIMIT);
  if (wait) return tooMany(res, wait);

  // Fallos aleatorios
  const r = Math.random();
  if (r < RATE_429) return tooMany(res, 1 + Math.floor(Math.random() * 5));
  if (r < RATE_429 + RATE_5XX) return res.status(503).json({ error: "unavailable" });

  const id = `ext_${crypto.randomUUID()}`;
  if (key) published.set(key, id);
  res.json({ id });
});

app.post("/provider/oauth/refresh", async (req, res) => {
  await sleep(Math.random() * 500);
  const rt = req.body?.refresh_token;
  if (typeof rt !== "string" || !rt.startsWith("ref_ok")) {
    return res.status(400).json({ error: "invalid_grant" });
  }
  res.json({
    access_token: `tok_ok_${crypto.randomBytes(6).toString("hex")}`,
    refresh_token: rt,
    expires_in: 3600,
  });
});

// Solo para tests: cuántas publicaciones reales ha recibido
app.get("/provider/_published", (req, res) => {
  res.json({ count: published.size, keys: [...published.keys()] });
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(JSON.stringify({ msg: "mock up", port: PORT })));
