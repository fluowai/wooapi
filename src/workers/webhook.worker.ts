import { Worker, type Job } from "bullmq";
import { query, get, run } from "../db/index.js";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { redisConnection } from "../queues/redis.connection";
import { WOOAPI_QUEUE_NAMES } from "../queues/queues";

dotenv.config();

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "dev-webhook-secret-change-me";
const dataDir = path.resolve(process.env.DATA_DIR || ".");
fs.mkdirSync(dataDir, { recursive: true });


type WebhookDeliveryJob = {
  accountId?: number;
  tenantId: string | number;
  instanceId: string | number;
  webhookId?: string | number | null;
  webhookEventId: string | number;
  event: string;
  url: string;
  secret?: string;
  payload: any;
};





function sanitizePublicError(error: any) {
  const raw = String(error?.message || error || "");
  if (!raw) return "Operacao nao concluida";
  if (/token|secret|sqlite|database|stack|trace|bridge|internal|core|go\.mau|whatsmeow/i.test(raw)) {
    return "Operacao nao concluida pela WooAPI";
  }
  return raw.slice(0, 240);
}

function jsonBody(payload: any) {
  return typeof payload === "string" ? payload : JSON.stringify(payload || {});
}

const redactedKeys = new Set([
  "authorization",
  "token",
  "api_key",
  "apikey",
  "secret",
  "password",
  "phone",
  "contact_phone",
  "jid",
  "remote_jid",
  "group_jid",
  "author_phone",
  "author_push_name",
  "profile_name",
  "profile_picture_url",
  "content_text",
  "message",
  "text",
  "raw",
  "raw_json",
  "media",
  "media_url",
  "url",
  "thumbnail",
  "jpegthumbnail"
]);

function redactForLog(value: any): any {
  if (Array.isArray(value)) return value.map((item) => redactForLog(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactedKeys.has(key.toLowerCase()) ? "[redacted]" : redactForLog(item)
      ])
    );
  }
  if (typeof value === "string" && value.length > 160) return `${value.slice(0, 80)}...[redacted]`;
  return value;
}

function logBody(payload: any) {
  try {
    return JSON.stringify(redactForLog(typeof payload === "string" ? JSON.parse(payload) : payload || {}));
  } catch {
    return "[redacted]";
  }
}

function numericPublicId(value: string | number | null | undefined) {
  const normalized = String(value || "").replace(/^(tenant|inst)_/, "");
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function nextRetryAt(attempt: number) {
  return new Date(Date.now() + Math.min(300000, attempt * 30000)).toISOString();
}

async function logAttempt(input: {
  data: WebhookDeliveryJob;
  body: string;
  attempt: number;
  statusCode?: number | null;
  success: boolean;
  responseBody?: string | null;
  error?: string | null;
  durationMs: number;
}) {
  await run(
    `INSERT INTO webhook_delivery_logs
      (account_id, tenant_id, instance_id, webhook_id, webhook_event_id, event, url, status_code, success, attempt, request_payload, response_body, error, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.data.accountId || numericPublicId(input.data.tenantId),
      String(input.data.tenantId),
      numericPublicId(input.data.instanceId),
      input.data.webhookId ? Number(input.data.webhookId) : null,
      Number(input.data.webhookEventId),
      input.data.event,
      input.data.url,
      input.statusCode || null,
      input.success ? 1 : 0,
      input.attempt,
      logBody(input.body),
      input.responseBody ? input.responseBody.slice(0, 4000) : null,
      input.error || null,
      input.durationMs
    ]
  );
}

async function updateWebhookEvent(input: {
  id: string | number;
  status: "delivered" | "retrying" | "failed";
  attempts: number;
  statusCode?: number | null;
  error?: string | null;
  nextRetry?: string | null;
}) {
  await run(
    `UPDATE webhook_events
     SET status = ?,
         response_status = ?,
         error = ?,
         attempts = ?,
         retry_count = ?,
         last_attempt_at = CURRENT_TIMESTAMP,
         next_retry_at = ?,
         delivered_at = CASE WHEN ? = 'delivered' THEN CURRENT_TIMESTAMP ELSE delivered_at END
     WHERE id = ?`,
    [
      input.status,
      input.statusCode || null,
      input.error || null,
      input.attempts,
      input.attempts,
      input.nextRetry || null,
      input.status,
      input.id
    ]
  );
}

async function deliverWebhook(job: Job<WebhookDeliveryJob>) {
  const data = job.data;
  const attempt = Number(job.attemptsMade || 0) + 1;
  const maxAttempts = Number(job.opts.attempts || 5);
  const body = jsonBody(data.payload);
  const started = Date.now();
  const deliveryId = `delivery_${data.webhookEventId || job.id}`;
  let attemptLogged = false;
  const signature = crypto
    .createHmac("sha256", data.secret || WEBHOOK_SECRET)
    .update(body)
    .digest("hex");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.WEBHOOK_DELIVERY_TIMEOUT_MS || 10000));
    const response = await fetch(data.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Wooapi-Event": data.event,
        "X-Wooapi-Instance": String(data.instanceId),
        "X-Wooapi-Delivery": deliveryId,
        "X-Wooapi-Timestamp": new Date().toISOString(),
        "X-Wooapi-Signature": `sha256=${signature}`
      },
      body,
      signal: controller.signal
    });
    clearTimeout(timeout);

    const responseBody = await response.text().catch(() => "");
    const durationMs = Date.now() - started;
    logAttempt({
      data,
      body,
      attempt,
      statusCode: response.status,
      success: response.ok,
      responseBody,
      error: response.ok ? null : `HTTP ${response.status}`,
      durationMs
    });
    attemptLogged = true;

    if (!response.ok) {
      updateWebhookEvent({
        id: data.webhookEventId,
        status: attempt >= maxAttempts ? "failed" : "retrying",
        attempts: attempt,
        statusCode: response.status,
        error: `HTTP ${response.status}`,
        nextRetry: attempt >= maxAttempts ? null : nextRetryAt(attempt)
      });
      throw new Error(`HTTP ${response.status}`);
    }

    updateWebhookEvent({
      id: data.webhookEventId,
      status: "delivered",
      attempts: attempt,
      statusCode: response.status,
      error: null,
      nextRetry: null
    });

    return { delivered: true, statusCode: response.status, durationMs };
  } catch (error) {
    if (attemptLogged) throw error;
    const durationMs = Date.now() - started;
    const message = sanitizePublicError(error);
    logAttempt({
      data,
      body,
      attempt,
      statusCode: null,
      success: false,
      responseBody: null,
      error: message,
      durationMs
    });
    updateWebhookEvent({
      id: data.webhookEventId,
      status: attempt >= maxAttempts ? "failed" : "retrying",
      attempts: attempt,
      statusCode: null,
      error: message,
      nextRetry: attempt >= maxAttempts ? null : nextRetryAt(attempt)
    });
    throw error;
  }
}

const worker = new Worker<WebhookDeliveryJob>(WOOAPI_QUEUE_NAMES.webhookDelivery, deliverWebhook, {
  connection: redisConnection,
  prefix: "wooapi",
  concurrency: Number(process.env.WEBHOOK_WORKER_CONCURRENCY || 10)
});

worker.on("completed", (job) => {
  console.log(`[WOOAPI_WEBHOOK_WORKER] delivered job ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`[WOOAPI_WEBHOOK_WORKER] failed job ${job?.id}:`, sanitizePublicError(error));
});

worker.on("error", (error) => {
  console.error("[WOOAPI_WEBHOOK_WORKER] Redis/worker error:", sanitizePublicError(error));
});

async function shutdown() {
  await worker.close();
  // db.close();
}

process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));

console.log(`[WOOAPI_WEBHOOK_WORKER] listening on ${WOOAPI_QUEUE_NAMES.webhookDelivery}`);
