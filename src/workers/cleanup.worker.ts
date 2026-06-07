import { Queue, Worker, type Job } from "bullmq";
import { query, get, run } from "../db/index.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { redisConnection } from "../queues/redis.connection";
import { WOOAPI_QUEUE_NAMES } from "../queues/queues";

dotenv.config();

const dataDir = path.resolve(process.env.DATA_DIR || ".");
fs.mkdirSync(dataDir, { recursive: true });


const CLEANUP_DAYS = Number(process.env.CLEANUP_LOG_RETENTION_DAYS || 30);



type CleanupJob = {
  type?: string;
};

async function runCleanup(job: Job<CleanupJob>) {
  const cutoff = `datetime('now','-${CLEANUP_DAYS} days')`;
  const results: Record<string, number> = {};

  const tables = [
    "webhook_delivery_logs",
    "webhook_events",
    "message_logs",
    "api_request_logs",
    "connection_logs",
    "wooapi_events"
  ];

  for (const table of tables) {
    try {
      const info = await run(`DELETE FROM ${table} WHERE created_at < ${cutoff}`);
      results[table] = Number(info.changes);
    } catch (error) {
      console.error(`[WOOAPI_CLEANUP] Error cleaning ${table}:`, error);
      results[table] = -1;
    }
  }

  const oldAlerts = await run(`DELETE FROM support_alerts WHERE status IN ('resolved', 'acknowledged') AND resolved_at < ${cutoff}`);
  results.support_alerts = Number(oldAlerts.changes);

  console.log(`[WOOAPI_CLEANUP] Removed:`, results);
  return results;
}

const cleanupQueue = new Queue(WOOAPI_QUEUE_NAMES.cleanupLogs, {
  prefix: "wooapi",
  connection: redisConnection
});

const worker = new Worker<CleanupJob>(WOOAPI_QUEUE_NAMES.cleanupLogs, runCleanup, {
  connection: redisConnection,
  prefix: "wooapi",
  concurrency: 1
});

worker.on("completed", (job) => {
  console.log(`[WOOAPI_CLEANUP] completed job ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`[WOOAPI_CLEANUP] failed job ${job?.id}:`, error?.message || error);
});

async function scheduleDailyCleanup() {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(3, 0, 0, 0);
  if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);
  const delay = nextRun.getTime() - now.getTime();

  console.log(`[WOOAPI_CLEANUP] Next cleanup scheduled at ${nextRun.toISOString()}`);
  setTimeout(async () => {
    await cleanupQueue.add("daily-cleanup", { type: "daily" }, { removeOnComplete: true, removeOnFail: false });
    setInterval(() => {
      cleanupQueue.add("daily-cleanup", { type: "daily" }, { removeOnComplete: true, removeOnFail: false }).catch(() => null);
    }, 86400000);
  }, delay);
}

scheduleDailyCleanup().catch((error) => console.error("[WOOAPI_CLEANUP] Schedule error:", error));

async function shutdown() {
  await worker.close();
  await cleanupQueue.close();
  // db.close();
}

process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));

console.log(`[WOOAPI_CLEANUP] listening on ${WOOAPI_QUEUE_NAMES.cleanupLogs}`);
