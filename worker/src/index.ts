import http from "node:http";
import pg from "pg";
import { config } from "./config.js";
import { log } from "./log.js";
import { claimBatch, reapStuck } from "./queue.js";
import { processPost } from "./processor.js";

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.globalMaxInFlight + 2 });
const inFlight = new Set<Promise<void>>();
let stopping = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tick() {
  const reaped = await reapStuck(pool, config.lockTimeoutSec);
  if (reaped > 0) log("reaper_requeued", { count: reaped });

  const posts = await claimBatch(pool, config.workerId, config.globalMaxInFlight);
  for (const post of posts) {
    const job: Promise<void> = processPost(pool, post, config.workerId)
      .catch((err) => {
        // El post se queda en "publishing" y el reaper lo recupera
        log("process_error", { post_id: post.id, profile_id: post.profile_id, error: String(err) });
      })
      .finally(() => {
        inFlight.delete(job);
      });
    inFlight.add(job);
  }
}

async function main() {
  log("worker_started", { worker_id: config.workerId, global_max_in_flight: config.globalMaxInFlight });

  // Health check para el host (y para saber que el proceso está vivo)
  if (config.healthPort) {
    http
      .createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, worker_id: config.workerId, in_flight: inFlight.size }));
      })
      .listen(config.healthPort);
  }

  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      log("tick_error", { error: String(err) });
    }
    await sleep(config.pollMs);
  }
}

// Apagado limpio: deja de coger trabajo y espera a lo que está en vuelo
async function shutdown(signal: string) {
  log("worker_stopping", { signal, in_flight: inFlight.size });
  stopping = true;
  await Promise.allSettled([...inFlight]);
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main();
