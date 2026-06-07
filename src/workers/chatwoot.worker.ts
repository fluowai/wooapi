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


const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:3001";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "dev-bridge-token";

type ChatwootConfig = {
  apiUrl: string;
  apiToken: string;
  accountId: number;
  inboxId: number;
};

type ChatwootSyncJob = {
  instanceId: number;
  accountId: number;
  contactPhone: string;
  contactName?: string;
  messageText?: string;
  messageId?: string;
};





function sanitizePublicError(error: any) {
  const raw = String(error?.message || error || "");
  if (!raw) return "Operacao nao concluida";
  if (/token|secret|sqlite|database|stack|trace|bridge|internal|core|go\.mau|whatsmeow/i.test(raw)) {
    return "Operacao nao concluida pela WooAPI";
  }
  return raw.slice(0, 240);
}

async function bridgeFetch(path: string, options: RequestInit = {}) {
  const url = `${BRIDGE_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Bridge ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json().catch(() => ({}));
}

async function getChatwootConfig(instanceId: number): Promise<ChatwootConfig | null> {
  const row = await get(
    "SELECT * FROM integration_settings WHERE instance_id = ? AND provider = ? AND enabled = 1",
    [instanceId, "chatwoot"]
  ) as any;
  if (!row) return null;
  try {
    const config = JSON.parse(row.config_json || "{}");
    const apiUrl = String(config.apiUrl || "https://app.chatwoot.com").replace(/\/$/, "");
    const apiToken = String(config.apiToken || "");
    const accountId = Number(config.accountId || 0);
    const inboxId = Number(config.inboxId || 0);
    if (!apiToken || !accountId || !inboxId) return null;
    return { apiUrl, apiToken, accountId, inboxId };
  } catch {
    return null;
  }
}

async function chatwootApiFetch(config: ChatwootConfig, method: string, path: string, body?: any) {
  const url = `${config.apiUrl}/api/v1/accounts/${config.accountId}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    api_access_token: config.apiToken
  };
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Chatwoot ${response.status}: ${data?.error || data?.message || JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

async function findOrCreateContact(config: ChatwootConfig, phone: string, name?: string) {
  const search = await chatwootApiFetch(config, "GET", `/contacts/search?q=${encodeURIComponent(phone)}`);
  const contacts = search?.payload || search?.data || [];
  const existing = Array.isArray(contacts)
    ? contacts.find((c: any) => {
        const p = c.phone_number || c.phone || "";
        return p.replace(/\D/g, "") === phone.replace(/\D/g, "");
      })
    : null;
  if (existing) return existing;

  const created = await chatwootApiFetch(config, "POST", "/contacts", {
    inbox_id: config.inboxId,
    name: name || phone,
    phone_number: phone
  });
  return created?.payload?.contact || created?.contact || created;
}

async function findOrCreateConversation(config: ChatwootConfig, contactId: number) {
  const conversations = await chatwootApiFetch(config, "GET", `/contacts/${contactId}/conversations`);
  const existing = Array.isArray(conversations?.payload)
    ? conversations.payload.find((c: any) => c.inbox_id === config.inboxId)
    : null;
  if (existing) return existing;

  const created = await chatwootApiFetch(config, "POST", "/conversations", {
    source_id: null,
    contact_id: contactId,
    inbox_id: config.inboxId
  });
  return created;
}

async function createChatwootMessage(config: ChatwootConfig, conversationId: number, content: string) {
  return chatwootApiFetch(config, "POST", `/conversations/${conversationId}/messages`, {
    content,
    message_type: "incoming"
  });
}

async function sendWhatsAppReply(instanceId: number, jid: string, text: string) {
  return bridgeFetch(`/instances/${instanceId}/send`, {
    method: "POST",
    body: JSON.stringify({ jid, text })
  });
}

async function processChatwootSync(job: Job<ChatwootSyncJob>) {
  const { instanceId, accountId, contactPhone, contactName, messageText } = job.data;
  if (!contactPhone) throw new Error("contactPhone is required");

  const config = await getChatwootConfig(instanceId);
  if (!config) {
    return { skipped: true, reason: "Chatwoot integration not configured or disabled" };
  }

  const phone = contactPhone.includes("@") ? contactPhone.split("@")[0] : contactPhone;

  const contact = await findOrCreateContact(config, phone, contactName || phone);
  const contactId = contact.id;
  if (!contactId) throw new Error("Failed to create/find Chatwoot contact");

  const conversation = await findOrCreateConversation(config, contactId);
  const conversationId = conversation.id;
  if (!conversationId) throw new Error("Failed to create/find Chatwoot conversation");

  if (messageText) {
    await createChatwootMessage(config, conversationId, messageText);
  }

  await run(
    "INSERT INTO integration_sessions (account_id, instance_id, provider, contact_key, session_id, result_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(instance_id, provider, contact_key) DO UPDATE SET session_id = excluded.session_id, result_id = excluded.result_id, updated_at = CURRENT_TIMESTAMP",
    [accountId, instanceId, "chatwoot", contactPhone, String(conversationId), String(contactId)]
  );

  return {
    synced: true,
    contactId,
    conversationId
  };
}

const worker = new Worker<ChatwootSyncJob>(WOOAPI_QUEUE_NAMES.chatwootSync, processChatwootSync, {
  connection: redisConnection,
  prefix: "wooapi",
  concurrency: 3
});

worker.on("completed", (job) => {
  console.log(`[WOOAPI_CHATWOOT_WORKER] synced job ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`[WOOAPI_CHATWOOT_WORKER] failed job ${job?.id}:`, sanitizePublicError(error));
});

worker.on("error", (error) => {
  console.error("[WOOAPI_CHATWOOT_WORKER] Redis/worker error:", sanitizePublicError(error));
});

async function shutdown() {
  await worker.close();
  // db.close();
}

process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));

console.log(`[WOOAPI_CHATWOOT_WORKER] listening on ${WOOAPI_QUEUE_NAMES.chatwootSync}`);
