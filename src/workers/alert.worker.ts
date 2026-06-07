import { Worker, type Job } from "bullmq";
import { query, get, run } from "../db/index.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { redisConnection } from "../queues/redis.connection";
import { WOOAPI_QUEUE_NAMES } from "../queues/queues";

dotenv.config();

const dataDir = path.resolve(process.env.DATA_DIR || ".");
fs.mkdirSync(dataDir, { recursive: true });


type AlertJob = {
  accountId?: number;
  instanceId?: number;
  severity: string;
  type: string;
  title: string;
  description?: string;
  metadata?: any;
};



function sanitizePublicError(error: any) {
  const raw = String(error?.message || error || "");
  if (!raw) return "Operacao nao concluida";
  if (/token|secret|sqlite|database|stack|trace|bridge|internal|core|go\.mau|whatsmeow/i.test(raw)) {
    return "Operacao nao concluida pela WooAPI";
  }
  return raw.slice(0, 240);
}

async function processAlert(job: Job<AlertJob>) {
  const data = job.data;
  try {
    const existing = await get(
      "SELECT id FROM support_alerts WHERE type = ? AND instance_id IS NOT DISTINCT FROM ? AND account_id IS NOT DISTINCT FROM ? AND status = 'open'",
      [data.type, data.instanceId || null, data.accountId || null]
    ) as any;

    if (existing) {
      return { skipped: true, reason: "Alerta ja existe em aberto" };
    }

    await run(
      "INSERT INTO support_alerts (account_id, instance_id, severity, type, title, description, metadata, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')",
      [
        data.accountId || null,
        data.instanceId || null,
        data.severity || "warning",
        data.type,
        data.title,
        data.description || null,
        JSON.stringify(data.metadata || {})
      ]
    );

    return { created: true, type: data.type };
  } catch (error) {
    console.error(`[WOOAPI_ALERT_WORKER] Error processing alert ${job.id}:`, sanitizePublicError(error));
    throw error;
  }
}

const worker = new Worker<AlertJob>(WOOAPI_QUEUE_NAMES.supportAlerts, processAlert, {
  connection: redisConnection,
  prefix: "wooapi",
  concurrency: 5
});

worker.on("completed", (job) => {
  console.log(`[WOOAPI_ALERT_WORKER] processed alert job ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`[WOOAPI_ALERT_WORKER] failed alert job ${job?.id}:`, sanitizePublicError(error));
});

worker.on("error", (error) => {
  console.error("[WOOAPI_ALERT_WORKER] Redis/worker error:", sanitizePublicError(error));
});

async function shutdown() {
  await worker.close();
  // db.close();
}

process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));

console.log(`[WOOAPI_ALERT_WORKER] listening on ${WOOAPI_QUEUE_NAMES.supportAlerts}`);
