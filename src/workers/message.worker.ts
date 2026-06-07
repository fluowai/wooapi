import { Worker, type Job } from "bullmq";
import { query, get, run } from "../db/index.js";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { redisConnection } from "../queues/redis.connection";
import { WOOAPI_QUEUE_NAMES, webhookDeliveryQueue, webhookDeliveryJobOptions } from "../queues/queues";
import { canSendMessage } from "../platform/traffic-controller.js";

dotenv.config();

const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:3001";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "dev-bridge-token";
const dataDir = path.resolve(process.env.DATA_DIR || ".");
fs.mkdirSync(dataDir, { recursive: true });


type MessageSendJob = {
  accountId: number;
  instanceId: number;
  jid: string;
  text?: string;
  type?: string;
  mediaUrl?: string;
  caption?: string;
  mimeType?: string;
  fileName?: string;
  conversationId?: number;
  messageDbId?: number;
  pendingMessageId?: string;
  campaignId?: number;
  campaignRecipientId?: number;
  priority?: number;
};





function sanitizePublicError(error: any) {
  const raw = String(error?.message || error || "");
  if (!raw) return "Operacao nao concluida";
  if (/token|secret|sqlite|database|stack|trace|bridge|internal|core|go\.mau|whatsmeow/i.test(raw)) {
    return "Operacao nao concluida pela WooAPI";
  }
  return raw.slice(0, 240);
}

function safeId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

async function logMessage(accountId: number, instanceId: number, messageId: string, direction: string, status: string, details: any = {}) {
  try {
    await run(
      "INSERT INTO message_logs (account_id, instance_id, message_id, direction, status, details_json) VALUES (?, ?, ?, ?, ?, ?)",
      [accountId, instanceId, messageId, direction, status, JSON.stringify(details)]
    );
  } catch {}
}

async function enqueueWebhookEvent(accountId: number, instanceId: number, event: string, payload: any) {
  try {
    const info = await run(
      "INSERT INTO webhook_events (account_id, instance_id, event, payload, status) VALUES (?, ?, ?, ?, ?)",
      [accountId, instanceId, event, JSON.stringify(payload), "pending"]
    );
    const eventId = Number(info.lastInsertRowid);
    const row = await get(`
      SELECT webhook_events.*, instances.webhook_url AS legacy_url, instances.webhook_secret AS legacy_secret
      FROM webhook_events LEFT JOIN instances ON instances.id = webhook_events.instance_id
      WHERE webhook_events.id = ?
    `, [eventId]);
    if (!row) return;
    const targets = await getMatchingWebhooks(instanceId, event);
    for (const target of targets) {
      const whInfo = await run(
        "INSERT INTO webhook_events (account_id, instance_id, webhook_id, url, event, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [accountId, instanceId, target.id, target.url, event, JSON.stringify(payload), "pending"]
      );
      const whEventId = Number(whInfo.lastInsertRowid);
      const maxAttempts = target.retry_enabled ? Math.max(1, Math.min(Number(target.max_attempts || 5), 20)) : 1;
      webhookDeliveryQueue.add("send-webhook", {
        accountId,
        tenantId: String(accountId),
        instanceId: String(instanceId),
        webhookId: target.id,
        webhookEventId: whEventId,
        event,
        url: target.url,
        secret: target.secret,
        payload
      }, { ...webhookDeliveryJobOptions, attempts: maxAttempts }).catch(() => null);
    }
    if (row.legacy_url) {
      const maxAttempts = 5;
      webhookDeliveryQueue.add("send-webhook", {
        accountId,
        tenantId: String(accountId),
        instanceId: String(instanceId),
        webhookId: null,
        webhookEventId: eventId,
        event,
        url: row.legacy_url,
        secret: row.legacy_secret || process.env.WEBHOOK_SECRET || "dev-webhook-secret-change-me",
        payload
      }, { ...webhookDeliveryJobOptions, attempts: maxAttempts }).catch(() => null);
    }
  } catch {}
}

async function getMatchingWebhooks(instanceId: number, event: string) {
  const rows = await query(
    "SELECT * FROM instance_webhooks WHERE instance_id = ? AND is_active = 1 ORDER BY id ASC",
    [instanceId]
  ) as any[];
  const results: any[] = [];
  for (const row of rows) {
    let events: string[] = [];
    try { events = JSON.parse(String(row.events || "[]")); } catch { events = []; }
    if (events.length === 0 || events.includes(event)) {
      results.push(row);
    }
  }
  return results;
}

async function bridgeFetch(pathname: string, options: RequestInit = {}) {
  const response = await fetch(`${BRIDGE_URL}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Token": BRIDGE_TOKEN,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!response.ok) throw new Error(data.error || text || `WooAPI Core error ${response.status}`);
  return data;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enforceTrafficControl(data: MessageSendJob) {
  const decision = await canSendMessage({
    accountId: Number(data.accountId),
    instanceId: Number(data.instanceId),
    phoneId: data.jid,
    jid: data.jid,
    messageType: data.mediaUrl ? (data.type || "media") : "text",
    campaignId: data.campaignId || null,
    priority: data.priority || (data.campaignId ? 3 : 2)
  });

  if (decision.decision === "ALLOW") return decision;
  if (decision.decision === "DELAY") {
    if (decision.delayMs <= Number(process.env.TRAFFIC_WORKER_INLINE_DELAY_MAX_MS || 8000)) {
      await sleep(decision.delayMs);
      return decision;
    }
    throw new Error(`traffic_delay:${decision.reason}:${decision.delayMs}`);
  }
  if (decision.decision === "PAUSE_INSTANCE") {
    await run(
      "UPDATE instances SET status = ?, connection_status = ?, operational_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ?",
      ["blocked", "blocked", "blocked", data.instanceId, data.accountId]
    ).catch(() => null);
  }
  throw new Error(`traffic_blocked:${decision.reason}`);
}

async function sendMessage(job: Job<MessageSendJob>) {
  const data = job.data;
  const started = Date.now();
  try {
    await enforceTrafficControl(data);
    if (data.campaignId) {
      const campaign = await get("SELECT status FROM campaigns WHERE id = ? AND account_id = ?", [data.campaignId, data.accountId]);
      if (!campaign || campaign.status === "cancelled") {
        if (data.campaignRecipientId) {
          await run("UPDATE campaign_recipients SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", ["cancelled", "campaign_cancelled", data.campaignRecipientId]);
        }
        return { sent: false, cancelled: true };
      }
      if (campaign.status === "paused") {
        throw new Error("campaign_paused");
      }
    }
    let result: any;
    if (data.mediaUrl) {
      result = await bridgeFetch(`/instances/${data.instanceId}/send-media`, {
        method: "POST",
        body: JSON.stringify({
          account_id: data.accountId,
          jid: data.jid,
          mediaUrl: data.mediaUrl,
          caption: data.caption || "",
          mimeType: data.mimeType || "",
          fileName: data.fileName || "",
          type: data.type || ""
        })
      });
    } else {
      result = await bridgeFetch(`/instances/${data.instanceId}/send`, {
        method: "POST",
        body: JSON.stringify({ account_id: data.accountId, jid: data.jid, text: data.text || "" })
      });
    }
    const providerMessageId = result?.ID || result?.id || result?.messageID || data.pendingMessageId || `sent_${Date.now()}`;
    const latencyMs = Date.now() - started;
    if (data.messageDbId) {
      await run("UPDATE messages SET message_id = ?, delivery_status = ? WHERE id = ?", [providerMessageId, "sent", data.messageDbId]);
    }
    if (data.campaignRecipientId) {
      await run(
        "UPDATE campaign_recipients SET status = ?, message_id = ?, error = NULL, sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        ["sent", providerMessageId, data.campaignRecipientId]
      );
    }
    if (data.campaignId) {
      await run(
        "UPDATE campaigns SET sent_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status IN ('sent','delivered','read')), failed_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status = 'failed'), status = CASE WHEN NOT EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND status IN ('pending','queued')) THEN 'completed' ELSE status END, completed_at = CASE WHEN NOT EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND status IN ('pending','queued')) THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE completed_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [data.campaignId, data.campaignId, data.campaignId, data.campaignId, data.campaignId]
      );
    }
    logMessage(data.accountId, data.instanceId, providerMessageId, "outbound", "sent", { latencyMs, jid: data.jid });
    enqueueWebhookEvent(data.accountId, data.instanceId, "message.sent", {
      message_id: providerMessageId,
      text: data.text,
      jid: data.jid,
      latencyMs
    });
    return { sent: true, providerMessageId, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = sanitizePublicError(error);
    if (data.messageDbId) {
      await run("UPDATE messages SET delivery_status = ? WHERE id = ?", ["failed", data.messageDbId]);
    }
    if (data.campaignRecipientId && message !== "campaign_paused") {
      await run(
        "UPDATE campaign_recipients SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        ["failed", message, data.campaignRecipientId]
      );
    }
    if (data.campaignId && message !== "campaign_paused") {
      await run(
        "UPDATE campaigns SET failed_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status = 'failed'), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [data.campaignId, data.campaignId]
      );
    }
    logMessage(data.accountId, data.instanceId, data.pendingMessageId || `failed_${Date.now()}`, "outbound", "failed", {
      error: message,
      latencyMs,
      jid: data.jid
    });
    enqueueWebhookEvent(data.accountId, data.instanceId, "message.failed", {
      error: message,
      text: data.text,
      jid: data.jid,
      latencyMs
    });
    throw error;
  }
}

const instanceSendChains = new Map<number, Promise<void>>();

async function sendMessagePerInstance(job: Job<MessageSendJob>) {
  const instanceId = Number(job.data.instanceId);
  const previous = instanceSendChains.get(instanceId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const chain = previous.then(() => current);
  instanceSendChains.set(instanceId, chain);
  await previous;
  try {
    return await sendMessage(job);
  } finally {
    release();
    if (instanceSendChains.get(instanceId) === chain) {
      instanceSendChains.delete(instanceId);
    }
  }
}

const worker = new Worker<MessageSendJob>(WOOAPI_QUEUE_NAMES.messageSend, sendMessagePerInstance, {
  connection: redisConnection,
  prefix: "wooapi",
  concurrency: Number(process.env.MESSAGE_WORKER_CONCURRENCY || 5)
});

worker.on("completed", (job) => {
  console.log(`[WOOAPI_MSG_WORKER] sent job ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`[WOOAPI_MSG_WORKER] failed job ${job?.id}:`, sanitizePublicError(error));
});

worker.on("error", (error) => {
  console.error("[WOOAPI_MSG_WORKER] Redis/worker error:", sanitizePublicError(error));
});

async function shutdown() {
  await worker.close();
  // db.close();
}

process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));

console.log(`[WOOAPI_MSG_WORKER] listening on ${WOOAPI_QUEUE_NAMES.messageSend}`);
