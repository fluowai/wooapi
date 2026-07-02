import express from "express";
import { createServer as createViteServer } from "vite";
import { query, get, run, exec, isPostgres, isSqlite, runMigrations } from "./src/db/index.js";
import {
  enforceBilling, createCheckoutSession, createBillingPortalSession,
  handleStripeWebhook, isStripeConfigured, syncPlansToStripe,
  checkExpiredTrials, recordUsage
} from "./src/billing.js";
import {
  globalRateLimit, loginRateLimit, apiKeyRateLimit,
  accountRateLimit, criticalEndpointRateLimit, perInstanceRateLimit,
  check
} from "./src/rate-limit.js";
import cors from "cors";
import bodyParser from "body-parser";
import { Server } from "socket.io";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { createServer } from "http";
import net from "net";
import crypto from "crypto";
import multer from "multer";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import nodemailer from "nodemailer";
import {
  chatwootSyncQueue,
  cleanupLogsQueue,
  deadLetterQueue,
  instanceLifecycleQueue,
  instanceMigrationQueue,
  instanceMonitorQueue,
  messageSendQueue,
  messageRetryQueue,
  messageScheduledQueue,
  reputationUpdateQueue,
  supportAlertsQueue,
  webhookDeliveryJobOptions,
  webhookDeliveryQueue,
  WOOAPI_QUEUE_DISPLAY_NAMES,
  WOOAPI_QUEUE_NAMES
} from "./src/queues/queues";
import { createWooApiEvent } from "./src/wooapi/events";
import { assignInstance, registerCoreNode, setCoreNodeDrainMode, transitionInstance } from "./src/platform/orchestrator.js";
import { listReputation } from "./src/platform/reputation.js";
import { canSendMessage } from "./src/platform/traffic-controller.js";
import { getInstanceStateMachine } from "./src/platform/state-machine.js";

dotenv.config();

const require = createRequire(import.meta.url);
const QRCode = require("qrcode");
const dataDir = path.resolve(process.env.DATA_DIR || ".");
fs.mkdirSync(dataDir, { recursive: true });

const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:3001";
const WOZAPI_V2_BRIDGE_URL = process.env.WOZAPI_V2_BRIDGE_URL || process.env.WOZAPI_V2_INTERNAL_BRIDGE_URL || "http://127.0.0.1:3003";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "dev-bridge-token";
const EXPERIMENTAL_INTERACTIVE_MESSAGES = process.env.EXPERIMENTAL_INTERACTIVE_MESSAGES === "true";
const JWT_SECRET = process.env.JWT_SECRET || "dev-jwt-secret-change-me";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "dev-webhook-secret-change-me";
const WOOAPI_ADMIN_TOKEN = process.env.WOOAPI_ADMIN_TOKEN || process.env.UAZAPI_ADMIN_TOKEN || "";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const SESSION_TOKEN_TTL_HOURS = Number(process.env.SESSION_TOKEN_TTL_HOURS || 12);
const MAX_UPLOAD_SIZE_MB = Number(process.env.MAX_UPLOAD_SIZE_MB || 25);
const DATABASE_URL = process.env.DATABASE_URL || "";
const DEFAULT_WEBHOOK_URL = process.env.DEFAULT_WEBHOOK_URL || "";
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || "noreply@wozapi.com.br";
const SUPPORT_INSTANCE_ID = process.env.SUPPORT_INSTANCE_ID || "";
const SUPPORT_INSTANCE_JID = process.env.SUPPORT_INSTANCE_JID || "";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const QUEUE_DRIVER = process.env.QUEUE_DRIVER || (process.env.NODE_ENV === "production" ? "bullmq" : "database");
const REQUIRE_PRODUCTION_READY = process.env.REQUIRE_PRODUCTION_READY === "true";
const QR_EXPIRES_MINUTES = Number(process.env.QR_EXPIRES_MINUTES || 10);
const ORPHAN_SESSION_GRACE_MINUTES = Number(process.env.ORPHAN_SESSION_GRACE_MINUTES || 30);
const TRIAL_TEST_HOURS = Number(process.env.TRIAL_TEST_HOURS || 1);
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(dataDir, "backups"));
const ALLOW_RESTORE = process.env.ALLOW_RESTORE === "true";

const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(dataDir, "uploads"));
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

function publicMediaUrl(url?: string | null) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value) || value.startsWith("data:")) return value;
  if (value.startsWith("/")) return `${APP_URL.replace(/\/+$/, "")}${value}`;
  return value;
}

function productionReadiness() {
  const weakValues = new Set(["", "dev-jwt-secret-change-me", "dev-webhook-secret-change-me", "dev-bridge-token"]);
  const checks = [
    { key: "database", ok: Boolean(DATABASE_URL), message: "DATABASE_URL/PostgreSQL is required for production." },
    { key: "redis", ok: QUEUE_DRIVER === "bullmq" && Boolean(process.env.REDIS_URL || process.env.REDIS_HOST), message: "BullMQ/Redis must be configured for production." },
    { key: "jwt_secret", ok: !weakValues.has(JWT_SECRET) && JWT_SECRET.length >= 32, message: "JWT_SECRET must be strong and unique." },
    { key: "webhook_secret", ok: !weakValues.has(WEBHOOK_SECRET) && WEBHOOK_SECRET.length >= 32, message: "WEBHOOK_SECRET must be strong and unique." },
    { key: "bridge_token", ok: !weakValues.has(BRIDGE_TOKEN) && BRIDGE_TOKEN.length >= 32, message: "BRIDGE_TOKEN must be strong and unique." },
    { key: "admin_token", ok: Boolean(WOOAPI_ADMIN_TOKEN) && WOOAPI_ADMIN_TOKEN.length >= 24, message: "WOOAPI_ADMIN_TOKEN must be configured." },
    { key: "app_url", ok: /^https:\/\//.test(APP_URL) || APP_URL.includes("localhost") || APP_URL.includes("127.0.0.1"), message: "APP_URL should be HTTPS in production." },
    { key: "backup_dir", ok: fs.existsSync(BACKUP_DIR), message: "BACKUP_DIR must be writable." },
    { key: "stripe", ok: Boolean(STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET), message: "Stripe keys are required for automated billing." }
  ];
  const failed = checks.filter((check) => !check.ok);
  return { ready: failed.length === 0, checks, failed };
}

function assertProductionReady() {
  if (!REQUIRE_PRODUCTION_READY) return;
  const readiness = productionReadiness();
  if (!readiness.ready) {
    throw new Error(`Production readiness failed: ${readiness.failed.map((item) => item.key).join(", ")}`);
  }
}

function parseAllowedOrigins(raw: string) {
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsOptions(): any {
  const allowedOrigins = parseAllowedOrigins(CORS_ORIGIN);
  if (allowedOrigins.includes("*")) {
    return {
      origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
        if (!origin || APP_URL.startsWith("https://") || process.env.NODE_ENV !== "production") {
          return callback(null, true);
        }
        try {
          const parsed = new URL(origin);
          if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
            return callback(null, true);
          }
        } catch {}
        return callback(new Error("Origin not allowed by CORS"));
      },
      credentials: true
    };
  }
  return {
    origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true
  };
}

function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:*",
      "media-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:*",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' http: https: ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'"
    ].join("; ")
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (APP_URL.startsWith("https://")) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
}

const allowedUploadMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);

const allowedUploadExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".mp4",
  ".mp3",
  ".ogg",
  ".wav",
  ".pdf",
  ".txt",
  ".csv",
  ".json",
  ".docx",
  ".xlsx"
]);

function safeUploadExtension(originalName = "") {
  const ext = path.extname(originalName).toLowerCase();
  return allowedUploadExtensions.has(ext) ? ext : "";
}

function sanitizeFilename(name: string): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  return `${base}${ext}`;
}

type AccountRequest = express.Request & { accountId?: number; user?: any; account?: any };

let realtimeIo: Server | null = null;

function emitRealtimeLog(log: any) {
  if (!realtimeIo) return;
  const payload = { ...log, emitted_at: new Date().toISOString() };
  if (payload.account_id) realtimeIo.to(`account:${payload.account_id}`).emit("instance.log", payload);
  if (payload.instance_id) realtimeIo.to(`instance:${payload.instance_id}`).emit("instance.log", payload);
  realtimeIo.to("admin:monitor").emit("global.log", payload);
}



async function audit(accountId: number | null, userId: number | null, action: string, details: any = {}) {
  try {
    await run(
      "INSERT INTO audit_logs (account_id, user_id, action, details_json) VALUES (?, ?, ?, ?)",
      [accountId, userId, action, JSON.stringify(details)]
    );
  } catch {
    // Audit should never block core API flows.
  }
}

async function logConnection(accountId: number | null, instanceId: number | null, event: string, status: string, details: any = {}) {
  try {
    const info = await run(
      "INSERT INTO connection_logs (account_id, instance_id, event, status, details_json) VALUES (?, ?, ?, ?, ?)",
      [accountId, instanceId, event, status, JSON.stringify(details)]
    );
    emitRealtimeLog({
      source: "connection",
      id: info.lastInsertRowid,
      account_id: accountId,
      instance_id: instanceId,
      event,
      status,
      details,
      created_at: new Date().toISOString()
    });
  } catch {
    // Operational logs should not block messaging flows.
  }
}

async function logMessage(accountId: number | null, instanceId: number | null, messageId: string | null, direction: string, status: string, details: any = {}) {
  try {
    const info = await run(
      "INSERT INTO message_logs (account_id, instance_id, message_id, direction, status, details_json) VALUES (?, ?, ?, ?, ?, ?)",
      [accountId, instanceId, messageId, direction, status, JSON.stringify(details)]
    );
    emitRealtimeLog({
      source: "message",
      id: info.lastInsertRowid,
      account_id: accountId,
      instance_id: instanceId,
      message_id: messageId,
      direction,
      status,
      details,
      created_at: new Date().toISOString()
    });
  } catch {
    // Operational logs should not block messaging flows.
  }
}

function randomToken(prefix: string) {
  return `${prefix}_${crypto.randomBytes(24).toString("base64url")}`;
}

function tcpReachable(host: string, port: number, timeoutMs = 800) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function instanceWebhookEndpoints(instanceId: number | string) {
  const id = encodeURIComponent(String(instanceId));
  const base = effectiveAppUrl().replace(/\/+$/, "");
  return {
    webhooks_url: `${base}/api/v1/instances/${id}/webhooks`,
    legacy_webhook_url: `${base}/api/v1/instances/${id}/webhook`,
    webhook_events_url: `${base}/api/v1/instances/${id}/webhook-events`,
    webhook_logs_url: `${base}/api/v1/instances/${id}/webhook-logs`,
    webhook_test_url: `${base}/api/v1/instances/${id}/webhook/test`
  };
}

function effectiveAppUrl() {
  try {
    const parsed = new URL(APP_URL);
    if ((parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") && parsed.port !== String(PORT)) {
      parsed.port = String(PORT);
      return parsed.toString().replace(/\/+$/, "");
    }
  } catch {
    return `http://localhost:${PORT}`;
  }
  return APP_URL;
}

function instanceWebhookPackage(inst: any, options: { includeSecret?: boolean } = {}) {
  const endpoints = instanceWebhookEndpoints(inst?.id || inst);
  return {
    ...endpoints,
    configured_url: inst?.webhook_url || null,
    enabled: Number(inst?.webhook_enabled ?? 1) === 1,
    events: parseJsonList(inst?.webhook_events),
    signing_header: "X-WooAPI-Signature",
    signature_format: "sha256=<hmac_sha256_raw_body_hex>",
    ...(options.includeSecret ? { secret: inst?.webhook_secret || null } : {})
  };
}

async function createDefaultWebhook(accountId: number, instanceId: number, requestedUrl?: string) {
  const url = String(requestedUrl || DEFAULT_WEBHOOK_URL || "").trim();
  if (!url || !isWebhookUrl(url)) return null;
  const existing = await get("SELECT id FROM instance_webhooks WHERE account_id = ? AND instance_id = ?", [accountId, instanceId]);
  if (existing) return existing;
  const secret = randomToken("whsec");
  const info = await run(
    "INSERT INTO instance_webhooks (account_id, instance_id, name, url, secret, events, is_active, retry_enabled, max_attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [accountId, instanceId, "Webhook padrao", url, secret, JSON.stringify([]), 1, 1, 5]
  );
  return await get("SELECT * FROM instance_webhooks WHERE id = ?", [info.lastInsertRowid]);
}

function normalizeInstanceEngine(engine?: any) {
  const value = String(engine || "").trim().toLowerCase();
  if (["wozapi-2", "wozapi2", "v2", "2", "2.0"].includes(value)) return "wozapi-2";
  return "wozapi-1";
}

function isWozapiV2Engine(engine?: any) {
  return normalizeInstanceEngine(engine) === "wozapi-2";
}

async function bridgeURLForPath(pathname: string) {
  const match = String(pathname || "").match(/^\/instances\/(\d+)(?:\/|$)/);
  if (!match) return BRIDGE_URL;
  const inst = await get("SELECT engine FROM instances WHERE id = ?", [Number(match[1])]).catch(() => null);
  return isWozapiV2Engine(inst?.engine) ? WOZAPI_V2_BRIDGE_URL : BRIDGE_URL;
}

async function createInstanceWithCredentials(accountId: number, name: string, webhookUrl?: string, engine?: string) {
  const apiKey = randomToken("woo");
  const webhookSecret = randomToken("whsec");
  const normalizedEngine = normalizeInstanceEngine(engine);
  const info = await run(
    "INSERT INTO instances (account_id, name, status, connection_status, engine, api_key, webhook_secret) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [accountId, name, "created", "created", normalizedEngine, apiKey, webhookSecret]
  );
  const instanceId = Number(info.lastInsertRowid);
  const defaultWebhook = await createDefaultWebhook(accountId, instanceId, webhookUrl);
  const inst = await get("SELECT * FROM instances WHERE id = ?", [instanceId]);
  return {
    inst,
    id: instanceId,
    apiKey,
    webhookSecret,
    defaultWebhook
  };
}

const PBKDF2_ITERATIONS = 600000;
const PBKDF2_LEGACY_ITERATIONS = 120000;

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256").toString("hex");
  return `pbkdf2$${salt}$${PBKDF2_ITERATIONS}$${hash}`;
}

function verifyPassword(password: string, stored: string) {
  if (!stored) return false;
  if (!stored.startsWith("pbkdf2$")) return false;
  const parts = stored.split("$");
  const salt = parts[1];
  const expected = parts[parts.length - 1];
  let iterations = PBKDF2_ITERATIONS;
  if (parts.length === 4) {
    iterations = Number(parts[2]) || PBKDF2_ITERATIONS;
  }
  const actual = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
  if (!crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) return false;
  if (iterations < PBKDF2_ITERATIONS) {
    return "needs_rehash";
  }
  return true;
}

const JWT_ISSUER = "wooapi";
const JWT_AUDIENCE = "wooapi-users";

function signToken(payload: any) {
  const now = Date.now();
  const exp = payload.exp || new Date(now + SESSION_TOKEN_TTL_HOURS * 60 * 60 * 1000).toISOString();
  const iat = new Date(now).toISOString();
  const body = Buffer.from(JSON.stringify({
    ...payload,
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    iat,
    exp
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token?: string) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(body).digest("base64url");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.exp && new Date(payload.exp).getTime() < Date.now()) return null;
  if (payload.iss && payload.iss !== JWT_ISSUER) return null;
  if (payload.aud && payload.aud !== JWT_AUDIENCE) return null;
  if (payload.iat && new Date(payload.iat).getTime() > Date.now()) return null;
  return payload;
}

function normalizePhone(input = "") {
  return String(input).split("@")[0].split(":")[0].replace(/\D/g, "");
}

function normalizeWhatsAppPhone(input = "") {
  let phone = normalizePhone(input);
  if (!phone) return "";

  if (phone.startsWith("00")) phone = phone.slice(2);
  while (phone.startsWith("0") && phone.length > 11) phone = phone.slice(1);
  if ((phone.length === 10 || phone.length === 11) && !phone.startsWith("55")) {
    phone = `55${phone}`;
  }
  return phone;
}

function formatBrazilianPhone(input = "") {
  const digits = normalizePhone(input);
  if (!digits) return input;
  let number = digits;
  if (number.startsWith("55")) number = number.slice(2);
  if (!number) return digits;
  if (number.length === 10) return `+55 (${number.slice(0, 2)}) ${number.slice(2, 6)}-${number.slice(6)}`;
  if (number.length === 11) return `+55 (${number.slice(0, 2)}) ${number.slice(2, 3)} ${number.slice(3, 7)}-${number.slice(7)}`;
  if (number.length === 12) return `+55 (${number.slice(0, 2)}) ${number.slice(2, 6)}-${number.slice(6)}`;
  if (number.length === 13) return `+55 (${number.slice(2, 4)}) ${number.slice(4, 5)} ${number.slice(5, 9)}-${number.slice(9)}`;
  return digits;
}

function resolveTargetJid(input?: string | null) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (raw.includes("@")) {
    const [user, server = "s.whatsapp.net"] = raw.split("@");
    const normalizedUser = normalizeWhatsAppPhone(user);
    return normalizedUser ? `${normalizedUser}@${server}` : raw;
  }
  const phone = normalizeWhatsAppPhone(raw);
  if (!phone || phone.length < 10 || phone.length > 15) return "";
  return `${phone}@s.whatsapp.net`;
}

function isIgnoredChatJid(jid?: string | null) {
  const value = String(jid || "").trim().toLowerCase();
  if (!value) return false;
  return value.endsWith("@newsletter") ||
    value.endsWith("@broadcast") ||
    value === "status@broadcast" ||
    value.includes("newsletter") ||
    value.includes("status@broadcast");
}

function jidToConversationFields(jid = "") {
  if (jid.endsWith("@g.us")) {
    return { type: "group", remote_jid: jid, group_jid: jid, contact_phone: null, title: jid };
  }
  const phone = normalizePhone(jid.split("@")[0]);
  const formatted = phone ? formatBrazilianPhone(phone) : jid;
  return { type: "contact", remote_jid: jid, group_jid: null, contact_phone: phone, title: formatted };
}

function isGroupJid(jid?: string | null) {
  return String(jid || "").trim().endsWith("@g.us");
}

function cleanDisplayName(name?: string) {
  const value = String(name || "").trim();
  if (!value || value === "~" || value === "-") return "";
  return value;
}

function sanitizePublicError(error: any) {
  const raw = String(error?.message || error || "");
  if (!raw) return "Operação não concluída";
  const blockedPatterns = [
    /token/i, /secret/i, /sqlite/i, /database/i, /stack/i, /trace/i,
    /bridge/i, /internal/i, /core/i, /go\.mau/i, /whatsmeow/i,
    /password/i, /api[_-]?key/i, /JWT_SECRET/i, /WEBHOOK_SECRET/i,
    /supabase/i, /stripe/i, /redis/i, /auth_token/i, /admin_token/i,
    /\/etc\//, /\/proc\//, /C:\\/i, /home\//, /\/app\//, /\/data\//,
    /s\.whatsapp\.net/, /@g\.us/, /jid/i, /Bearer /i
  ];
  for (const pattern of blockedPatterns) {
    if (pattern.test(raw)) {
      return "Operação não concluída pelo WooAPI Core";
    }
  }
  return raw.slice(0, 180).replace(/[^\x20-\x7E\u00C0-\u00FF]/g, "");
}

const instanceStatusMap: Record<string, string> = {
  none: "logged_out",
  qr: "qr_pending",
  qr_expired: "qr_expired",
  open: "connected",
  close: "disconnected",
  timeout: "error"
};

function publicInstanceStatus(status?: string | null) {
  const value = String(status || "created");
  return instanceStatusMap[value] || value;
}

function isConnectedInstanceStatus(status?: string | null) {
  const value = String(status || "");
  return value === "connected" || value === "open";
}

function isBridgeConnectedStatus(status?: string | null) {
  return String(status || "") === "open";
}

function hasBridgeIdentity(payload: any) {
  return Boolean(payload?.phoneConnected || payload?.phone_connected || payload?.jid);
}

function parseJsonList(value: any) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getTextFromPayload(payload: any) {
  return getInteractiveResponseFromPayload(payload)?.text ||
    payload?.Message?.conversation ||
    payload?.Message?.extendedTextMessage?.text ||
    payload?.message?.conversation ||
    payload?.message?.extendedTextMessage?.text ||
    payload?.text ||
    "";
}

function getInteractiveResponseFromPayload(payload: any) {
  const message = payload?.Message || payload?.message || {};
  const button = message.buttonsResponseMessage || message.ButtonsResponseMessage;
  if (button) {
    const selectedId = button.selectedButtonID || button.SelectedButtonID || button.selectedButtonId || "";
    const selectedText = button.selectedDisplayText || button.SelectedDisplayText || button.displayText || button.DisplayText || selectedId;
    return {
      type: "button_response",
      id: selectedId,
      text: selectedText || selectedId,
      raw: button
    };
  }

  const list = message.listResponseMessage || message.ListResponseMessage;
  const listReply = list?.singleSelectReply || list?.SingleSelectReply || list?.singleSelectReplyMessage || {};
  if (list || Object.keys(listReply).length) {
    const selectedId = listReply.selectedRowID || listReply.SelectedRowID || listReply.selectedRowId || list?.selectedRowID || "";
    const title = list?.title || list?.Title || listReply.title || listReply.Title || selectedId;
    const description = list?.description || list?.Description || listReply.description || listReply.Description || "";
    return {
      type: "list_response",
      id: selectedId,
      text: [title, description].filter(Boolean).join(" - ") || selectedId,
      raw: list
    };
  }

  const interactive = message.interactiveResponseMessage || message.InteractiveResponseMessage;
  const native = interactive?.nativeFlowResponseMessage || interactive?.NativeFlowResponseMessage || {};
  if (interactive) {
    const bodyText = interactive?.body?.text || interactive?.Body?.text || interactive?.Body?.Text || "";
    const selectedId = native.name || native.Name || native.paramsJSON || native.ParamsJSON || "";
    return {
      type: "interactive_response",
      id: selectedId,
      text: bodyText || selectedId || "Resposta interativa",
      raw: interactive
    };
  }

  return null;
}

function getContentFromPayload(payload: any) {
  const message = payload?.Message || payload?.message || {};
  const info = payload?.Info || payload?.info || {};
  const interactive = getInteractiveResponseFromPayload(payload);
  if (interactive?.text) return { contentType: interactive.type, contentText: interactive.text };
  const text = getTextFromPayload(payload);
  if (text) return { contentType: "text", contentText: text };
  const media = message.imageMessage || message.videoMessage || message.audioMessage || message.documentMessage;
  const payloadMediaUrl = payload?.MediaUrl || payload?.mediaUrl || payload?.media_url || "";
  const rawContentType = info.MediaType || info.mediaType ||
    (message.imageMessage ? "image" : message.videoMessage ? "video" : message.audioMessage ? "audio" : message.documentMessage ? "document" : "text");
  const contentType = normalizeIncomingMediaType(rawContentType);
  if (!media && !payloadMediaUrl) return { contentType: "text", contentText: "" };
  const mediaUrl =
    payloadMediaUrl ||
    media?.URL ||
    media?.url ||
    media?.FileURL ||
    media?.fileUrl ||
    media?.file_url ||
    "";
  if (mediaUrl) return { contentType, contentText: mediaUrl };
  const jpegThumbnail = message.imageMessage?.JPEGThumbnail || message.imageMessage?.jpegThumbnail;
  if (jpegThumbnail) {
    return { contentType: "image", contentText: `data:image/jpeg;base64,${jpegThumbnail}` };
  }
  return { contentType, contentText: `[${contentType}]` };
}

function normalizeIncomingMediaType(type?: string | null) {
  const normalized = String(type || "").trim().toLowerCase();
  if (["image", "video", "audio", "document"].includes(normalized)) return normalized;
  if (["ptt", "voice", "audio_message"].includes(normalized)) return "audio";
  if (["sticker"].includes(normalized)) return "image";
  if (normalized.includes("image")) return "image";
  if (normalized.includes("video")) return "video";
  if (normalized.includes("audio") || normalized.includes("ptt")) return "audio";
  if (normalized.includes("document") || normalized.includes("file")) return "document";
  return normalized || "text";
}

function shouldSkipMessagePayload(payload: any) {
  const message = payload?.Message || payload?.message || {};
  if (message.protocolMessage || message.senderKeyDistributionMessage) return true;
  if (message.reactionMessage || message.messageStubType) return true;
  if (getInteractiveResponseFromPayload(payload)) return false;
  return !getContentFromPayload(payload).contentText &&
    !message.imageMessage &&
    !message.videoMessage &&
    !message.audioMessage &&
    !message.documentMessage &&
    !payload?.MediaUrl &&
    !payload?.mediaUrl &&
    !payload?.media_url;
}

async function qrToImage(qr?: string | null) {
  if (!qr) return qr;
  if (qr.startsWith("data:image/")) return qr;
  return QRCode.toDataURL(qr, { margin: 1, width: 320 });
}

function getMessageSource(payload: any) {
  const info = payload?.Info || payload?.info || {};
  const source = info.MessageSource || info.messageSource || {};
  const chat = source.Chat || source.chat || {};
  const sender = source.Sender || source.sender || {};
  const jidFrom = (value: any) => {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (value.String || value.string) return value.String || value.string;
    if (value.User || value.user) return `${value.User || value.user}@${value.Server || value.server || "s.whatsapp.net"}`;
    return "";
  };
  const pushName = info.PushName || info.pushName || payload?.PushName || "";
  const formattedNumber = info.FormattedNumber || info.formattedNumber || payload?.FormattedNumber || payload?.formattedNumber || "";
  const groupName = info.GroupName || info.groupName || payload?.GroupName || payload?.groupName
    || info.ChatName || info.chatName || payload?.ChatName || payload?.chatName || "";
  return {
    chatJid: jidFrom(chat) || jidFrom(info.Chat || info.chat),
    senderJid: jidFrom(sender) || jidFrom(info.Sender || info.sender),
    senderAltJid: jidFrom(info.SenderAlt || info.senderAlt),
    recipientAltJid: jidFrom(info.RecipientAlt || info.recipientAlt),
    id: info.ID || info.id || payload?.ID || payload?.id || `msg_${Date.now()}`,
    pushName,
    formattedNumber,
    groupName,
    timestamp: info.Timestamp || info.timestamp || new Date().toISOString()
  };
}

async function ensureConversation(accountId: number, instanceId: number, jid: string, title?: string) {
  const fields = jidToConversationFields(jid);
  const existing = fields.type === "group"
    ? await get("SELECT * FROM conversations WHERE account_id = ? AND instance_id = ? AND group_jid = ?", [accountId, instanceId, fields.group_jid])
    : await get("SELECT * FROM conversations WHERE account_id = ? AND instance_id = ? AND (remote_jid = ? OR contact_phone = ?)", [accountId, instanceId, fields.remote_jid, fields.contact_phone]);

  if (existing) return existing;

  const info = await run(
    "INSERT INTO conversations (account_id, instance_id, type, remote_jid, contact_phone, group_jid, title, unread_count, status, tags_json) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'open', '[]')",
    [accountId, instanceId, fields.type, fields.remote_jid, fields.contact_phone, fields.group_jid, cleanDisplayName(title) || fields.title]
  );
  return await get("SELECT * FROM conversations WHERE id = ?", [info.lastInsertRowid]);
}

function selectConversationJid(source: ReturnType<typeof getMessageSource>, isFromMe: boolean) {
  if (isGroupJid(source.chatJid)) return source.chatJid;
  return (isFromMe ? source.recipientAltJid : source.senderAltJid) || source.chatJid || source.senderJid;
}

function selectAuthorJid(source: ReturnType<typeof getMessageSource>, isFromMe: boolean) {
  if (isFromMe) return source.senderAltJid || source.senderJid || "";
  return source.senderAltJid || source.senderJid || "";
}

function conversationTitleFromMessage(jid: string, payload: any, pushName?: string, formattedNumber?: string) {
  if (!isGroupJid(jid)) {
    return cleanDisplayName(pushName) || formattedNumber || "";
  }
  return cleanDisplayName(
    payload?.GroupName ||
    payload?.groupName ||
    payload?.Info?.GroupName ||
    payload?.info?.groupName ||
    payload?.Info?.ChatName ||
    payload?.info?.chatName ||
    ""
  );
}

type WebhookTarget = {
  id: number | null;
  account_id: number;
  instance_id: number;
  name?: string | null;
  url: string;
  secret: string;
  events: any;
  retry_enabled: number;
  max_attempts: number;
  source: "instance_webhook" | "legacy_instance" | "global";
};

function publicTenantId(accountId: number | string) {
  return `tenant_${accountId}`;
}

function publicInstanceId(instanceId: number | string) {
  return `inst_${instanceId}`;
}

function parseJsonObject(value: any) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch { return {}; }
}

function isWebhookUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function webhookEventAllowed(events: any, event: string) {
  const allowedEvents = parseJsonList(events);
  return allowedEvents.length === 0 || allowedEvents.includes(event);
}

async function saveWooApiEvent(accountId: number, instanceId: number, payload: any) {
  try {
    await run(
      "INSERT INTO wooapi_events (account_id, instance_id, event_id, event, payload) VALUES (?, ?, ?, ?, ?)",
      [accountId, instanceId, payload.event_id, payload.event, JSON.stringify(payload)]
    );
  } catch {
    // Event persistence must not block delivery scheduling.
  }
}

async function getWebhookTargets(inst: any, event: string, options: { targetWebhookId?: number; bypassEventFilter?: boolean } = {}) {
  const targets: WebhookTarget[] = [];
  const rows = await query(
    "SELECT * FROM instance_webhooks WHERE account_id = ? AND instance_id = ? AND is_active = 1 ORDER BY id ASC",
    [inst.account_id, inst.id]
  );

  for (const row of rows) {
    if (options.targetWebhookId && Number(row.id) !== options.targetWebhookId) continue;
    if (!options.bypassEventFilter && !webhookEventAllowed(row.events, event)) continue;
    if (!isWebhookUrl(String(row.url || ""))) continue;
    targets.push({
      id: Number(row.id),
      account_id: Number(row.account_id),
      instance_id: Number(row.instance_id),
      name: row.name,
      url: row.url,
      secret: row.secret,
      events: row.events,
      retry_enabled: Number(row.retry_enabled ?? 1),
      max_attempts: Number(row.max_attempts || 5),
      source: "instance_webhook"
    });
  }

  if (!options.targetWebhookId && inst.webhook_url && Number(inst.webhook_enabled ?? 1) !== 0) {
    if ((options.bypassEventFilter || webhookEventAllowed(inst.webhook_events, event)) && isWebhookUrl(String(inst.webhook_url))) {
      targets.push({
        id: null,
        account_id: Number(inst.account_id),
        instance_id: Number(inst.id),
        name: "Webhook legado",
        url: inst.webhook_url,
        secret: inst.webhook_secret || WEBHOOK_SECRET,
        events: inst.webhook_events,
        retry_enabled: 1,
        max_attempts: 5,
        source: "legacy_instance"
      });
    }
  }

  if (!options.targetWebhookId) {
    const globalRow = await get("SELECT setting_value FROM system_settings WHERE setting_key = ?", ["global_webhook"]);
    const globalConfig = parseJsonObject(globalRow?.setting_value);
    if (globalConfig.enabled !== false && isWebhookUrl(String(globalConfig.url || "")) &&
        (options.bypassEventFilter || webhookEventAllowed(globalConfig.events, event))) {
      targets.push({
        id: null,
        account_id: Number(inst.account_id),
        instance_id: Number(inst.id),
        name: "Webhook global",
        url: globalConfig.url,
        secret: globalConfig.secret || WEBHOOK_SECRET,
        events: globalConfig.events || [],
        retry_enabled: 1,
        max_attempts: Math.max(1, Math.min(Number(globalConfig.max_attempts || 5), 20)),
        source: "global"
      });
    }
  }

  return targets;
}

async function enqueueWebhookDeliveryByEventId(eventId: number) {
  const row = await get(`
    SELECT webhook_events.*,
           instances.webhook_url AS legacy_url,
           instances.webhook_secret AS legacy_secret,
           instance_webhooks.url AS target_url,
           instance_webhooks.secret AS target_secret,
           instance_webhooks.retry_enabled,
           instance_webhooks.max_attempts
    FROM webhook_events
    LEFT JOIN instances ON instances.id = webhook_events.instance_id
    LEFT JOIN instance_webhooks ON instance_webhooks.id = webhook_events.webhook_id
    WHERE webhook_events.id = ?
  `, [eventId]);
  if (!row) return { queued: false, error: "Evento nao encontrado" };

  const url = row.url || row.target_url || row.legacy_url;
  if (!url || !isWebhookUrl(String(url))) return { queued: false, error: "Webhook sem URL valida" };
  const maxAttempts = Number(row.retry_enabled) === 0 ? 1 : Math.max(1, Math.min(Number(row.max_attempts || 5), 20));
  const payload = parseJsonObject(row.payload);

  try {
    const job = await webhookDeliveryQueue.add(
      "send-webhook",
      {
        accountId: Number(row.account_id),
        tenantId: publicTenantId(row.account_id),
        instanceId: publicInstanceId(row.instance_id),
        webhookId: row.webhook_id || null,
        webhookEventId: Number(row.id),
        event: row.event,
        url,
        secret: row.target_secret || row.legacy_secret || WEBHOOK_SECRET,
        payload
      },
      {
        ...webhookDeliveryJobOptions,
        attempts: maxAttempts
      }
    );
    await run("UPDATE webhook_events SET status = ?, error = NULL, next_retry_at = NULL WHERE id = ?", ["pending", row.id]);
    return { queued: true, jobId: job.id };
  } catch (error) {
    const queueError = `QUEUE_UNAVAILABLE: ${sanitizePublicError(error)}`;
    await run(
      "UPDATE webhook_events SET status = ?, error = ?, next_retry_at = ? WHERE id = ?",
      ["retrying", queueError, new Date(Date.now() + 30000).toISOString(), row.id]
    );
    return { queued: false, error: queueError };
  }
}

async function dispatchWebhook(instanceId: number, event: string, payload: any, options: { targetWebhookId?: number; bypassEventFilter?: boolean } = {}) {
  const inst = await get("SELECT id, account_id, name, phone_connected, webhook_url, webhook_secret, webhook_events, COALESCE(webhook_enabled, 1) AS webhook_enabled FROM instances WHERE id = ?", [instanceId]);
  if (!inst) return { queued: 0, jobs: [] };

  const normalizedPayload = createWooApiEvent({
    event,
    tenantId: publicTenantId(inst.account_id),
    instanceId: publicInstanceId(inst.id),
    data: payload
  });
  saveWooApiEvent(Number(inst.account_id), Number(inst.id), normalizedPayload);

  const targets = await getWebhookTargets(inst, event, options);
  const jobs: any[] = [];
  for (const target of targets) {
    const maxAttempts = target.retry_enabled ? Math.max(1, Math.min(Number(target.max_attempts || 5), 20)) : 1;
    const info = await run(
      "INSERT INTO webhook_events (account_id, instance_id, webhook_id, url, event, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [inst.account_id, instanceId, target.id, target.url, event, JSON.stringify(normalizedPayload), "pending"]
    );
    const queued = await enqueueWebhookDeliveryByEventId(Number(info.lastInsertRowid));
    jobs.push({ webhookId: target.id, webhookEventId: Number(info.lastInsertRowid), maxAttempts, ...queued });
  }

  return { queued: jobs.filter((job) => job.queued).length, jobs };
}

async function deliverWebhookEvent(eventId: number) {
  return await enqueueWebhookDeliveryByEventId(eventId);
}

async function migrate() {
  if (isPostgres()) {
    await runMigrations();
    await exec(`
      CREATE TABLE IF NOT EXISTS external_integrations (
        id BIGSERIAL PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'evolution_api',
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        admin_key TEXT NOT NULL,
        auth_header TEXT NOT NULL DEFAULT 'apikey',
        auth_prefix TEXT DEFAULT '',
        list_instances_path TEXT NOT NULL DEFAULT '/instance/fetchInstances',
        create_instance_path TEXT NOT NULL DEFAULT '/instance/create',
        is_active INTEGER DEFAULT 1,
        notes TEXT,
        created_at TIMESTAMP DEFAULT current_timestamp,
        updated_at TIMESTAMP DEFAULT current_timestamp
      );
      CREATE TABLE IF NOT EXISTS external_integration_account_access (
        id BIGSERIAL PRIMARY KEY,
        integration_id BIGINT REFERENCES external_integrations(id) ON DELETE CASCADE,
        account_id BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
        enabled INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT current_timestamp,
        updated_at TIMESTAMP DEFAULT current_timestamp,
        UNIQUE(integration_id, account_id)
      );
      CREATE TABLE IF NOT EXISTS partners (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        referral_code TEXT UNIQUE NOT NULL,
        commission_rate REAL DEFAULT 10,
        status TEXT DEFAULT 'active',
        notes TEXT,
        created_at TIMESTAMP DEFAULT current_timestamp,
        updated_at TIMESTAMP DEFAULT current_timestamp
      );
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS referred_partner_id BIGINT REFERENCES partners(id) ON DELETE SET NULL;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS referral_code TEXT;
      CREATE TABLE IF NOT EXISTS partner_referrals (
        id BIGSERIAL PRIMARY KEY,
        partner_id BIGINT REFERENCES partners(id) ON DELETE CASCADE,
        account_id BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
        referral_code TEXT NOT NULL,
        source TEXT DEFAULT 'signup',
        status TEXT DEFAULT 'converted',
        metadata_json TEXT DEFAULT '{}',
        created_at TIMESTAMP DEFAULT current_timestamp,
        updated_at TIMESTAMP DEFAULT current_timestamp,
        UNIQUE(partner_id, account_id)
      );
      CREATE TABLE IF NOT EXISTS partner_commissions (
        id BIGSERIAL PRIMARY KEY,
        partner_id BIGINT REFERENCES partners(id) ON DELETE CASCADE,
        account_id BIGINT REFERENCES accounts(id) ON DELETE SET NULL,
        amount REAL NOT NULL DEFAULT 0,
        status TEXT DEFAULT 'pending',
        description TEXT,
        due_at TIMESTAMP,
        paid_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT current_timestamp,
        updated_at TIMESTAMP DEFAULT current_timestamp
      );
      CREATE INDEX IF NOT EXISTS idx_external_access_account ON external_integration_account_access(account_id);
      CREATE INDEX IF NOT EXISTS idx_partner_referrals_partner ON partner_referrals(partner_id);
      CREATE INDEX IF NOT EXISTS idx_partner_referrals_account ON partner_referrals(account_id);
      CREATE INDEX IF NOT EXISTS idx_partner_commissions_partner ON partner_commissions(partner_id);
    `);
    return;
  }

  exec(`
    CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_account_id INTEGER, account_type TEXT DEFAULT 'customer', name TEXT, plan_id INTEGER, instance_quota INTEGER, max_client_accounts INTEGER DEFAULT 0, status TEXT DEFAULT 'active', owner_name TEXT, owner_email TEXT, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, name TEXT, email TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'admin', status TEXT DEFAULT 'active', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price REAL DEFAULT 0, max_agents INTEGER DEFAULT 0, max_campaigns INTEGER DEFAULT 0, max_leads INTEGER DEFAULT 0, max_instances INTEGER DEFAULT 1, max_users INTEGER DEFAULT 2, max_messages INTEGER DEFAULT 5000, max_client_accounts INTEGER DEFAULT 0, features_json TEXT DEFAULT '[]', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS instances (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, name TEXT, status TEXT DEFAULT 'none', phone_connected TEXT, profile_name TEXT, profile_picture_url TEXT, qr TEXT, engine TEXT DEFAULT 'wooapi', webhook_url TEXT, api_key TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, name TEXT, phone TEXT, address TEXT, niche TEXT, status TEXT DEFAULT 'pending', kanban_status TEXT DEFAULT 'new', campaign_id INTEGER, last_interaction_type TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS agents (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, name TEXT, system_instruction TEXT, personality TEXT, faq_json TEXT, handoff_trigger TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, name TEXT, agent_id INTEGER, initial_method TEXT DEFAULT 'direct', transition_rules TEXT DEFAULT '{}', status TEXT DEFAULT 'draft', message_template TEXT, media_url TEXT, min_delay_ms INTEGER DEFAULT 1000, max_delay_ms INTEGER DEFAULT 3000, scheduled_at DATETIME, started_at DATETIME, completed_at DATETIME, total_count INTEGER DEFAULT 0, sent_count INTEGER DEFAULT 0, delivered_count INTEGER DEFAULT 0, read_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, limit_per_instance INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS campaign_recipients (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, campaign_id INTEGER, instance_id INTEGER, phone TEXT, jid TEXT, variables_json TEXT DEFAULT '{}', status TEXT DEFAULT 'pending', job_id TEXT, message_id TEXT, error TEXT, scheduled_at DATETIME, sent_at DATETIME, delivered_at DATETIME, read_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS quick_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, shortcut TEXT, title TEXT, content TEXT, media_url TEXT, is_active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(account_id, shortcut));
    CREATE TABLE IF NOT EXISTS lead_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, lead_id INTEGER, user_id INTEGER, note TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS lead_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, lead_id INTEGER, tag TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(account_id, lead_id, tag));
    CREATE TABLE IF NOT EXISTS lead_custom_fields (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, lead_id INTEGER, field_key TEXT, field_value TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(account_id, lead_id, field_key));
    CREATE TABLE IF NOT EXISTS system_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, setting_key TEXT UNIQUE, setting_value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS team_members (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, name TEXT, role TEXT, email TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, name TEXT, agent_id INTEGER, member_id INTEGER, description TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS llm_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, provider TEXT, name TEXT, api_key TEXT, model_name TEXT, is_active INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, type TEXT DEFAULT 'contact', remote_jid TEXT, contact_phone TEXT, group_jid TEXT, title TEXT, contact_profile_picture_url TEXT, tags_json TEXT DEFAULT '[]', status TEXT DEFAULT 'open', assigned_to TEXT, last_message_preview TEXT, unread_count INTEGER DEFAULT 0, last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, conversation_id INTEGER, lead_id INTEGER, direction TEXT, chat_type TEXT, author_phone TEXT, author_push_name TEXT, content_type TEXT DEFAULT 'text', content_text TEXT, message_id TEXT, delivery_status TEXT DEFAULT 'received', from_me INTEGER DEFAULT 0, sender TEXT, raw_json TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS whatsapp_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, group_jid TEXT, name TEXT, topic TEXT, owner_jid TEXT, participant_count INTEGER DEFAULT 0, is_admin INTEGER DEFAULT 0, announce INTEGER DEFAULT 0, locked INTEGER DEFAULT 0, invite_link TEXT, picture_url TEXT, raw_json TEXT DEFAULT '{}', synced_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(instance_id, group_jid));
    CREATE TABLE IF NOT EXISTS whatsapp_group_participants (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, group_jid TEXT, participant_jid TEXT, phone TEXT, name TEXT, is_admin INTEGER DEFAULT 0, raw_json TEXT DEFAULT '{}', synced_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(instance_id, group_jid, participant_jid));
    CREATE TABLE IF NOT EXISTS group_moderation_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, group_jid TEXT, name TEXT, rule_type TEXT DEFAULT 'keyword', pattern TEXT, action TEXT DEFAULT 'warn', warning_text TEXT, threshold INTEGER DEFAULT 1, window_minutes INTEGER DEFAULT 60, enabled INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS group_moderation_events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, group_jid TEXT, participant_jid TEXT, message_id TEXT, rule_id INTEGER, action TEXT, matched_text TEXT, status TEXT DEFAULT 'logged', error TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS webhook_events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, webhook_id INTEGER, url TEXT, event TEXT, payload TEXT, status TEXT DEFAULT 'pending', response_status INTEGER, error TEXT, attempts INTEGER DEFAULT 0, retry_count INTEGER DEFAULT 0, last_attempt_at DATETIME, next_retry_at DATETIME, delivered_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS wooapi_events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, event_id TEXT UNIQUE, event TEXT, payload TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS instance_webhooks (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, instance_id INTEGER NOT NULL, name TEXT, url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT DEFAULT '[]', is_active INTEGER DEFAULT 1, retry_enabled INTEGER DEFAULT 1, max_attempts INTEGER DEFAULT 5, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS webhook_delivery_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, tenant_id TEXT, instance_id INTEGER, webhook_id INTEGER, webhook_event_id INTEGER, event TEXT NOT NULL, url TEXT NOT NULL, status_code INTEGER, success INTEGER DEFAULT 0, attempt INTEGER DEFAULT 1, request_payload TEXT, response_body TEXT, error TEXT, duration_ms INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS api_request_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, method TEXT, path TEXT, status_code INTEGER, ip TEXT, user_agent TEXT, duration_ms INTEGER, error TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS data_consent (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, user_id INTEGER, purpose TEXT NOT NULL, consent_type TEXT NOT NULL DEFAULT 'lgpd', granted INTEGER DEFAULT 1, granted_at DATETIME DEFAULT CURRENT_TIMESTAMP, revoked_at DATETIME, ip_address TEXT, user_agent TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS data_retention_policies (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, data_type TEXT NOT NULL, retention_days INTEGER NOT NULL DEFAULT 90, action TEXT NOT NULL DEFAULT 'delete', enabled INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS data_subject_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, request_type TEXT NOT NULL, status TEXT DEFAULT 'pending', requested_by TEXT, notes TEXT, processed_at DATETIME, expires_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS connection_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, event TEXT, status TEXT, details_json TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS message_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, message_id TEXT, direction TEXT, status TEXT, details_json TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS support_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, severity TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'open', metadata TEXT DEFAULT '{}', opened_at DATETIME DEFAULT CURRENT_TIMESTAMP, acknowledged_at DATETIME, resolved_at DATETIME);
    CREATE TABLE IF NOT EXISTS support_tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, alert_id INTEGER, subject TEXT NOT NULL, status TEXT DEFAULT 'open', priority TEXT DEFAULT 'normal', source TEXT DEFAULT 'support_chat', assigned_to TEXT, ai_summary TEXT, ai_resolution TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, escalated_at DATETIME, resolved_at DATETIME);
    CREATE TABLE IF NOT EXISTS support_ticket_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, account_id INTEGER, user_id INTEGER, sender TEXT NOT NULL, message TEXT NOT NULL, metadata TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS support_ai_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, ticket_id INTEGER, alert_id INTEGER, action TEXT NOT NULL, status TEXT DEFAULT 'completed', details_json TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS integration_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, provider TEXT, enabled INTEGER DEFAULT 0, config_json TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(instance_id, provider));
    CREATE TABLE IF NOT EXISTS integration_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, provider TEXT, contact_key TEXT, session_id TEXT, result_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(instance_id, provider, contact_key));
    CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, user_id INTEGER, action TEXT, details_json TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS support_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, super_admin_user_id INTEGER, target_account_id INTEGER, reason TEXT, expires_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, event TEXT, quantity INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS core_nodes (id TEXT PRIMARY KEY, region TEXT DEFAULT 'br-south', profile TEXT DEFAULT 'low-risk', ip_pool_id TEXT DEFAULT 'default', status TEXT DEFAULT 'ACTIVE', drain_mode INTEGER DEFAULT 0, max_instances INTEGER DEFAULT 150, active_instances INTEGER DEFAULT 0, cpu_percent REAL DEFAULT 0, memory_percent REAL DEFAULT 0, error_rate REAL DEFAULT 0, avg_latency_ms INTEGER DEFAULT 0, last_heartbeat_at DATETIME DEFAULT CURRENT_TIMESTAMP, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS instance_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, node_id TEXT, ip_pool_id TEXT, profile TEXT, reason TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS instance_state_events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, from_state TEXT, to_state TEXT, trigger TEXT, metadata_json TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS reputation_scores (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, subject_id TEXT, score INTEGER DEFAULT 100, metadata_json TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(scope, subject_id));
    CREATE TABLE IF NOT EXISTS traffic_buckets (id INTEGER PRIMARY KEY AUTOINCREMENT, bucket_key TEXT UNIQUE, count INTEGER DEFAULT 0, reset_at DATETIME, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS traffic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, instance_id INTEGER, node_id TEXT, decision TEXT, reason TEXT, delay_ms INTEGER DEFAULT 0, score INTEGER, metadata_json TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS external_integrations (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL DEFAULT 'evolution_api', name TEXT NOT NULL, base_url TEXT NOT NULL, admin_key TEXT NOT NULL, auth_header TEXT NOT NULL DEFAULT 'apikey', auth_prefix TEXT DEFAULT '', list_instances_path TEXT NOT NULL DEFAULT '/instance/fetchInstances', create_instance_path TEXT NOT NULL DEFAULT '/instance/create', is_active INTEGER DEFAULT 1, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS external_integration_account_access (id INTEGER PRIMARY KEY AUTOINCREMENT, integration_id INTEGER, account_id INTEGER, enabled INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(integration_id, account_id));
    CREATE TABLE IF NOT EXISTS partners (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT, phone TEXT, referral_code TEXT UNIQUE NOT NULL, commission_rate REAL DEFAULT 10, status TEXT DEFAULT 'active', notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS partner_referrals (id INTEGER PRIMARY KEY AUTOINCREMENT, partner_id INTEGER, account_id INTEGER, referral_code TEXT NOT NULL, source TEXT DEFAULT 'signup', status TEXT DEFAULT 'converted', metadata_json TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(partner_id, account_id));
    CREATE TABLE IF NOT EXISTS partner_commissions (id INTEGER PRIMARY KEY AUTOINCREMENT, partner_id INTEGER, account_id INTEGER, amount REAL NOT NULL DEFAULT 0, status TEXT DEFAULT 'pending', description TEXT, due_at DATETIME, paid_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  `);

  const requiredColumns: Record<string, Record<string, string>> = {
    instances: {
      qr: "TEXT",
      webhook_url: "TEXT",
      webhook_secret: "TEXT",
      webhook_events: "TEXT DEFAULT '[]'",
      webhook_enabled: "INTEGER DEFAULT 1",
      websocket_enabled: "INTEGER DEFAULT 1",
      api_key: "TEXT",
      updated_at: "DATETIME",
      phone_connected: "TEXT",
      phone: "TEXT",
      jid: "TEXT",
      connection_status: "TEXT",
      profile_name: "TEXT",
      profile_picture_url: "TEXT",
      last_qr: "TEXT",
      last_qr_at: "DATETIME",
      connected_at: "DATETIME",
      disconnected_at: "DATETIME",
      last_seen_at: "DATETIME",
      deleted_at: "DATETIME",
      operational_status: "TEXT DEFAULT 'unknown'",
      assigned_node_id: "TEXT",
      ip_pool_id: "TEXT DEFAULT 'default'",
      risk_profile: "TEXT DEFAULT 'low-risk'",
      risk_score: "INTEGER DEFAULT 100",
      last_event_at: "DATETIME",
      connection_uptime_seconds: "INTEGER DEFAULT 0",
      disconnection_count_24h: "INTEGER DEFAULT 0",
      message_sent_count_24h: "INTEGER DEFAULT 0",
      message_failed_count_24h: "INTEGER DEFAULT 0",
      avg_send_latency_ms: "INTEGER DEFAULT 0",
      last_error: "TEXT"
    },
    leads: { status: "TEXT DEFAULT 'pending'", kanban_status: "TEXT DEFAULT 'new'", campaign_id: "INTEGER", last_interaction_type: "TEXT", custom_fields_json: "TEXT DEFAULT '{}'", tags_json: "TEXT DEFAULT '[]'" },
    agents: { personality: "TEXT", faq_json: "TEXT", handoff_trigger: "TEXT", created_at: "DATETIME" },
    campaigns: { instance_id: "INTEGER", initial_method: "TEXT DEFAULT 'direct'", transition_rules: "TEXT DEFAULT '{}'", status: "TEXT DEFAULT 'draft'", message_template: "TEXT", media_url: "TEXT", min_delay_ms: "INTEGER DEFAULT 1000", max_delay_ms: "INTEGER DEFAULT 3000", scheduled_at: "DATETIME", started_at: "DATETIME", completed_at: "DATETIME", total_count: "INTEGER DEFAULT 0", sent_count: "INTEGER DEFAULT 0", delivered_count: "INTEGER DEFAULT 0", read_count: "INTEGER DEFAULT 0", failed_count: "INTEGER DEFAULT 0", limit_per_instance: "INTEGER DEFAULT 1", updated_at: "DATETIME" },
    credentials: {},
    conversations: { instance_id: "INTEGER", type: "TEXT DEFAULT 'contact'", remote_jid: "TEXT", group_jid: "TEXT", contact_profile_picture_url: "TEXT", tags_json: "TEXT DEFAULT '[]'", status: "TEXT DEFAULT 'open'", assigned_to: "TEXT", last_message_preview: "TEXT", unread_count: "INTEGER DEFAULT 0", updated_at: "DATETIME" },
    messages: { instance_id: "INTEGER", lead_id: "INTEGER", chat_type: "TEXT", author_phone: "TEXT", author_push_name: "TEXT", content_type: "TEXT DEFAULT 'text'", message_id: "TEXT", delivery_status: "TEXT DEFAULT 'received'", from_me: "INTEGER DEFAULT 0", sender: "TEXT", raw_json: "TEXT" },
    whatsapp_groups: { account_id: "INTEGER", instance_id: "INTEGER", group_jid: "TEXT", name: "TEXT", topic: "TEXT", owner_jid: "TEXT", participant_count: "INTEGER DEFAULT 0", is_admin: "INTEGER DEFAULT 0", announce: "INTEGER DEFAULT 0", locked: "INTEGER DEFAULT 0", invite_link: "TEXT", picture_url: "TEXT", raw_json: "TEXT DEFAULT '{}'", synced_at: "DATETIME", updated_at: "DATETIME" },
    whatsapp_group_participants: { account_id: "INTEGER", instance_id: "INTEGER", group_jid: "TEXT", participant_jid: "TEXT", phone: "TEXT", name: "TEXT", is_admin: "INTEGER DEFAULT 0", raw_json: "TEXT DEFAULT '{}'", synced_at: "DATETIME", updated_at: "DATETIME" },
    group_moderation_rules: { account_id: "INTEGER", instance_id: "INTEGER", group_jid: "TEXT", name: "TEXT", rule_type: "TEXT DEFAULT 'keyword'", pattern: "TEXT", action: "TEXT DEFAULT 'warn'", warning_text: "TEXT", threshold: "INTEGER DEFAULT 1", window_minutes: "INTEGER DEFAULT 60", enabled: "INTEGER DEFAULT 1", updated_at: "DATETIME" },
    group_moderation_events: { account_id: "INTEGER", instance_id: "INTEGER", group_jid: "TEXT", participant_jid: "TEXT", message_id: "TEXT", rule_id: "INTEGER", action: "TEXT", matched_text: "TEXT", status: "TEXT DEFAULT 'logged'", error: "TEXT" },
    webhook_events: { webhook_id: "INTEGER", url: "TEXT", attempts: "INTEGER DEFAULT 0", retry_count: "INTEGER DEFAULT 0", last_attempt_at: "DATETIME", next_retry_at: "DATETIME" },
    wooapi_events: { account_id: "INTEGER", instance_id: "INTEGER", event_id: "TEXT", event: "TEXT", payload: "TEXT DEFAULT '{}'", created_at: "DATETIME" },
    instance_webhooks: { account_id: "INTEGER", instance_id: "INTEGER", name: "TEXT", url: "TEXT", secret: "TEXT", events: "TEXT DEFAULT '[]'", is_active: "INTEGER DEFAULT 1", retry_enabled: "INTEGER DEFAULT 1", max_attempts: "INTEGER DEFAULT 5", updated_at: "DATETIME" },
    webhook_delivery_logs: { account_id: "INTEGER", tenant_id: "TEXT", instance_id: "INTEGER", webhook_id: "INTEGER", webhook_event_id: "INTEGER", event: "TEXT", url: "TEXT", status_code: "INTEGER", success: "INTEGER DEFAULT 0", attempt: "INTEGER DEFAULT 1", request_payload: "TEXT", response_body: "TEXT", error: "TEXT", duration_ms: "INTEGER" },
    support_alerts: { account_id: "INTEGER", instance_id: "INTEGER", severity: "TEXT", type: "TEXT", title: "TEXT", description: "TEXT", status: "TEXT DEFAULT 'open'", metadata: "TEXT DEFAULT '{}'", opened_at: "DATETIME", acknowledged_at: "DATETIME", resolved_at: "DATETIME" },
    support_tickets: { account_id: "INTEGER", instance_id: "INTEGER", alert_id: "INTEGER", subject: "TEXT", status: "TEXT DEFAULT 'open'", priority: "TEXT DEFAULT 'normal'", source: "TEXT DEFAULT 'support_chat'", assigned_to: "TEXT", ai_summary: "TEXT", ai_resolution: "TEXT", created_at: "DATETIME", updated_at: "DATETIME", escalated_at: "DATETIME", resolved_at: "DATETIME" },
    support_ticket_messages: { ticket_id: "INTEGER", account_id: "INTEGER", user_id: "INTEGER", sender: "TEXT", message: "TEXT", metadata: "TEXT DEFAULT '{}'", created_at: "DATETIME" },
    support_ai_actions: { account_id: "INTEGER", instance_id: "INTEGER", ticket_id: "INTEGER", alert_id: "INTEGER", action: "TEXT", status: "TEXT DEFAULT 'completed'", details_json: "TEXT DEFAULT '{}'", created_at: "DATETIME" },
    external_integrations: { provider: "TEXT NOT NULL DEFAULT 'evolution_api'", name: "TEXT", base_url: "TEXT", admin_key: "TEXT", auth_header: "TEXT NOT NULL DEFAULT 'apikey'", auth_prefix: "TEXT DEFAULT ''", list_instances_path: "TEXT NOT NULL DEFAULT '/instance/fetchInstances'", create_instance_path: "TEXT NOT NULL DEFAULT '/instance/create'", is_active: "INTEGER DEFAULT 1", notes: "TEXT", created_at: "DATETIME", updated_at: "DATETIME" },
    external_integration_account_access: { integration_id: "INTEGER", account_id: "INTEGER", enabled: "INTEGER DEFAULT 0", created_at: "DATETIME", updated_at: "DATETIME" },
    partners: { name: "TEXT", email: "TEXT", phone: "TEXT", referral_code: "TEXT", commission_rate: "REAL DEFAULT 10", status: "TEXT DEFAULT 'active'", notes: "TEXT", created_at: "DATETIME", updated_at: "DATETIME" },
    partner_referrals: { partner_id: "INTEGER", account_id: "INTEGER", referral_code: "TEXT", source: "TEXT DEFAULT 'signup'", status: "TEXT DEFAULT 'converted'", metadata_json: "TEXT DEFAULT '{}'", created_at: "DATETIME", updated_at: "DATETIME" },
    partner_commissions: { partner_id: "INTEGER", account_id: "INTEGER", amount: "REAL NOT NULL DEFAULT 0", status: "TEXT DEFAULT 'pending'", description: "TEXT", due_at: "DATETIME", paid_at: "DATETIME", created_at: "DATETIME", updated_at: "DATETIME" },
    accounts: {
      parent_account_id: "INTEGER",
      account_type: "TEXT DEFAULT 'client'",
      plan_id: "INTEGER",
      instance_quota: "INTEGER",
      max_client_accounts: "INTEGER DEFAULT 0",
      status: "TEXT DEFAULT 'active'",
      name: "TEXT",
      email: "TEXT",
      document: "TEXT",
      phone: "TEXT",
      owner_name: "TEXT",
      owner_email: "TEXT",
      notes: "TEXT",
      billing_status: "TEXT",
      trial_ends_at: "DATETIME",
      paused_at: "DATETIME",
      blocked_at: "DATETIME",
      updated_at: "DATETIME",
      deleted_at: "DATETIME",
      created_at: "DATETIME",
      stripe_customer_id: "TEXT",
      stripe_subscription_id: "TEXT",
      referred_partner_id: "INTEGER",
      referral_code: "TEXT"
    },
    users: { status: "TEXT DEFAULT 'active'", created_at: "DATETIME", deleted_at: "DATETIME" },
    plans: {
      description: "TEXT",
      billing_cycle: "TEXT DEFAULT 'monthly'",
      instance_quota: "INTEGER",
      max_instances: "INTEGER DEFAULT 1",
      max_users: "INTEGER DEFAULT 2",
      max_messages: "INTEGER DEFAULT 5000",
      max_client_accounts: "INTEGER DEFAULT 0",
      webhook_enabled: "INTEGER DEFAULT 1",
      websocket_enabled: "INTEGER DEFAULT 1",
      api_enabled: "INTEGER DEFAULT 1",
      chatwoot_enabled: "INTEGER DEFAULT 1",
      typebot_enabled: "INTEGER DEFAULT 1",
      n8n_enabled: "INTEGER DEFAULT 1",
      support_level: "TEXT DEFAULT 'standard'",
      is_active: "INTEGER DEFAULT 1",
      updated_at: "DATETIME",
      stripe_product_id: "TEXT",
      api_rate_limit_per_minute: "INTEGER DEFAULT 60",
      instance_rate_limit_per_minute: "INTEGER DEFAULT 30",
      message_rate_limit_per_minute: "INTEGER DEFAULT 20"
    },
    llm_credentials: { model_name: "TEXT", created_at: "DATETIME" }
  };

  for (const [table, columns] of Object.entries(requiredColumns)) {
    if (!await get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table])) continue;
    const existing = (await query(`PRAGMA table_info(${table})`)).map((c: any) => c.name);
    for (const [column, type] of Object.entries(columns)) {
      if (!existing.includes(column)) exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  if (isPostgres()) {
    await exec(`
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS contact_profile_picture_url TEXT;
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS api_rate_limit_per_minute INTEGER DEFAULT 60;
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS instance_rate_limit_per_minute INTEGER DEFAULT 30;
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS message_rate_limit_per_minute INTEGER DEFAULT 20;
    `);
  }

  exec(`
    UPDATE accounts SET account_type = 'client' WHERE account_type = 'customer';
    UPDATE accounts SET email = COALESCE(email, owner_email), updated_at = COALESCE(updated_at, created_at) WHERE email IS NULL OR updated_at IS NULL;
    UPDATE plans SET instance_quota = COALESCE(instance_quota, max_instances), is_active = COALESCE(is_active, 1), updated_at = COALESCE(updated_at, created_at) WHERE instance_quota IS NULL OR is_active IS NULL OR updated_at IS NULL;
    UPDATE instances SET webhook_enabled = COALESCE(webhook_enabled, 1), websocket_enabled = COALESCE(websocket_enabled, 1), connection_status = COALESCE(connection_status, status), last_qr = COALESCE(last_qr, qr), phone = COALESCE(phone, phone_connected) WHERE webhook_enabled IS NULL OR websocket_enabled IS NULL OR connection_status IS NULL OR phone IS NULL;
    CREATE INDEX IF NOT EXISTS idx_accounts_parent ON accounts(parent_account_id);
    CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
    CREATE INDEX IF NOT EXISTS idx_instances_account ON instances(account_id);
    CREATE INDEX IF NOT EXISTS idx_instances_api_key ON instances(api_key);
    CREATE INDEX IF NOT EXISTS idx_instances_status ON instances(status);
    CREATE INDEX IF NOT EXISTS idx_instances_phone ON instances(phone_connected);
    CREATE INDEX IF NOT EXISTS idx_instances_jid ON instances(jid);
    CREATE INDEX IF NOT EXISTS idx_messages_account_instance ON messages(account_id, instance_id);
    CREATE INDEX IF NOT EXISTS idx_wooapi_events_instance ON wooapi_events(instance_id);
    CREATE INDEX IF NOT EXISTS idx_wooapi_events_event_id ON wooapi_events(event_id);
    CREATE INDEX IF NOT EXISTS idx_instance_webhooks_instance ON instance_webhooks(instance_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_instance ON webhook_events(instance_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events(status);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_webhook ON webhook_events(webhook_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_delivery_logs_instance ON webhook_delivery_logs(instance_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_delivery_logs_webhook ON webhook_delivery_logs(webhook_id);
    CREATE INDEX IF NOT EXISTS idx_support_alerts_status ON support_alerts(status);
    CREATE INDEX IF NOT EXISTS idx_support_alerts_instance ON support_alerts(instance_id);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_account ON support_tickets(account_id);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_instance ON support_tickets(instance_id);
    CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket ON support_ticket_messages(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_support_ai_actions_ticket ON support_ai_actions(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_account ON audit_logs(account_id);
    CREATE INDEX IF NOT EXISTS idx_api_request_logs_account ON api_request_logs(account_id);
    CREATE INDEX IF NOT EXISTS idx_api_request_logs_instance ON api_request_logs(instance_id);
    CREATE INDEX IF NOT EXISTS idx_connection_logs_instance ON connection_logs(instance_id);
    CREATE INDEX IF NOT EXISTS idx_message_logs_instance ON message_logs(instance_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign ON campaign_recipients(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status ON campaign_recipients(status);
    CREATE INDEX IF NOT EXISTS idx_quick_replies_account ON quick_replies(account_id);
    CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes(lead_id);
    CREATE INDEX IF NOT EXISTS idx_lead_tags_lead ON lead_tags(lead_id);
    CREATE INDEX IF NOT EXISTS idx_core_nodes_status ON core_nodes(status);
    CREATE INDEX IF NOT EXISTS idx_core_nodes_profile ON core_nodes(profile);
    CREATE INDEX IF NOT EXISTS idx_instance_assignments_instance ON instance_assignments(instance_id);
    CREATE INDEX IF NOT EXISTS idx_instance_state_events_instance ON instance_state_events(instance_id);
    CREATE INDEX IF NOT EXISTS idx_reputation_scores_scope ON reputation_scores(scope, score);
    CREATE INDEX IF NOT EXISTS idx_traffic_decisions_instance ON traffic_decisions(instance_id);
    CREATE INDEX IF NOT EXISTS idx_traffic_decisions_created ON traffic_decisions(created_at);
    CREATE INDEX IF NOT EXISTS idx_external_access_account ON external_integration_account_access(account_id);
    CREATE INDEX IF NOT EXISTS idx_partner_referrals_partner ON partner_referrals(partner_id);
    CREATE INDEX IF NOT EXISTS idx_partner_referrals_account ON partner_referrals(account_id);
    CREATE INDEX IF NOT EXISTS idx_partner_commissions_partner ON partner_commissions(partner_id);
  `);

  const ensurePlan = async (
    name: string,
    price: number,
    maxAgents: number,
    maxCampaigns: number,
    maxLeads: number,
    maxInstances: number,
    maxUsers: number,
    maxMessages: number,
    maxClientAccounts: number,
    features: string[]
  ) => {
    const existing = await get("SELECT id FROM plans WHERE name = ?", [name]);
    if (existing) {
      await run(
        "UPDATE plans SET price = ?, max_agents = ?, max_campaigns = ?, max_leads = ?, max_instances = ?, max_users = ?, max_messages = ?, max_client_accounts = ?, features_json = ? WHERE id = ?",
        [price, maxAgents, maxCampaigns, maxLeads, maxInstances, maxUsers, maxMessages, maxClientAccounts, JSON.stringify(features), existing.id]
      );
      return;
    }
    await run(
      "INSERT INTO plans (name, price, max_agents, max_campaigns, max_leads, max_instances, max_users, max_messages, max_client_accounts, features_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [name, price, maxAgents, maxCampaigns, maxLeads, maxInstances, maxUsers, maxMessages, maxClientAccounts, JSON.stringify(features)]
    );
  };

  const starter = await get("SELECT id FROM plans WHERE name = ?", ["Starter API"]);
  const trial = await get("SELECT id FROM plans WHERE name = ?", ["Teste Gratis"]);
  if (starter && !trial) {
    await run("UPDATE plans SET name = ? WHERE id = ?", ["Teste Gratis", starter.id]);
  }

  await ensurePlan("Teste Gratis", 0, 0, 0, 0, 1, 1, 200, 0, ["Teste de 1 hora", "1 instancia WhatsApp", "API", "Webhook", "Conta excluida automaticamente"]);
  await ensurePlan("Wozapi Por Instancia", 59.9, 0, 0, 0, 1, 1, 5000, 0, ["1 instancia WhatsApp", "API", "Webhook", "WebSocket"]);
  await ensurePlan("Wozapi Pro", 179.9, 0, 0, 0, 3, 3, 20000, 0, ["3 instancias", "Logs avancados", "Chatwoot", "Typebot", "n8n"]);
  await ensurePlan("Wozapi Scale", 399.9, 0, 0, 0, 8, 8, 80000, 0, ["8 instancias", "Campanhas", "Filas dedicadas", "Suporte prioritario"]);
  await ensurePlan("Wozapi Enterprise", 899.9, 0, 0, 0, 20, 20, 250000, 50, ["20 instancias", "Subcontas", "Revenda", "Suporte enterprise"]);

  const testPlan = await get("SELECT id FROM plans WHERE name = ?", ["Teste Gratis"]);
  if (testPlan) {
    for (const legacyName of ["Starter API", "Beta"]) {
      const legacyPlan = await get("SELECT id FROM plans WHERE name = ?", [legacyName]);
      if (!legacyPlan) continue;
      await run("UPDATE accounts SET plan_id = ? WHERE plan_id = ?", [testPlan.id, legacyPlan.id]);
      await run("DELETE FROM plans WHERE id = ?", [legacyPlan.id]);
    }
  }
}

async function ensureDefaultCommercialPlans() {
  const ensurePlan = async (
    name: string,
    price: number,
    maxInstances: number,
    maxUsers: number,
    maxMessages: number,
    maxClientAccounts: number,
    features: string[]
  ) => {
    const existing = await get("SELECT id FROM plans WHERE name = ?", [name]);
    if (existing) {
      await run(
        "UPDATE plans SET price = ?, max_instances = ?, instance_quota = ?, max_users = ?, max_messages = ?, max_client_accounts = ?, features_json = ?, is_active = 1 WHERE id = ?",
        [price, maxInstances, maxInstances, maxUsers, maxMessages, maxClientAccounts, JSON.stringify(features), existing.id]
      );
      return existing.id;
    }
    const info = await run(
      "INSERT INTO plans (name, price, billing_cycle, max_instances, instance_quota, max_users, max_messages, max_client_accounts, features_json, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
      [name, price, "monthly", maxInstances, maxInstances, maxUsers, maxMessages, maxClientAccounts, JSON.stringify(features)]
    );
    return info.lastInsertRowid;
  };

  const starter = await get("SELECT id FROM plans WHERE name = ?", ["Starter API"]);
  const trial = await get("SELECT id FROM plans WHERE name = ?", ["Teste Gratis"]);
  if (starter && !trial) {
    await run("UPDATE plans SET name = ? WHERE id = ?", ["Teste Gratis", starter.id]);
  }

  const testPlanId = await ensurePlan("Teste Gratis", 0, 1, 1, 200, 0, ["Teste de 1 hora", "1 instancia WhatsApp", "API", "Webhook", "Conta excluida automaticamente"]);
  await ensurePlan("Wozapi Por Instancia", 59.9, 1, 1, 5000, 0, ["1 instancia WhatsApp", "API", "Webhook", "WebSocket"]);
  await ensurePlan("Wozapi Pro", 179.9, 3, 3, 20000, 0, ["3 instancias", "Logs avancados", "Chatwoot", "Typebot", "n8n"]);
  await ensurePlan("Wozapi Scale", 399.9, 8, 8, 80000, 0, ["8 instancias", "Campanhas", "Filas dedicadas", "Suporte prioritario"]);
  await ensurePlan("Wozapi Enterprise", 899.9, 20, 20, 250000, 50, ["20 instancias", "Subcontas", "Revenda", "Suporte enterprise"]);

  for (const legacyName of ["Starter API", "Beta"]) {
    const legacyPlan = await get("SELECT id FROM plans WHERE name = ?", [legacyName]);
    if (!legacyPlan || !testPlanId) continue;
    await run("UPDATE accounts SET plan_id = ? WHERE plan_id = ?", [testPlanId, legacyPlan.id]);
    await run("DELETE FROM plans WHERE id = ?", [legacyPlan.id]);
  }
}

async function ensureDefaultSuperAdmin() {
  const email = String(process.env.WOZAPI_OWNER_EMAIL || "").trim();
  const password = String(process.env.WOZAPI_OWNER_PASSWORD || "");
  const name = String(process.env.WOZAPI_OWNER_NAME || "Wozapi Owner").trim();
  const accountName = String(process.env.WOZAPI_OWNER_ACCOUNT_NAME || "Wozapi Owner").trim();
  if (!email || !password) {
    return;
  }
  const passwordHash = hashPassword(password);

  const existingUser = await get("SELECT id, account_id FROM users WHERE lower(email) = lower(?)", [email]);
  if (existingUser?.id) {
    const accountId = Number(existingUser.account_id || 0);
    if (accountId) {
      await run(
        "UPDATE accounts SET account_type = ?, status = ?, owner_name = ?, owner_email = ?, email = COALESCE(email, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        ["owner", "active", name, email, email, accountId]
      );
    }
    await run(
      "UPDATE users SET name = ?, email = ?, password = ?, role = ?, status = ? WHERE id = ?",
      [name, email, passwordHash, "super_admin", "active", existingUser.id]
    );
    return;
  }

  const existingAccount = await get("SELECT id FROM accounts WHERE lower(owner_email) = lower(?) OR lower(email) = lower(?)", [email, email]);
  let accountId = Number(existingAccount?.id || 0);
  if (accountId) {
    await run(
      "UPDATE accounts SET name = COALESCE(name, ?), account_type = ?, status = ?, owner_name = ?, owner_email = ?, email = COALESCE(email, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [accountName, "owner", "active", name, email, email, accountId]
    );
  } else {
    const account = await run(
      "INSERT INTO accounts (name, account_type, instance_quota, max_client_accounts, owner_name, owner_email, email, status, billing_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [accountName, "owner", 999, 999, name, email, email, "active", "active"]
    );
    accountId = Number(account.lastInsertRowid);
  }

  await run(
    "INSERT INTO users (account_id, name, email, password, role, status) VALUES (?, ?, ?, ?, ?, ?)",
    [accountId, name, email, passwordHash, "super_admin", "active"]
  );
}

async function deleteExpiredTrialAccounts() {
  const expiredAccounts = await query(
    "SELECT id FROM accounts WHERE status = 'trial' AND trial_ends_at IS NOT NULL AND trial_ends_at <= datetime('now')"
  );
  for (const account of expiredAccounts) {
    const accountId = Number(account.id);
    if (!accountId) continue;

    await audit(accountId, null, "trial.account.auto_deleted", {
      reason: "Teste de 1 hora expirado",
      deleted_at: new Date().toISOString()
    });

    await run(
      "UPDATE instances SET status = ?, connection_status = ?, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE account_id = ? AND deleted_at IS NULL",
      ["disconnected", "disconnected", accountId]
    ).catch(() => null);

    const accountScopedTables = [
      "campaign_recipients",
      "campaigns",
      "lead_custom_fields",
      "lead_tags",
      "lead_notes",
      "leads",
      "messages",
      "conversations",
      "quick_replies",
      "schedules",
      "team_members",
      "llm_credentials",
      "agents",
      "integration_sessions",
      "integration_settings",
      "webhook_delivery_logs",
      "webhook_events",
      "instance_webhooks",
      "wooapi_events",
      "api_request_logs",
      "connection_logs",
      "message_logs",
      "support_alerts",
      "instances",
      "usage_events",
      "audit_logs"
    ];

    for (const table of accountScopedTables) {
      try {
        await run(`DELETE FROM ${table} WHERE account_id = ?`, [accountId]);
      } catch (error) {
        console.error(`Trial cleanup failed for ${table}:`, error);
      }
    }

    await run("DELETE FROM support_sessions WHERE target_account_id = ?", [accountId]).catch(() => null);
    await run("DELETE FROM users WHERE account_id = ?", [accountId]);
    await run("DELETE FROM accounts WHERE id = ?", [accountId]);
    console.log(`[TRIAL_CLEANUP] Conta teste ${accountId} excluida automaticamente.`);
  }
}

async function startServer() {
  await migrate();
  await ensureDefaultCommercialPlans();
  await ensureDefaultSuperAdmin();
  assertProductionReady();
  const storedAdminToken = await get("SELECT setting_value FROM system_settings WHERE setting_key = ?", ["wooapi_admin_token"]);
  let runtimeUazAdminToken = String(storedAdminToken?.setting_value || WOOAPI_ADMIN_TOKEN || "");
  if (isStripeConfigured()) {
    syncPlansToStripe().catch((err: any) => console.error("Stripe sync error:", err));
  }
  deleteExpiredTrialAccounts().catch((err: any) => console.error("Trial cleanup error:", err));
  checkExpiredTrials().catch((err: any) => console.error("Trial expiry check error:", err));

  const app = express();
  const httpServer = createServer(app);

  const instanceWsServer = new WebSocketServer({ noServer: true });
  const instanceWsClients = new Map<number, Set<import("ws").WebSocket>>();

  httpServer.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url || "", "http://localhost");
      const match = url.pathname.match(/^\/ws\/instance\/(.+)$/);
      if (match) {
        const clientIP = request.socket?.remoteAddress || "unknown";
        if (!check("ws-upgrade", clientIP, 20, 60_000)) {
          socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
          socket.destroy();
          return;
        }
        instanceWsServer.handleUpgrade(request, socket, head, (ws) => {
          instanceWsServer.emit("connection", ws, match[1]);
        });
      }
    } catch {
      socket.destroy();
    }
  });

  instanceWsServer.on("connection", async (ws, apiKey: string) => {
    const authTimeout = setTimeout(() => {
      ws.close(4002, "Auth timeout");
    }, 5000);

    let authTimer: ReturnType<typeof setInterval> | null = null;
    try {
      const inst = await get(`
        SELECT instances.id, instances.account_id, accounts.status AS account_status
        FROM instances LEFT JOIN accounts ON accounts.id = instances.account_id
        WHERE instances.api_key = ? AND instances.deleted_at IS NULL
      `, [apiKey]);
      clearTimeout(authTimeout);
      if (!inst || inactiveAccountStatuses.has(String(inst.account_status || ""))) {
        ws.close(4001, "Unauthorized");
        return;
      }
      const instanceId = Number(inst.id);
      const clients = instanceWsClients.get(instanceId) || new Set();
      clients.add(ws);
      instanceWsClients.set(instanceId, clients);
      ws.send(JSON.stringify({ event: "connection.status", data: { status: "connected", instanceId } }));
      ws.on("close", () => {
        clients.delete(ws);
        if (!clients.size) instanceWsClients.delete(instanceId);
        if (authTimer) clearInterval(authTimer);
      });
      ws.on("error", () => {
        clients.delete(ws);
        if (authTimer) clearInterval(authTimer);
      });
      authTimer = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          ws.ping();
        } else {
          clearInterval(authTimer!);
          authTimer = null;
        }
      }, 30000);
    } catch {
      clearTimeout(authTimeout);
      ws.close(4003, "Auth error");
    }
  });

  function emitInstanceWs(instanceId: number, event: string, data: any) {
    const clients = instanceWsClients.get(instanceId);
    if (!clients?.size) return;
    const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
    for (const ws of clients) {
      try { ws.send(message); } catch { clients.delete(ws); }
    }
  }

  function receiptDeliveryStatus(receiptType: any) {
    const type = String(receiptType || "").toLowerCase();
    if (!type || type === "delivered") return "delivered";
    if (["read", "read-self", "played", "played-self"].includes(type)) return "read";
    if (["retry", "server-error", "inactive"].includes(type)) return "failed";
    if (["sender", "peer_msg", "hist_sync"].includes(type)) return null;
    return null;
  }

  function deliveryStatusRank(status: any) {
    const ranks: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4, received: 4 };
    return ranks[String(status || "")] ?? 0;
  }

  app.disable("x-powered-by");
  const allowedOrigins = parseAllowedOrigins(CORS_ORIGIN);
  const socketCorsOrigin = allowedOrigins.includes("*")
    ? (process.env.NODE_ENV === "production" ? false : "*")
    : allowedOrigins;
  const io = new Server(httpServer, {
    cors: { origin: socketCorsOrigin },
    pingInterval: 25000,
    pingTimeout: 30000
  });
  realtimeIo = io;
  const upload = multer({
    dest: uploadDir,
    limits: { fileSize: MAX_UPLOAD_SIZE_MB * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = safeUploadExtension(file.originalname || "");
      if (ext && allowedUploadMimeTypes.has(file.mimetype)) return cb(null, true);
      cb(new Error(`Tipo de arquivo nao permitido: ${file.mimetype || "desconhecido"}`));
    }
  });

  app.use(securityHeaders);
  app.use(cors(corsOptions()));
  app.use(bodyParser.json({ limit: "10mb" }));
  app.use("/uploads", express.static(uploadDir, {
    setHeaders(res) {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=3600");
    }
  }));

  app.post("/api/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = String(req.headers["stripe-signature"] || "");
    const result = await handleStripeWebhook(JSON.stringify(req.body), sig);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    return res.json(result);
  });

  app.get("/health", async (_req, res) => {
    let redisHost = process.env.REDIS_HOST || (process.env.NODE_ENV === "production" ? "redis" : "127.0.0.1");
    let redisPort = Number(process.env.REDIS_PORT || 6379);
    try {
      if (process.env.REDIS_URL) {
        const redisUrl = new URL(process.env.REDIS_URL);
        redisHost = redisUrl.hostname || redisHost;
        redisPort = Number(redisUrl.port || redisPort);
      }
    } catch {}
    const [bridgeOk, redisOk] = await Promise.all([
      fetch(`${BRIDGE_URL}/health`).then((response) => response.ok).catch(() => false),
      tcpReachable(redisHost, redisPort)
    ]);
    const readiness = productionReadiness();
    res.status(bridgeOk ? 200 : 503).json({
      ok: bridgeOk,
      name: "Wozapi",
      database: DATABASE_URL ? "postgresql_configured" : "sqlite",
      bridge: bridgeOk ? "available" : "unavailable",
      redis: redisOk ? "available" : "unavailable",
      queue_driver: QUEUE_DRIVER,
      queues: redisOk || QUEUE_DRIVER === "database" ? "available" : "degraded",
      production_ready: readiness.ready,
      production_blockers: readiness.failed.map((item) => ({ key: item.key, message: item.message })),
      timestamp: new Date().toISOString()
    });
  });
  app.get("/docs/wozapi", async (_req, res) => res.type("html").sendFile(path.resolve("docs/wooapi-public.html")));
  app.get("/docs/wooapi", async (_req, res) => res.redirect("/docs/wozapi"));
  app.get("/wooapi", async (_req, res) => res.type("html").sendFile(path.resolve("docs/wooapi-sales.html")));
  app.get("/wozapi", async (_req, res) => res.redirect("/wooapi"));
  app.get("/vendas", async (_req, res) => res.redirect("/wooapi"));
  app.get("/docs/wooapi-api.md", async (_req, res) => res.sendFile(path.resolve("docs/wooapi-api.md")));
  app.get("/docs/production-readiness.md", async (_req, res) => res.sendFile(path.resolve("docs/production-readiness.md")));
  app.get("/terms", async (_req, res) => res.type("text/markdown").sendFile(path.resolve("docs/terms.md")));
  app.get("/postman/wooapi.postman_collection.json", async (_req, res) => res.sendFile(path.resolve("docs/wooapi.postman_collection.json")));
  app.get("/openapi.json", async (_req, res) => res.sendFile(path.resolve("docs/openapi.json")));
  app.get("/r/:code", async (req, res) => {
    const code = String(req.params.code || "").trim();
    const partner = code ? await get("SELECT id FROM partners WHERE referral_code = ? AND status = 'active'", [code]).catch(() => null) : null;
    const target = partner ? `/?ref=${encodeURIComponent(code)}` : "/";
    return res.redirect(target);
  });
  app.get("/docs", async (_req, res) => res.type("html").send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wozapi - OpenAPI</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div style="padding:12px 20px;background:#0f172a;color:white;font-family:system-ui"><strong>Wozapi</strong> <a href="/docs/wozapi" style="color:#86efac;margin-left:18px">Documentacao publica</a> <a href="/postman/wooapi.postman_collection.json" style="color:#86efac;margin-left:18px">Postman</a></div><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui",deepLinking:true,displayRequestDuration:true,persistAuthorization:true});</script></body></html>`));

  const inactiveAccountStatuses = new Set(["paused", "blocked", "expired", "cancelled"]);
  const accountTypes = new Set(["owner", "reseller", "client"]);
  const accountStatuses = new Set(["active", "paused", "blocked", "trial", "expired", "cancelled"]);
  function publicSuccess(res: express.Response, data: any = {}, message = "Operação realizada com sucesso") {
    return res.json({ success: true, message, data });
  }

  function publicError(res: express.Response, status: number, code: string, message: string, details: any = {}) {
    return res.status(status).json({ success: false, code, message, details });
  }

  function maskSecret(value?: string | null) {
    const raw = String(value || "");
    if (!raw) return "";
    if (raw.length <= 8) return "********";
    return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
  }

  function normalizeExternalPath(pathValue?: string | null, fallback = "/") {
    const value = String(pathValue || fallback).trim();
    return value.startsWith("/") ? value : `/${value}`;
  }

  function buildExternalUrl(baseUrl: string, pathValue: string) {
    return `${String(baseUrl || "").replace(/\/+$/, "")}${normalizeExternalPath(pathValue)}`;
  }

  async function externalIntegrationRequest(integration: any, pathValue: string, options: any = {}) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      [String(integration.auth_header || "apikey")]: `${integration.auth_prefix || ""}${integration.admin_key}`
    };
    const response = await fetch(buildExternalUrl(integration.base_url, pathValue), {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await response.text();
    let data: any = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 1000) };
    }
    if (!response.ok) {
      const message = data?.message || data?.error || `Sistema externo respondeu HTTP ${response.status}`;
      const error: any = new Error(String(message));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function partnerReferralLink(code: string) {
    return `${APP_URL.replace(/\/+$/, "")}/r/${encodeURIComponent(code)}`;
  }

  function referralCodeFromName(name: string) {
    const slug = String(name || "parceiro")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "parceiro";
    return `${slug}-${crypto.randomBytes(3).toString("hex")}`;
  }

  async function recordPartnerReferral(accountId: number, rawCode?: string | null, source = "signup", metadata: any = {}) {
    const referralCode = String(rawCode || "").trim();
    if (!accountId || !referralCode) return null;
    const partner: any = await get("SELECT * FROM partners WHERE referral_code = ? AND status = 'active'", [referralCode]);
    if (!partner?.id) return null;
    await run("UPDATE accounts SET referred_partner_id = ?, referral_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [partner.id, referralCode, accountId]).catch(() => null);
    const existing = await get("SELECT id FROM partner_referrals WHERE partner_id = ? AND account_id = ?", [partner.id, accountId]);
    if (!existing) {
      await run(
        "INSERT INTO partner_referrals (partner_id, account_id, referral_code, source, status, metadata_json) VALUES (?, ?, ?, ?, ?, ?)",
        [partner.id, accountId, referralCode, source, "converted", JSON.stringify(metadata || {})]
      );
      await run(
        "INSERT INTO partner_commissions (partner_id, account_id, amount, status, description) VALUES (?, ?, 0, 'pending', ?)",
        [partner.id, accountId, `Conta indicada criada: ${metadata?.email || `#${accountId}`}`]
      ).catch(() => null);
    }
    return partner;
  }

  function normalizeLogRow(source: string, row: any) {
    const rawDetails = parseJsonObject(row.details_json || row.metadata || row.request_payload || "{}");
    const details = JSON.parse(JSON.stringify(rawDetails).replace(/uazapi/gi, "wooapi"));
    return {
      ...row,
      source,
      details,
      details_json: row.details_json ? JSON.stringify(details) : row.details_json,
      success: row.success === undefined ? undefined : Number(row.success || 0) === 1
    };
  }

  async function getMergedLiveLogs(options: { accountId?: number | null; instanceId?: number | null; limit?: number } = {}) {
    const limit = Math.min(Math.max(Number(options.limit || 100), 1), 300);
    const instanceFilter = options.instanceId ? " AND instance_id = ?" : "";
    const accountFilter = options.accountId ? " AND account_id = ?" : "";
    const params = (extra: any[] = []) => [
      ...(options.accountId ? [options.accountId] : []),
      ...(options.instanceId ? [options.instanceId] : []),
      ...extra
    ];
    const [connections, messages, webhooks, api, alerts] = await Promise.all([
      query(`SELECT id, account_id, instance_id, event, status, details_json, created_at FROM connection_logs WHERE 1=1${accountFilter}${instanceFilter} ORDER BY id DESC LIMIT ?`, params([limit])),
      query(`SELECT id, account_id, instance_id, message_id, direction, status, details_json, created_at FROM message_logs WHERE 1=1${accountFilter}${instanceFilter} ORDER BY id DESC LIMIT ?`, params([limit])),
      query(`SELECT id, account_id, instance_id, event, status_code, success, attempt, error, duration_ms, created_at FROM webhook_delivery_logs WHERE 1=1${accountFilter}${instanceFilter} ORDER BY id DESC LIMIT ?`, params([limit])),
      query(`SELECT id, account_id, instance_id, method, path, status_code, error, duration_ms, created_at FROM api_request_logs WHERE 1=1${accountFilter}${instanceFilter} ORDER BY id DESC LIMIT ?`, params([limit])),
      query(`SELECT id, account_id, instance_id, severity, type, title, description, status, metadata, opened_at AS created_at FROM support_alerts WHERE 1=1${accountFilter}${instanceFilter} ORDER BY id DESC LIMIT ?`, params([limit]))
    ]);
    return [
      ...connections.map((row) => normalizeLogRow("connection", row)),
      ...messages.map((row) => normalizeLogRow("message", row)),
      ...webhooks.map((row) => normalizeLogRow("webhook", row)),
      ...api.map((row) => normalizeLogRow("api", row)),
      ...alerts.map((row) => normalizeLogRow("alert", row))
    ]
      .sort((a: any, b: any) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, limit);
  }

  async function addSupportTicketMessage(ticketId: number, accountId: number, userId: number | null, sender: string, message: string, metadata: any = {}) {
    const info = await run(
      "INSERT INTO support_ticket_messages (ticket_id, account_id, user_id, sender, message, metadata) VALUES (?, ?, ?, ?, ?, ?)",
      [ticketId, accountId, userId, sender, message, JSON.stringify(metadata)]
    );
    const row = await get("SELECT * FROM support_ticket_messages WHERE id = ?", [info.lastInsertRowid]);
    io.to(`account:${accountId}`).emit("support.ticket.message", row);
    io.to("admin:monitor").emit("support.ticket.message", row);
    return row;
  }

  async function createSupportTicket(input: { accountId: number; instanceId?: number | null; alertId?: number | null; subject: string; priority?: string; source?: string; aiSummary?: string; firstMessage?: string; userId?: number | null }) {
    const info = await run(
      "INSERT INTO support_tickets (account_id, instance_id, alert_id, subject, status, priority, source, ai_summary, escalated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
      [input.accountId, input.instanceId || null, input.alertId || null, input.subject, "open", input.priority || "normal", input.source || "support_chat", input.aiSummary || null]
    );
    const ticket = await get("SELECT * FROM support_tickets WHERE id = ?", [info.lastInsertRowid]);
    if (input.firstMessage) {
      await addSupportTicketMessage(Number(info.lastInsertRowid), input.accountId, input.userId || null, "customer", input.firstMessage, { source: input.source || "support_chat" });
    }
    io.to(`account:${input.accountId}`).emit("support.ticket.created", ticket);
    io.to("admin:monitor").emit("support.ticket.created", ticket);
    return ticket;
  }

  async function supportAgentReply(input: { accountId: number; instanceId?: number | null; message: string; userId?: number | null }) {
    const raw = String(input.message || "").trim();
    const text = raw.toLowerCase();
    const wantsHuman = /(humano|atendente|urgente|ticket|escalar|n[aã]o resolveu|nao resolveu|continua|abrir chamado)/i.test(raw);
    const inst = input.instanceId
      ? await get("SELECT id, name, status, connection_status, last_error, phone_connected, updated_at FROM instances WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [input.instanceId, input.accountId])
      : await get("SELECT id, name, status, connection_status, last_error, phone_connected, updated_at FROM instances WHERE account_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT 1", [input.accountId]);
    const logs = inst?.id ? await getMergedLiveLogs({ accountId: input.accountId, instanceId: Number(inst.id), limit: 10 }) : [];
    const status = publicInstanceStatus(inst?.connection_status || inst?.status || "unknown");
    const disconnected = ["disconnected", "logged_out", "close", "error", "blocked"].includes(status);
    const hasFailures = logs.some((log: any) => ["failed", "error"].includes(String(log.status || "").toLowerCase()) || log.success === false || Number(log.status_code || 200) >= 400);

    let reply = "";
    let resolved = false;
    let nextAction = "diagnostic";

    if (/qr|conectar|desconect|sess[aã]o|session/i.test(raw) || disconnected) {
      reply = inst
        ? `Analisei a instancia ${inst.name}. O status atual esta como ${status}. Recomendo abrir a instancia, gerar um novo QR se aparecer como desconectada e aguardar o status conectado antes de testar envio. Se o QR expirar ou a sessao ficar presa, use sair/limpar sessao e conecte novamente.`
        : "Nao encontrei uma instancia vinculada a esta conta. Crie ou selecione uma instancia antes de conectar.";
      resolved = Boolean(inst && isConnectedInstanceStatus(status));
      nextAction = resolved ? "answered_connected" : "reconnect_instance";
    } else if (/webhook|n8n|entrega|callback/i.test(raw)) {
      reply = hasFailures
        ? "Encontrei falhas recentes nos logs. Verifique se a URL responde HTTP 2xx, se nao bloqueia o IP do servidor e se o endpoint aceita POST JSON. Depois use Reenviar no log de entrega."
        : "Nao encontrei falha recente de webhook nesta instancia. O proximo passo e enviar um evento de teste pelo painel e conferir se o destino registra a chamada.";
      resolved = !hasFailures;
      nextAction = hasFailures ? "check_webhook_destination" : "send_webhook_test";
    } else if (/mensagem|envio|delay|lento|chega|telefone|numero/i.test(raw)) {
      reply = disconnected
        ? "A instancia nao esta pronta para envio. Primeiro reconecte e aguarde o status conectado; depois teste uma mensagem simples para o proprio numero e para um numero externo."
        : "A instancia parece apta para envio. Para atraso, valide formato do numero com DDI/DDD, evite envio em massa imediato e acompanhe os logs da instancia. Mensagens interativas oficiais podem cair para texto/link quando o canal nao suporta botoes nativos.";
      resolved = !disconnected && !hasFailures;
      nextAction = disconnected ? "reconnect_instance" : "test_text_message";
    } else {
      reply = "Vou tentar resolver por diagnostico. Abra a instancia afetada, confira o status em tempo real, envie uma mensagem simples de teste e depois veja se existe erro em Logs. Se me disser se o problema e conexao, envio, webhook ou cobranca, eu sigo direto no ponto certo.";
      resolved = false;
    }

    await run(
      "INSERT INTO support_ai_actions (account_id, instance_id, action, status, details_json) VALUES (?, ?, ?, ?, ?)",
      [input.accountId, inst?.id || input.instanceId || null, nextAction, resolved ? "resolved_or_guided" : "needs_more_info", JSON.stringify({ status, hasFailures, logsChecked: logs.length })]
    );

    if (wantsHuman && !resolved) {
      const ticket = await createSupportTicket({
        accountId: input.accountId,
        instanceId: inst?.id || input.instanceId || null,
        subject: raw.slice(0, 90) || "Atendimento escalado",
        priority: /urgente|parado|producao|produção/i.test(raw) ? "high" : "normal",
        source: "support_chat",
        aiSummary: `Agente tentou diagnosticar. Acao sugerida: ${nextAction}. Status: ${status}.`,
        firstMessage: raw,
        userId: input.userId || null
      });
      const escalatedReply = `${reply}\n\nComo voce pediu atendimento humano ou o problema continua, abri o ticket #${ticket?.id}. O time consegue ver os logs e assumir daqui.`;
      await addSupportTicketMessage(Number(ticket?.id), input.accountId, null, "ai", escalatedReply, { escalated: true, nextAction });
      return { reply: escalatedReply, resolved: false, escalated: true, ticket };
    }

    return { reply, resolved, escalated: false, instance: inst || null, diagnostics: { status, hasFailures, logsChecked: logs.length, nextAction } };
  }

  function safeBackupId(value: string) {
    return String(value || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  }

  function copyIfExists(source: string, destination: string) {
    if (!fs.existsSync(source)) return false;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
    return true;
  }

  async function createOperationalBackup(requestedBy?: number | null) {
    const id = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const dir = path.join(BACKUP_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const sqlitePath = path.join(dataDir, process.env.SQLITE_FILENAME || "database.db");
    const bridgeDbPath = path.resolve(process.env.BRIDGE_DB_PATH || path.join(dataDir, "wooapi_bridge.db"));
    const bridgeMediaPath = path.resolve(process.env.BRIDGE_MEDIA_CACHE_DIR || path.join(process.cwd(), "go-bridge", "media-cache"));
    const copied = {
      sqlite: !DATABASE_URL && copyIfExists(sqlitePath, path.join(dir, "database.db")),
      sqliteWal: !DATABASE_URL && copyIfExists(`${sqlitePath}-wal`, path.join(dir, "database.db-wal")),
      sqliteShm: !DATABASE_URL && copyIfExists(`${sqlitePath}-shm`, path.join(dir, "database.db-shm")),
      bridgeDb: copyIfExists(bridgeDbPath, path.join(dir, "wooapi_bridge.db")),
      bridgeWal: copyIfExists(`${bridgeDbPath}-wal`, path.join(dir, "wooapi_bridge.db-wal")),
      bridgeShm: copyIfExists(`${bridgeDbPath}-shm`, path.join(dir, "wooapi_bridge.db-shm")),
      mediaCache: copyIfExists(bridgeMediaPath, path.join(dir, "media-cache"))
    };
    const manifest = {
      id,
      created_at: new Date().toISOString(),
      requested_by: requestedBy || null,
      database: DATABASE_URL ? "postgresql_external_backup_required" : "sqlite_copied",
      copied,
      restore: DATABASE_URL
        ? "Restore database from your PostgreSQL/Supabase backup, then restore bridge DB/media-cache from this folder."
        : "Use POST /api/admin/backups/:id/restore with ALLOW_RESTORE=true while services are stopped or in maintenance."
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    return manifest;
  }

  function sanitizePublicError(error: any) {
    const raw = String(error?.message || error || "");
    if (!raw) return "Operação não concluída";
    if (/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR|socket hang up|connect ECONN/i.test(raw)) {
      return "WooAPI Core offline. Inicie o bridge na porta 3001 e tente gerar o QR novamente.";
    }
    if (/token|secret|sqlite|database|stack|trace|bridge|internal|core|go\.mau|whatsmeow/i.test(raw)) {
      return "Operação não concluída pelo WooAPI Core";
    }
    return raw.slice(0, 180).trim();
  }

  function accountCanOperate(account: any) {
    if (!account || inactiveAccountStatuses.has(String(account.status || "active"))) return false;
    if (String(account.status || "") === "trial" && account.trial_ends_at && new Date(account.trial_ends_at).getTime() <= Date.now()) {
      return false;
    }
    return true;
  }

  async function getAccountFeatureFlags(accountId: number) {
    const plan = await getAccountPlan(accountId);
    return {
      api: Number(plan.api_enabled ?? 1) === 1,
      webhook: Number(plan.webhook_enabled ?? 1) === 1,
      websocket: Number(plan.websocket_enabled ?? 1) === 1,
      chatwoot: Number(plan.chatwoot_enabled ?? 1) === 1,
      typebot: Number(plan.typebot_enabled ?? 1) === 1,
      n8n: Number(plan.n8n_enabled ?? 1) === 1
    };
  }

  function serializeInstance(inst: any) {
    if (!inst) return null;
    const connected = isConnectedInstanceStatus(inst.connection_status || inst.status);
    return {
      id: inst.id,
      account_id: inst.account_id,
      name: inst.name,
      phone: connected ? (inst.phone || inst.phone_connected) : null,
      phone_connected: connected ? (inst.phone_connected || inst.phone) : null,
      jid: connected ? inst.jid : null,
      profile_name: connected ? inst.profile_name : null,
      profileName: connected ? inst.profile_name : null,
      profile_picture_url: connected ? inst.profile_picture_url : null,
      profilePictureUrl: connected ? inst.profile_picture_url : null,
      status: publicInstanceStatus(inst.status),
      connection_status: publicInstanceStatus(inst.connection_status || inst.status),
      webhook_url: inst.webhook_url,
      webhook_endpoint: instanceWebhookEndpoints(inst.id).webhooks_url,
      webhook: instanceWebhookPackage(inst),
      webhook_enabled: Number(inst.webhook_enabled ?? 1) === 1,
      webhook_events: parseJsonList(inst.webhook_events),
      websocket_enabled: Number(inst.websocket_enabled ?? 1) === 1,
      last_qr_at: inst.last_qr_at,
      connected_at: inst.connected_at,
      disconnected_at: inst.disconnected_at,
      last_seen_at: inst.last_seen_at,
      created_at: inst.created_at,
      updated_at: inst.updated_at
    };
  }

  async function requireV1Account(req: express.Request, res: express.Response) {
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : String(req.headers["x-auth-token"] || "");
    const payload = verifyToken(token);
    if (!payload?.accountId) {
      publicError(res, 401, "AUTH_REQUIRED", "Token da conta obrigatório");
      return null;
    }
    const account = await get("SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL", [payload.accountId]);
    if (!accountCanOperate(account) && payload.role !== "super_admin") {
      publicError(res, 403, "ACCOUNT_RESTRICTED", "Conta sem permissão para executar esta operação");
      return null;
    }
    if (payload.role !== "super_admin") {
      const billingError = await enforceBilling(account);
      if (billingError) {
        publicError(res, 402, "BILLING_REQUIRED", billingError);
        return null;
      }
    }
    return { payload, account, accountId: Number(payload.accountId) };
  }

  function createMailer() {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
    return nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }

  async function sendDisconnectNotification(instanceId: number, accountId: number, status: string) {
    try {
      const account = await get("SELECT owner_name, owner_email, name, phone FROM accounts WHERE id = ?", [accountId]);
      const instance = await get("SELECT name FROM instances WHERE id = ?", [instanceId]);
      if (!account) return;

      const instName = instance?.name || `Instancia #${instanceId}`;
      const appUrl = APP_URL || "https://painel.wozapi.com.br";

      if (account.owner_email && SMTP_HOST) {
        const mailer = createMailer();
        if (mailer) {
          await mailer.sendMail({
            from: SMTP_FROM,
            to: account.owner_email,
            subject: `[WooAPI] Instancia "${instName}" desconectada`,
            html: `
              <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
                <h2 style="color:#dc2626">Instancia desconectada</h2>
                <p>Ola <strong>${account.owner_name || account.name || "Cliente"}</strong>,</p>
                <p>A instancia <strong>${instName}</strong> foi desconectada (${status}).</p>
                <p>Nossa equipe ja foi notificada e esta verificando.</p>
                <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
                <p style="font-size:12px;color:#94a3b8">
                  WooAPI Platform - ${appUrl}
                </p>
              </div>
            `,
          });
        }
      }

      if (SUPPORT_INSTANCE_ID && SUPPORT_INSTANCE_JID) {
        try {
          await bridgeFetch(`/instances/${SUPPORT_INSTANCE_ID}/send`, {
            method: "POST",
            body: JSON.stringify({
              jid: SUPPORT_INSTANCE_JID,
              text: `[WooAPI] Instancia "${instName}" (#${instanceId}) foi desconectada (${status}). Cliente: ${account.owner_name || account.name || "N/A"}.`,
            }),
          }).catch(() => null);
        } catch (e) {}
      }
    } catch (e) {}
  }

  async function bridgeFetch(pathname: string, options: RequestInit = {}) {
    const baseURL = await bridgeURLForPath(pathname);
    const response = await fetch(`${baseURL}${pathname}`, {
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
    if (!response.ok) {
      const message = data.error || data.message || text || `WooAPI Core error ${response.status}`;
      const error: any = new Error(String(message));
      error.statusCode = response.status;
      error.bridgeData = data;
      throw error;
    }
    return data;
  }

  async function bridgeBinaryFetch(pathname: string, options: RequestInit = {}) {
    const baseURL = await bridgeURLForPath(pathname);
    const response = await fetch(`${baseURL}${pathname}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Token": BRIDGE_TOKEN,
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `WooAPI Core error ${response.status}`);
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") || "application/octet-stream",
      disposition: response.headers.get("content-disposition") || "attachment"
    };
  }

  function mediaExtension(contentType: string, fallback = "bin") {
    const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
    const map: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "video/mp4": "mp4",
      "audio/mpeg": "mp3",
      "audio/ogg": "ogg",
      "audio/wav": "wav",
      "application/pdf": "pdf"
    };
    return map[normalized] || fallback;
  }

  async function storeReceivedMedia(accountId: number, instanceId: number, messageId: string, contentType: string, chatJid: string) {
    if (!messageId) return "";
    try {
      const file = await bridgeBinaryFetch(`/instances/${instanceId}/messages/download`, {
        method: "POST",
        body: JSON.stringify({ account_id: accountId, message_id: messageId, jid: chatJid })
      });
      const ext = mediaExtension(file.contentType);
      const dir = path.join(uploadDir, "received-media", String(accountId), String(instanceId));
      fs.mkdirSync(dir, { recursive: true });
      const fileName = `${safeBackupId(messageId) || Date.now().toString()}.${ext}`;
      fs.writeFileSync(path.join(dir, fileName), file.bytes);
      return `/uploads/received-media/${accountId}/${instanceId}/${fileName}`;
    } catch (error) {
      console.warn("[MEDIA_DOWNLOAD_FAILED]", sanitizePublicError(error));
      return "";
    }
  }

  async function getChatProfile(accountId: number, instanceId: number, jid: string) {
    if (!jid || isIgnoredChatJid(jid)) return { name: "", pictureUrl: "" };
    let groupName = "";
    let groupPictureUrl = "";
    if (jid.endsWith("@g.us")) {
      try {
        const groupData = await bridgeFetch(`/instances/${instanceId}/groups/info`, {
          method: "POST",
          body: JSON.stringify({ account_id: accountId, jid })
        });
        const groupRaw = bridgeResult(groupData);
        const group = normalizeBridgeGroup(groupRaw, jid);
        groupName = group.name || "";
        groupPictureUrl = group.pictureUrl || "";
      } catch {}
    }
    try {
      const data = await bridgeFetch(`/instances/${instanceId}/contacts/info`, {
        method: "POST",
        body: JSON.stringify({ account_id: accountId, jid })
      });
      const result = data?.result || data || {};
      const info = result?.info || data?.info || {};
      const contact = result?.contact || data?.contact || {};
      const picture = result?.picture || data?.picture || {};
      const name = cleanDisplayName(
        result?.Name ||
        result?.name ||
        result?.PushName ||
        result?.pushName ||
        result?.Subject ||
        result?.subject ||
        result?.Topic ||
        result?.topic ||
        info?.Name ||
        info?.name ||
        info?.PushName ||
        info?.pushName ||
        info?.VerifiedName ||
        info?.verifiedName ||
        contact?.FullName ||
        contact?.fullName ||
        contact?.FirstName ||
        contact?.firstName ||
        contact?.PushName ||
        contact?.pushName ||
        data?.name ||
        data?.subject ||
        groupName ||
        ""
      );
      const pictureUrl = extractPictureUrl(picture) || extractPictureUrl(result) || extractPictureUrl(data) || groupPictureUrl;
      return { name, pictureUrl };
    } catch {
      return { name: groupName, pictureUrl: groupPictureUrl };
    }
  }

  async function refreshGroupConversationProfile(accountId: number, conversation: any) {
    const groupJid = String(conversation?.group_jid || "");
    if (!groupJid.endsWith("@g.us")) return conversation;
    const storedGroup = await get(
      "SELECT name, picture_url FROM whatsapp_groups WHERE account_id = ? AND instance_id = ? AND group_jid = ?",
      [accountId, Number(conversation.instance_id), groupJid]
    );
    const storedName = cleanDisplayName(storedGroup?.name);
    const storedPictureUrl = String(storedGroup?.picture_url || "");
    if (storedName || storedPictureUrl) {
      await run(
        "UPDATE conversations SET title = COALESCE(NULLIF(?, ''), title), contact_profile_picture_url = COALESCE(NULLIF(?, ''), contact_profile_picture_url), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ?",
        [storedName, storedPictureUrl, conversation.id, accountId]
      );
      return {
        ...conversation,
        title: storedName || conversation.title,
        contact_profile_picture_url: storedPictureUrl || conversation.contact_profile_picture_url
      };
    }
    const needsProfile = !conversation.contact_profile_picture_url || !conversation.title || String(conversation.title) === groupJid;
    if (!needsProfile) return conversation;
    const profile = await getChatProfile(accountId, Number(conversation.instance_id), groupJid);
    if (!profile.name && !profile.pictureUrl) return conversation;
    await run(
      "UPDATE conversations SET title = COALESCE(NULLIF(?, ''), title), contact_profile_picture_url = COALESCE(NULLIF(?, ''), contact_profile_picture_url), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ?",
      [profile.name, profile.pictureUrl, conversation.id, accountId]
    );
    return {
      ...conversation,
      title: profile.name || conversation.title,
      contact_profile_picture_url: profile.pictureUrl || conversation.contact_profile_picture_url
    };
  }

  async function callAdvancedBridge(inst: any, endpoint: string, body: any = {}) {
    return bridgeFetch(`/instances/${inst.id}${endpoint}`, {
      method: "POST",
      body: JSON.stringify({ account_id: Number(inst.account_id), ...body })
    });
  }

  function bridgeResult(value: any) {
    return value?.result ?? value?.data ?? value;
  }

  function jidString(value: any) {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (value.String || value.string) return String(value.String || value.string);
    if (value.User || value.user) return `${value.User || value.user}@${value.Server || value.server || "s.whatsapp.net"}`;
    if (value.JID || value.jid) return jidString(value.JID || value.jid);
    return "";
  }

  function extractPictureUrl(value: any): string {
    if (!value) return "";
    if (typeof value === "string") return value;
    return String(
      value.URL ||
      value.url ||
      value.PictureURL ||
      value.pictureURL ||
      value.pictureUrl ||
      value.picture_url ||
      value.ProfilePictureURL ||
      value.profilePictureURL ||
      value.profilePictureUrl ||
      value.profile_picture_url ||
      value.ThumbnailURL ||
      value.thumbnailURL ||
      value.thumbnailUrl ||
      value.preview ||
      ""
    );
  }

  function normalizeGroupParticipant(participant: any) {
    const jid = jidString(participant?.JID || participant?.jid || participant?.ID || participant?.id || participant);
    return {
      jid,
      phone: normalizePhone(jid),
      name: cleanDisplayName(participant?.Name || participant?.name || participant?.PushName || participant?.pushName || ""),
      isAdmin: Number(Boolean(participant?.IsAdmin || participant?.isAdmin || participant?.Admin || participant?.admin || participant?.IsSuperAdmin || participant?.isSuperAdmin))
    };
  }

  function normalizeBridgeGroup(raw: any, fallbackJid = "") {
    const jid = jidString(raw?.JID || raw?.jid || raw?.ID || raw?.id || raw?.GroupJID || raw?.groupJid || fallbackJid);
    const participants = Array.isArray(raw?.Participants || raw?.participants)
      ? (raw.Participants || raw.participants).map(normalizeGroupParticipant).filter((item: any) => item.jid)
      : [];
    const picture = raw?.Picture || raw?.picture || raw?.ProfilePicture || raw?.profilePicture || raw?.Photo || raw?.photo || {};
    return {
      jid,
      name: cleanDisplayName(raw?.Name || raw?.name || raw?.Subject || raw?.subject || raw?.Topic || raw?.topic || ""),
      topic: String(raw?.Topic || raw?.topic || raw?.Description || raw?.description || ""),
      ownerJid: jidString(raw?.OwnerJID || raw?.ownerJID || raw?.Owner || raw?.owner),
      participantCount: Number(raw?.ParticipantCount || raw?.participantCount || participants.length || 0),
      announce: Number(Boolean(raw?.Announce || raw?.announce || raw?.IsAnnounce || raw?.isAnnounce)),
      locked: Number(Boolean(raw?.Locked || raw?.locked || raw?.IsLocked || raw?.isLocked)),
      pictureUrl: extractPictureUrl(picture) || extractPictureUrl(raw),
      participants
    };
  }

  async function upsertWhatsappGroup(accountId: number, instanceId: number, group: any, raw: any = {}) {
    if (!group?.jid || !group.jid.endsWith("@g.us")) return null;
    const profile = await getChatProfile(accountId, instanceId, group.jid);
    const name = cleanDisplayName(group.name) || profile.name || group.jid;
    const pictureUrl = group.pictureUrl || profile.pictureUrl || "";
    await run(
      `INSERT INTO whatsapp_groups
        (account_id, instance_id, group_jid, name, topic, owner_jid, participant_count, announce, locked, picture_url, raw_json, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(instance_id, group_jid) DO UPDATE SET
        name = excluded.name,
        topic = excluded.topic,
        owner_jid = excluded.owner_jid,
        participant_count = excluded.participant_count,
        announce = excluded.announce,
        locked = excluded.locked,
        picture_url = COALESCE(NULLIF(excluded.picture_url, ''), whatsapp_groups.picture_url),
        raw_json = excluded.raw_json,
        synced_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP`,
      [accountId, instanceId, group.jid, name, group.topic || "", group.ownerJid || "", group.participantCount || 0, group.announce || 0, group.locked || 0, pictureUrl, JSON.stringify(raw || {})]
    );
    await run(
      "UPDATE conversations SET title = COALESCE(NULLIF(?, ''), title), contact_profile_picture_url = COALESCE(NULLIF(?, ''), contact_profile_picture_url), type = 'group', group_jid = ?, remote_jid = ?, updated_at = CURRENT_TIMESTAMP WHERE account_id = ? AND instance_id = ? AND group_jid = ?",
      [name, pictureUrl, group.jid, group.jid, accountId, instanceId, group.jid]
    );
    for (const participant of group.participants || []) {
      await run(
        `INSERT INTO whatsapp_group_participants
          (account_id, instance_id, group_jid, participant_jid, phone, name, is_admin, raw_json, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(instance_id, group_jid, participant_jid) DO UPDATE SET
          phone = excluded.phone,
          name = COALESCE(NULLIF(excluded.name, ''), whatsapp_group_participants.name),
          is_admin = excluded.is_admin,
          raw_json = excluded.raw_json,
          synced_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP`,
        [accountId, instanceId, group.jid, participant.jid, participant.phone, participant.name, participant.isAdmin, JSON.stringify(participant)]
      );
    }
    return await get("SELECT * FROM whatsapp_groups WHERE account_id = ? AND instance_id = ? AND group_jid = ?", [accountId, instanceId, group.jid]);
  }

  async function syncWhatsappGroups(inst: any) {
    const accountId = Number(inst.account_id);
    const instanceId = Number(inst.id);
    const data = await bridgeFetch(`/instances/${instanceId}/groups?account_id=${accountId}`);
    const groups = Array.isArray(bridgeResult(data)) ? bridgeResult(data) : [];
    const saved: any[] = [];
    for (const raw of groups) {
      const listGroup = normalizeBridgeGroup(raw);
      if (!listGroup.jid) continue;
      let detailRaw = raw;
      try {
        const detail = await callAdvancedBridge(inst, "/groups/info", { jid: listGroup.jid });
        detailRaw = bridgeResult(detail) || raw;
      } catch {}
      const group = normalizeBridgeGroup(detailRaw, listGroup.jid);
      saved.push(await upsertWhatsappGroup(accountId, instanceId, {
        ...listGroup,
        ...group,
        jid: listGroup.jid,
        name: group.name || listGroup.name,
        pictureUrl: group.pictureUrl || listGroup.pictureUrl,
        participants: group.participants?.length ? group.participants : listGroup.participants
      }, detailRaw));
    }
    return saved.filter(Boolean);
  }

  async function accountInstance(accountId: number, instanceId?: any) {
    const id = Number(instanceId || 0);
    if (id) return await get("SELECT * FROM instances WHERE account_id = ? AND id = ? AND deleted_at IS NULL", [accountId, id]);
    return await get("SELECT * FROM instances WHERE account_id = ? AND deleted_at IS NULL ORDER BY id ASC LIMIT 1", [accountId]);
  }

  function moderationMatch(rule: any, input: { text: string; contentType: string }) {
    const pattern = String(rule.pattern || "").trim();
    if (!pattern) return "";
    const text = String(input.text || "");
    const type = String(rule.rule_type || "keyword").toLowerCase();
    if (type === "keyword") return text.toLowerCase().includes(pattern.toLowerCase()) ? pattern : "";
    if (type === "regex") {
      try {
        const match = text.match(new RegExp(pattern, "i"));
        return match?.[0] || "";
      } catch {
        return "";
      }
    }
    if (type === "link") {
      const hasLink = /(https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/)/i.test(text);
      if (!hasLink) return "";
      return pattern === "*" || text.toLowerCase().includes(pattern.toLowerCase()) ? pattern : "";
    }
    if (type === "media") {
      return pattern === "*" || String(input.contentType).toLowerCase() === pattern.toLowerCase() ? input.contentType : "";
    }
    return "";
  }

  async function applyGroupModeration(input: {
    accountId: number;
    instanceId: number;
    groupJid: string;
    participantJid: string;
    messageId: string;
    contentType: string;
    contentText: string;
  }) {
    if (!input.groupJid.endsWith("@g.us") || !input.participantJid || input.participantJid.endsWith("@g.us")) return;
    const inst = await get("SELECT * FROM instances WHERE id = ? AND account_id = ?", [input.instanceId, input.accountId]);
    if (!inst) return;
    const rules = await query(
      "SELECT * FROM group_moderation_rules WHERE account_id = ? AND instance_id = ? AND enabled = 1 AND (group_jid IS NULL OR group_jid = '' OR group_jid = ?) ORDER BY id ASC",
      [input.accountId, input.instanceId, input.groupJid]
    );
    for (const rule of rules as any[]) {
      const matched = moderationMatch(rule, { text: input.contentText, contentType: input.contentType });
      if (!matched) continue;
      const since = new Date(Date.now() - Math.max(1, Number(rule.window_minutes || 60)) * 60000).toISOString();
      const recent = await get(
        "SELECT COUNT(*) AS total FROM group_moderation_events WHERE account_id = ? AND instance_id = ? AND group_jid = ? AND participant_jid = ? AND rule_id = ? AND created_at >= ?",
        [input.accountId, input.instanceId, input.groupJid, input.participantJid, rule.id, since]
      );
      const violations = Number(recent?.total || 0) + 1;
      const threshold = Math.max(1, Number(rule.threshold || 1));
      const action = String(rule.action || "warn");
      let status = violations >= threshold ? "applied" : "logged";
      let error = "";
      const warningText = String(rule.warning_text || `Regra do grupo violada: ${rule.name || rule.pattern}`).trim();
      try {
        if (violations >= threshold) {
          if (["warn", "warn_and_remove"].includes(action) && warningText) {
            await sendWhatsAppMessage(input.instanceId, input.accountId, input.groupJid, warningText);
          }
          if (["delete_message", "warn_and_remove"].includes(action)) {
            await callAdvancedBridge(inst, "/messages/delete", { jid: input.groupJid, message_id: input.messageId, sender: input.participantJid });
          }
          if (["remove_participant", "warn_and_remove"].includes(action)) {
            await callAdvancedBridge(inst, "/groups/participants", { jid: input.groupJid, participants: [input.participantJid], action: "remove" });
          }
        }
      } catch (err: any) {
        status = "failed";
        error = sanitizePublicError(err);
      }
      await run(
        "INSERT INTO group_moderation_events (account_id, instance_id, group_jid, participant_jid, message_id, rule_id, action, matched_text, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [input.accountId, input.instanceId, input.groupJid, input.participantJid, input.messageId, rule.id, action, matched, status, error]
      );
      await dispatchWebhook(input.instanceId, "group.moderation.triggered", {
        group_jid: input.groupJid,
        participant_jid: input.participantJid,
        message_id: input.messageId,
        rule_id: rule.id,
        rule_name: rule.name,
        action,
        matched,
        status,
        error
      }).catch(() => null);
      if (status === "applied" && ["remove_participant", "warn_and_remove", "delete_message"].includes(action)) break;
    }
  }

  async function persistAdvancedBridgeOperation(inst: any, endpoint: string, body: any, response: any) {
    try {
      const accountId = Number(inst.account_id);
      const instanceId = Number(inst.id);
      const result = response?.result ?? response ?? {};
      const providerMessageId = String(result?.ID || result?.id || result?.messageID || "").trim();
      const targetJid = String(body?.jid || resolveUazTargetJid(body || {}) || "").trim();

      const outboundTypes: Record<string, { contentType: string; text: string }> = {
        "/send-location": {
          contentType: "location",
          text: [body?.name, body?.address].filter(Boolean).join(" - ") || `${body?.latitude},${body?.longitude}`
        },
        "/send-contact": {
          contentType: "contact",
          text: [body?.name, body?.phone].filter(Boolean).join(" - ") || "Contato"
        },
        "/send-reply": {
          contentType: "text",
          text: String(body?.text || "")
        }
      };
      const outbound = outboundTypes[endpoint];
      if (outbound && providerMessageId && targetJid) {
        const conversation = await ensureConversation(accountId, instanceId, targetJid);
        await run(
          "INSERT INTO messages (account_id, instance_id, conversation_id, direction, chat_type, content_type, content_text, message_id, delivery_status, from_me, sender, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            accountId,
            instanceId,
            conversation?.id,
            "outbound",
            conversation?.type || "contact",
            outbound.contentType,
            outbound.text,
            providerMessageId,
            "sent",
            1,
            "api",
            JSON.stringify({ endpoint, targetJid, ...body })
          ]
        );
        await logMessage(accountId, instanceId, providerMessageId, "outbound", "sent", {
          source: "advanced_api",
          contentType: outbound.contentType,
          replyTo: body?.message_id || null
        });
        const payload = {
          message_id: providerMessageId,
          jid: targetJid,
          type: outbound.contentType,
          text: outbound.text,
          reply_to: body?.message_id || null
        };
        emitUazSse(instanceId, "messages", { ...payload, id: providerMessageId, chatid: targetJid, fromMe: true });
        await dispatchWebhook(instanceId, "message.sent", payload).catch(() => null);
        return;
      }

      const targetMessageId = String(body?.message_id || "").trim();
      if (!targetMessageId) return;
      if (endpoint === "/messages/edit") {
        await run(
          "UPDATE messages SET content_text = ?, raw_json = ? WHERE account_id = ? AND instance_id = ? AND message_id = ?",
          [String(body?.text || ""), JSON.stringify({ action: "edited", providerMessageId }), accountId, instanceId, targetMessageId]
        );
        await dispatchWebhook(instanceId, "message.edited", {
          message_id: targetMessageId,
          provider_message_id: providerMessageId || null,
          text: String(body?.text || ""),
          jid: targetJid || null
        }).catch(() => null);
      } else if (endpoint === "/messages/delete") {
        await run(
          "UPDATE messages SET delivery_status = ?, deleted_at = CURRENT_TIMESTAMP WHERE account_id = ? AND instance_id = ? AND message_id = ?",
          ["deleted", accountId, instanceId, targetMessageId]
        );
        await dispatchWebhook(instanceId, "message.deleted", {
          message_id: targetMessageId,
          provider_message_id: providerMessageId || null,
          jid: targetJid || null
        }).catch(() => null);
      } else if (endpoint === "/messages/read") {
        await run(
          "UPDATE messages SET delivery_status = CASE WHEN direction = 'inbound' THEN 'read' ELSE delivery_status END WHERE account_id = ? AND instance_id = ? AND message_id = ?",
          [accountId, instanceId, targetMessageId]
        );
        await dispatchWebhook(instanceId, "message.read", {
          message_id: targetMessageId,
          jid: targetJid || null
        }).catch(() => null);
      } else if (endpoint === "/messages/react") {
        await dispatchWebhook(instanceId, "message.reaction", {
          message_id: targetMessageId,
          provider_message_id: providerMessageId || null,
          reaction: String(body?.reaction || ""),
          jid: targetJid || null
        }).catch(() => null);
      }
    } catch (error) {
      console.error("Advanced operation persistence failed:", endpoint, sanitizePublicError(error));
    }
  }

  async function syncInstanceStatusFromBridge(inst: any) {
    if (!inst?.id) return inst;
    try {
      const payload = await bridgeFetch(`/instances/${inst.id}/status?account_id=${inst.account_id || ""}`, { method: "GET" });
      if (!payload?.status) return inst;

      const phone = payload.phoneConnected || payload.phone_connected || null;
      const jid = payload.jid || null;
      const profileName = payload.profileName || payload.profile_name || null;
      const profilePictureUrl = payload.profilePictureUrl || payload.profile_picture_url || null;
      const connected = isBridgeConnectedStatus(payload.status) && hasBridgeIdentity(payload);
      const storedStatus = connected ? payload.status : (payload.status === "open" ? "close" : payload.status);
      const qrImage = payload.qr && !connected ? await qrToImage(payload.qr) : null;

      await run(
        "UPDATE instances SET status = ?, connection_status = ?, phone_connected = CASE WHEN ? = 1 THEN COALESCE(?, phone_connected) ELSE NULL END, phone = CASE WHEN ? = 1 THEN COALESCE(?, phone) ELSE NULL END, jid = CASE WHEN ? = 1 THEN COALESCE(?, jid) ELSE NULL END, profile_name = CASE WHEN ? = 1 THEN COALESCE(?, profile_name) ELSE NULL END, profile_picture_url = CASE WHEN ? = 1 THEN COALESCE(?, profile_picture_url) ELSE NULL END, qr = CASE WHEN ? = 1 THEN NULL WHEN ? IS NOT NULL THEN ? ELSE qr END, last_qr = CASE WHEN ? IS NOT NULL THEN ? ELSE last_qr END, last_qr_at = CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP ELSE last_qr_at END, connected_at = CASE WHEN ? = 1 THEN COALESCE(connected_at, CURRENT_TIMESTAMP) ELSE connected_at END, disconnected_at = CASE WHEN ? IN ('close', 'none') THEN CURRENT_TIMESTAMP ELSE disconnected_at END, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [storedStatus, storedStatus, connected ? 1 : 0, phone, connected ? 1 : 0, phone, connected ? 1 : 0, jid, connected ? 1 : 0, profileName, connected ? 1 : 0, profilePictureUrl, connected ? 1 : 0, qrImage, qrImage, qrImage, qrImage, qrImage, connected ? 1 : 0, storedStatus, inst.id]
      );

      const fresh = await get("SELECT * FROM instances WHERE id = ?", [inst.id]);
      return fresh || inst;
    } catch {
      return inst;
    }
  }

  async function connectInstance(instanceId: number, accountId: number, forceNewQr = false) {
    const inst = await get("SELECT jid FROM instances WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [instanceId, accountId]);
    await run(
      "UPDATE instances SET status = ?, connection_status = ?, qr = CASE WHEN ? = 1 THEN NULL ELSE qr END, last_qr = CASE WHEN ? = 1 THEN NULL ELSE last_qr END, last_qr_at = CASE WHEN ? = 1 THEN NULL ELSE last_qr_at END, phone = CASE WHEN ? = 1 THEN NULL ELSE phone END, phone_connected = CASE WHEN ? = 1 THEN NULL ELSE phone_connected END, jid = CASE WHEN ? = 1 THEN NULL ELSE jid END, profile_name = CASE WHEN ? = 1 THEN NULL ELSE profile_name END, profile_picture_url = CASE WHEN ? = 1 THEN NULL ELSE profile_picture_url END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ? AND deleted_at IS NULL",
      ["connecting", "connecting", forceNewQr ? 1 : 0, forceNewQr ? 1 : 0, forceNewQr ? 1 : 0, forceNewQr ? 1 : 0, forceNewQr ? 1 : 0, forceNewQr ? 1 : 0, forceNewQr ? 1 : 0, forceNewQr ? 1 : 0, instanceId, accountId]
    );
    const payload = await bridgeFetch(`/instances/${instanceId}/connect`, {
      method: "POST",
      body: JSON.stringify({ account_id: accountId, jid: forceNewQr ? "" : (inst?.jid || ""), force_new_qr: forceNewQr })
    });
    if (payload?.qr) {
      const qrImage = await qrToImage(payload.qr);
      await run(
        "UPDATE instances SET status = ?, connection_status = ?, qr = ?, last_qr = ?, last_qr_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ? AND deleted_at IS NULL",
        ["qr", "qr_pending", qrImage, qrImage, instanceId, accountId]
      );
      return { ...payload, status: "qr_pending", qr: qrImage };
    }
    if (payload?.status) {
      const connected = isBridgeConnectedStatus(payload.status) && hasBridgeIdentity(payload);
      const storedStatus = connected ? payload.status : (payload.status === "open" ? "close" : payload.status);
      if (connected) {
        const phone = payload.phoneConnected || payload.phone_connected || null;
        const jid = payload.jid || null;
        const profileName = payload.profileName || payload.profile_name || null;
        const profilePictureUrl = payload.profilePictureUrl || payload.profile_picture_url || null;
        await run(
          "UPDATE instances SET status = ?, connection_status = ?, phone_connected = ?, phone = ?, jid = ?, profile_name = ?, profile_picture_url = ?, qr = NULL, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ? AND deleted_at IS NULL",
          [storedStatus, storedStatus, phone, phone, jid, profileName, profilePictureUrl, instanceId, accountId]
        );
      } else {
        await run(
          "UPDATE instances SET status = ?, connection_status = ?, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ? AND deleted_at IS NULL",
          [storedStatus, storedStatus, instanceId, accountId]
        );
      }
      return { ...payload, status: publicInstanceStatus(storedStatus) };
    }
    return payload;
  }

  async function sendWhatsAppMessage(instanceId: number, accountId: number, jid: string, text: string) {
    const result = await bridgeFetch(`/instances/${instanceId}/send`, {
      method: "POST",
      body: JSON.stringify({ account_id: accountId, jid, text })
    });
    return result;
  }

  async function sendWhatsAppMedia(instanceId: number, accountId: number, jid: string, media: any) {
    return bridgeFetch(`/instances/${instanceId}/send-media`, {
      method: "POST",
      body: JSON.stringify({ account_id: accountId, jid, ...media, mediaUrl: publicMediaUrl(media?.mediaUrl || media?.media_url || media?.url) })
    });
  }

  function mediaPreview(contentType: string, fallback = "") {
    const labels: Record<string, string> = {
      image: "Imagem",
      video: "Video",
      audio: "Audio",
      document: "Documento"
    };
    return labels[contentType] || fallback || "Midia";
  }

  function normalizeOutgoingMediaType(type?: string, mimeType?: string) {
    const normalizedType = String(type || "").toLowerCase();
    const normalizedMime = String(mimeType || "").toLowerCase();
    if (["image", "video", "audio", "document"].includes(normalizedType)) return normalizedType;
    if (normalizedMime.startsWith("image/")) return "image";
    if (normalizedMime.startsWith("video/")) return "video";
    if (normalizedMime.startsWith("audio/")) return "audio";
    return "document";
  }

  function inferMediaTypeFromUrl(url?: string | null) {
    const pathname = (() => {
      try { return new URL(String(url || "")).pathname.toLowerCase(); } catch { return String(url || "").toLowerCase(); }
    })();
    if (/\.(jpg|jpeg|png|webp)$/i.test(pathname)) return "image";
    if (/\.(mp3|ogg|wav|m4a)$/i.test(pathname)) return "audio";
    if (/\.(mp4|webm|mov)$/i.test(pathname)) return "video";
    return "document";
  }

  async function persistOutboundMessage(input: {
    accountId: number;
    instanceId: number;
    jid: string;
    messageId: string;
    contentType: string;
    contentText: string;
    sender?: string;
    conversationId?: number | string | null;
    raw?: any;
    preview?: string;
  }) {
    const conversation = input.conversationId
      ? await get("SELECT * FROM conversations WHERE id = ? AND account_id = ?", [input.conversationId, input.accountId])
      : await ensureConversation(input.accountId, input.instanceId, input.jid);
    if (!conversation?.id) throw new Error("conversation_not_found");
    if (Number(conversation.instance_id) !== input.instanceId) {
      await run("UPDATE conversations SET instance_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ?", [input.instanceId, conversation.id, input.accountId]);
      conversation.instance_id = input.instanceId;
    }
    const existing = await get(
      "SELECT * FROM messages WHERE account_id = ? AND instance_id = ? AND message_id = ?",
      [input.accountId, input.instanceId, input.messageId]
    );
    if (existing) return { message: existing, conversation };
    const preview = input.preview || (input.contentType === "text" ? input.contentText : mediaPreview(input.contentType, input.contentText));
    const info = await run(
      "INSERT INTO messages (account_id, instance_id, conversation_id, direction, chat_type, content_type, content_text, message_id, delivery_status, from_me, sender, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        input.accountId,
        input.instanceId,
        conversation.id,
        "outbound",
        conversation.type || "contact",
        input.contentType,
        input.contentText,
        input.messageId,
        "sent",
        1,
        input.sender || "api",
        input.raw ? JSON.stringify(input.raw) : null
      ]
    );
    await run(
      "UPDATE conversations SET last_message_preview = ?, last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [preview, conversation.id]
    );
    const message = await get("SELECT * FROM messages WHERE id = ?", [info.lastInsertRowid]);
    const updatedConversation = await get("SELECT *, last_message_preview AS last_message FROM conversations WHERE id = ?", [conversation.id]);
    io.to(`account:${input.accountId}`).emit("message.new", { conversationId: conversation.id, message, conversation: updatedConversation });
    return { message, conversation: updatedConversation };
  }

  function normalizeInteractiveButtons(input: any) {
    const source = Array.isArray(input?.buttons) ? input.buttons : Array.isArray(input?.options) ? input.options : [];
    return source.slice(0, 3).map((button: any, index: number) => {
      if (typeof button === "string") return { id: `btn_${index + 1}`, text: button };
      const text = String(button?.text || button?.label || button?.displayText || button?.title || "").trim();
      const id = String(button?.id || button?.buttonId || button?.value || `btn_${index + 1}`).trim();
      const url = String(button?.url || button?.link || button?.href || "").trim();
      return { id, text, url };
    }).filter((button: any) => button.text);
  }

  function normalizeInteractiveSections(input: any) {
    const normalizeRows = (rows: any[]) => rows.map((row: any, index: number) => {
      if (typeof row === "string") return { id: `row_${index + 1}`, title: row, description: "" };
      return {
        id: String(row?.id || row?.rowId || row?.value || `row_${index + 1}`).trim(),
        title: String(row?.title || row?.text || row?.label || "").trim(),
        description: String(row?.description || row?.subtitle || "").trim()
      };
    }).filter((row: any) => row.title);

    if (Array.isArray(input?.sections) && input.sections.length) {
      return input.sections.map((section: any, index: number) => ({
        title: String(section?.title || `Seção ${index + 1}`).trim(),
        rows: normalizeRows(Array.isArray(section?.rows) ? section.rows : [])
      })).filter((section: any) => section.rows.length);
    }
    const rows = normalizeRows(Array.isArray(input?.rows) ? input.rows : Array.isArray(input?.options) ? input.options : []);
    return rows.length ? [{ title: "Opções", rows }] : [];
  }

  function fallbackTextForButtons(payload: any, buttons: any[]) {
    const lines = [
      payload.title ? `*${payload.title}*` : "",
      payload.text || payload.body || "",
      "",
      ...buttons.map((button, index) => `${index + 1}. ${button.text}${button.url ? `\n${button.url}` : ""}`),
      payload.footer ? `\n${payload.footer}` : ""
    ];
    return lines.filter((line, index) => line || index === 2).join("\n").trim();
  }

  function fallbackTextForList(payload: any, sections: any[]) {
    const rows: string[] = [];
    sections.forEach((section: any) => {
      if (section.title) rows.push(`\n${section.title}`);
      section.rows.forEach((row: any, index: number) => {
        const description = row.description ? ` - ${row.description}` : "";
        rows.push(`${index + 1}. ${row.title}${description}`);
      });
    });
    return [
      payload.title ? `*${payload.title}*` : "",
      payload.text || payload.body || "",
      rows.join("\n"),
      payload.footer || ""
    ].filter(Boolean).join("\n").trim();
  }

  async function sendWhatsAppButtons(instanceId: number, accountId: number, jid: string, payload: any) {
    const buttons = normalizeInteractiveButtons(payload);
    if (!buttons.length) throw new Error("buttons required");
    const requestPayload = {
      jid,
      title: String(payload.title || "").trim(),
      text: String(payload.text || payload.body || payload.message || "").trim(),
      footer: String(payload.footer || "").trim(),
      buttons
    };
    const fallbackText = fallbackTextForButtons(requestPayload, buttons);
    if (!EXPERIMENTAL_INTERACTIVE_MESSAGES) {
      const result = await sendWhatsAppMessage(instanceId, accountId, jid, fallbackText);
      return { ...result, fallbackUsed: true, fallbackReason: "interactive_messages_disabled", fallbackText };
    }
    try {
      const result = await bridgeFetch(`/instances/${instanceId}/send-buttons`, {
        method: "POST",
        body: JSON.stringify({ account_id: accountId, ...requestPayload })
      });
      return { ...result, fallbackUsed: false, experimental: true };
    } catch (error) {
      const result = await sendWhatsAppMessage(instanceId, accountId, jid, fallbackText);
      return { ...result, fallbackUsed: true, fallbackReason: sanitizePublicError(error), fallbackText };
    }
  }

  async function sendWhatsAppList(instanceId: number, accountId: number, jid: string, payload: any) {
    const sections = normalizeInteractiveSections(payload);
    if (!sections.length) throw new Error("sections or rows required");
    const requestPayload = {
      jid,
      title: String(payload.title || "Menu").trim(),
      text: String(payload.text || payload.body || payload.message || "").trim(),
      footer: String(payload.footer || "").trim(),
      buttonText: String(payload.buttonText || payload.button_text || "Ver opções").trim(),
      sections
    };
    const fallbackText = fallbackTextForList(requestPayload, sections);
    if (!EXPERIMENTAL_INTERACTIVE_MESSAGES) {
      const result = await sendWhatsAppMessage(instanceId, accountId, jid, fallbackText);
      return { ...result, fallbackUsed: true, fallbackReason: "interactive_messages_disabled", fallbackText };
    }
    try {
      const result = await bridgeFetch(`/instances/${instanceId}/send-list`, {
        method: "POST",
        body: JSON.stringify({ account_id: accountId, ...requestPayload })
      });
      return { ...result, fallbackUsed: false, experimental: true };
    } catch (error) {
      const result = await sendWhatsAppMessage(instanceId, accountId, jid, fallbackText);
      return { ...result, fallbackUsed: true, fallbackReason: sanitizePublicError(error), fallbackText };
    }
  }

  const uazSseClients = new Map<number, Set<express.Response>>();

  function uazConnectionStatus(status?: string | null) {
    const value = String(status || "");
    if (["open", "connected"].includes(value)) return "connected";
    if (["connecting", "qr", "qr_pending"].includes(value)) return "connecting";
    return "disconnected";
  }

  function serializeUazInstance(inst: any) {
    const status = uazConnectionStatus(inst?.connection_status || inst?.status);
    const connected = status === "connected";
    return {
      id: String(inst?.id || ""),
      name: inst?.name || "",
      status,
      token: inst?.api_key,
      connected,
      loggedIn: connected,
      jid: inst?.jid || null,
      phone: inst?.phone || inst?.phone_connected || null,
      profileName: inst?.profile_name || null,
      profilePictureUrl: inst?.profile_picture_url || null,
      qrcode: connected ? null : (inst?.qr || inst?.last_qr || null),
      webhook: inst?.webhook_url || null,
      createdAt: inst?.created_at,
      updatedAt: inst?.updated_at
    };
  }

  function getUazToken(req: express.Request) {
    return String(req.headers.token || req.headers["x-api-key"] || "").trim();
  }

  async function getUazInstanceByToken(token: string) {
    if (!token) return null;
    return await get(`
      SELECT instances.*, accounts.status AS account_status
      FROM instances
      LEFT JOIN accounts ON accounts.id = instances.account_id
      WHERE instances.api_key = ? AND instances.deleted_at IS NULL
    `, [token]);
  }

  async function requireUazInstance(req: express.Request, res: express.Response) {
    const inst = await getUazInstanceByToken(getUazToken(req));
    if (!inst) {
      res.status(401).json({ error: "missing or invalid token" });
      return null;
    }
    if (inactiveAccountStatuses.has(String(inst.account_status || "active"))) {
      res.status(403).json({ error: "account restricted" });
      return null;
    }
    return inst;
  }

  function requireUazAdmin(req: express.Request, res: express.Response) {
    if (!runtimeUazAdminToken) {
      res.status(503).json({ error: "WOOAPI_ADMIN_TOKEN is not configured" });
      return false;
    }
    const token = String(req.headers.admintoken || req.headers["admin-token"] || "").trim();
    if (token !== runtimeUazAdminToken) {
      res.status(401).json({ error: "missing or invalid admintoken" });
      return false;
    }
    return true;
  }

  function hasUazAdminToken(req: express.Request) {
    const token = String(req.headers.admintoken || req.headers["admin-token"] || "").trim();
    return Boolean(runtimeUazAdminToken) && token === runtimeUazAdminToken;
  }

  async function requireUazManagement(req: express.Request, res: express.Response) {
    if (hasUazAdminToken(req)) return { isAdmin: true, accountId: null as number | null, instance: null as any };
    const inst = await requireUazInstance(req, res);
    if (!inst) return null;
    return { isAdmin: false, accountId: Number(inst.account_id), instance: inst };
  }

  function resolveUazTargetJid(body: any) {
    const raw = String(body?.jid || body?.chatid || body?.chatId || body?.number || body?.phone || "").trim();
    return resolveTargetJid(raw);
  }

  function emitUazSse(instanceId: number, eventType: string, data: any) {
    const clients = uazSseClients.get(instanceId);
    if (!clients?.size) return;
    const payload = JSON.stringify({
      EventType: eventType,
      eventType,
      instanceId,
      timestamp: new Date().toISOString(),
      data
    });
    for (const client of clients) {
      try {
        client.write(`event: ${eventType}\n`);
        client.write(`data: ${payload}\n\n`);
      } catch {
        clients.delete(client);
      }
    }
  }

  function uazNotImplemented(res: express.Response, feature: string, reason = "Este endpoint depende de suporte adicional no WooAPI Core.") {
    return res.status(501).json({
      success: false,
      supported: false,
      code: "NOT_IMPLEMENTED",
      feature,
      reason,
      docs: "/docs/wooapi"
    });
  }

  async function sendUazText(req: express.Request, res: express.Response) {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const targetJid = resolveUazTargetJid(req.body || {});
    const text = String(req.body?.text || req.body?.message || req.body?.body || "");
    if (!targetJid) return res.status(400).json({ error: "number or jid is required" });
    if (!text) return res.status(400).json({ error: "text is required" });
    if (!isConnectedInstanceStatus(inst.status)) return res.status(409).json({ error: "instance not connected" });

    try {
      const result = await sendWhatsAppMessage(Number(inst.id), Number(inst.account_id), targetJid, text);
      const messageId = result?.ID || result?.id || result?.messageID || `uaz_${Date.now()}`;
      const { message, conversation } = await persistOutboundMessage({
        accountId: Number(inst.account_id),
        instanceId: Number(inst.id),
        jid: targetJid,
        messageId,
        contentType: "text",
        contentText: text,
        sender: "api",
        raw: { source: "uazapi_compat" }
      });
      await logMessage(Number(inst.account_id), Number(inst.id), messageId, "outbound", "sent", { source: "uazapi_compat" });
      emitUazSse(Number(inst.id), "messages", { id: messageId, chatid: targetJid, text, fromMe: true });
      await dispatchWebhook(Number(inst.id), "message.sent", { message, conversation, message_id: messageId, text, jid: targetJid }).catch(() => null);
      return res.json({ response: "Message sent successfully", id: messageId, messageId, status: "sent" });
    } catch (error) {
      return res.status(500).json({ error: sanitizePublicError(error) });
    }
  }

  async function sendUazMedia(req: express.Request, res: express.Response) {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const targetJid = resolveUazTargetJid(req.body || {});
    const mediaUrl = req.body?.mediaUrl || req.body?.media_url || req.body?.url || req.body?.link;
    if (!targetJid) return res.status(400).json({ error: "number or jid is required" });
    if (!mediaUrl) return res.status(400).json({ error: "mediaUrl or url is required" });
    if (!isConnectedInstanceStatus(inst.status)) return res.status(409).json({ error: "instance not connected" });

    try {
      const result = await sendWhatsAppMedia(Number(inst.id), Number(inst.account_id), targetJid, {
        mediaUrl,
        caption: req.body?.caption || req.body?.text || "",
        mimeType: req.body?.mimeType || req.body?.mimetype || req.body?.mime_type || "",
        fileName: req.body?.fileName || req.body?.filename || req.body?.file_name || "",
        type: req.body?.type || req.body?.mediatype || ""
      });
      const messageId = result?.ID || result?.id || result?.messageID || `uaz_media_${Date.now()}`;
      const contentType = normalizeOutgoingMediaType(req.body?.type || req.body?.mediatype || "", req.body?.mimeType || req.body?.mimetype || req.body?.mime_type || "");
      const { message, conversation } = await persistOutboundMessage({
        accountId: Number(inst.account_id),
        instanceId: Number(inst.id),
        jid: targetJid,
        messageId,
        contentType,
        contentText: mediaUrl,
        sender: "api",
        raw: {
          source: "uazapi_compat",
          caption: req.body?.caption || req.body?.text || "",
          mimeType: req.body?.mimeType || req.body?.mimetype || req.body?.mime_type || "",
          fileName: req.body?.fileName || req.body?.filename || req.body?.file_name || ""
        }
      });
      await logMessage(Number(inst.account_id), Number(inst.id), messageId, "outbound", "sent", { source: "uazapi_compat", mediaUrl });
      emitUazSse(Number(inst.id), "messages", { id: messageId, chatid: targetJid, mediaUrl, fromMe: true });
      await dispatchWebhook(Number(inst.id), "message.sent", { message, conversation, message_id: messageId, mediaUrl, jid: targetJid }).catch(() => null);
      return res.json({ response: "Media sent successfully", id: messageId, messageId, status: "sent" });
    } catch (error) {
      return res.status(500).json({ error: sanitizePublicError(error) });
    }
  }

  async function sendUazButtons(req: express.Request, res: express.Response) {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    if (!EXPERIMENTAL_INTERACTIVE_MESSAGES) {
      return res.status(501).json({
        success: false,
        supported: false,
        code: "INTERACTIVE_MESSAGES_OFFICIAL_ONLY",
        error: "Botões interativos não são oferecidos nesta API não oficial. Use /send/text ou WhatsApp Cloud API oficial para botões nativos."
      });
    }
    const targetJid = resolveUazTargetJid(req.body || {});
    const buttons = normalizeInteractiveButtons(req.body || {});
    const text = String(req.body?.text || req.body?.message || req.body?.body || "");
    if (!targetJid) return res.status(400).json({ error: "number or jid is required" });
    if (!text) return res.status(400).json({ error: "text is required" });
    if (!buttons.length) return res.status(400).json({ error: "buttons are required" });
    if (!isConnectedInstanceStatus(inst.status)) return res.status(409).json({ error: "instance not connected" });

    try {
      const result = await sendWhatsAppButtons(Number(inst.id), Number(inst.account_id), targetJid, { ...req.body, text, buttons });
      const messageId = result?.ID || result?.id || result?.messageID || `uaz_buttons_${Date.now()}`;
      const fallbackUsed = Boolean(result.fallbackUsed);
      const storedContentType = fallbackUsed ? "text" : "buttons";
      const storedText = fallbackUsed ? String(result.fallbackText || text) : text;
      const conversation = await ensureConversation(Number(inst.account_id), Number(inst.id), targetJid);
      await run(
        "INSERT INTO messages (account_id, instance_id, conversation_id, direction, chat_type, content_type, content_text, message_id, delivery_status, from_me, sender, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [inst.account_id, inst.id, conversation?.id, "outbound", conversation?.type || "contact", storedContentType, storedText, messageId, "sent", 1, "api", JSON.stringify({ buttons, fallbackUsed, fallbackReason: result.fallbackReason || null })]
      );
      await logMessage(Number(inst.account_id), Number(inst.id), messageId, "outbound", "sent", { source: "uazapi_compat", requestedContentType: "buttons", contentType: storedContentType, fallbackUsed, fallbackReason: result.fallbackReason || null });
      emitUazSse(Number(inst.id), "messages", { id: messageId, chatid: targetJid, text: storedText, buttons: fallbackUsed ? undefined : buttons, fromMe: true, fallbackUsed });
      await dispatchWebhook(Number(inst.id), "message.sent", { message_id: messageId, type: storedContentType, text: storedText, buttons: fallbackUsed ? undefined : buttons, jid: targetJid, fallbackUsed }).catch(() => null);
      return res.json({ response: fallbackUsed ? "Buttons sent as fallback text" : "Buttons sent successfully", id: messageId, messageId, status: "sent", fallbackUsed });
    } catch (error) {
      return res.status(500).json({ error: sanitizePublicError(error) });
    }
  }

  async function sendUazMenu(req: express.Request, res: express.Response) {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const targetJid = resolveUazTargetJid(req.body || {});
    const sections = normalizeInteractiveSections(req.body || {});
    const text = String(req.body?.text || req.body?.message || req.body?.body || "");
    if (!targetJid) return res.status(400).json({ error: "number or jid is required" });
    if (!text) return res.status(400).json({ error: "text is required" });
    if (!sections.length) return res.status(400).json({ error: "sections or rows are required" });
    if (!isConnectedInstanceStatus(inst.status)) return res.status(409).json({ error: "instance not connected" });

    try {
      const result = await sendWhatsAppList(Number(inst.id), Number(inst.account_id), targetJid, { ...req.body, text, sections });
      const messageId = result?.ID || result?.id || result?.messageID || `uaz_menu_${Date.now()}`;
      const fallbackUsed = Boolean(result.fallbackUsed);
      const storedContentType = fallbackUsed ? "text" : "menu";
      const storedText = fallbackUsed ? String(result.fallbackText || text) : text;
      const conversation = await ensureConversation(Number(inst.account_id), Number(inst.id), targetJid);
      await run(
        "INSERT INTO messages (account_id, instance_id, conversation_id, direction, chat_type, content_type, content_text, message_id, delivery_status, from_me, sender, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [inst.account_id, inst.id, conversation?.id, "outbound", conversation?.type || "contact", storedContentType, storedText, messageId, "sent", 1, "api", JSON.stringify({ sections, fallbackUsed, fallbackReason: result.fallbackReason || null })]
      );
      await logMessage(Number(inst.account_id), Number(inst.id), messageId, "outbound", "sent", { source: "uazapi_compat", requestedContentType: "menu", contentType: storedContentType, fallbackUsed, fallbackReason: result.fallbackReason || null });
      emitUazSse(Number(inst.id), "messages", { id: messageId, chatid: targetJid, text: storedText, sections: fallbackUsed ? undefined : sections, fromMe: true, fallbackUsed });
      await dispatchWebhook(Number(inst.id), "message.sent", { message_id: messageId, type: storedContentType, text: storedText, sections: fallbackUsed ? undefined : sections, jid: targetJid, fallbackUsed }).catch(() => null);
      return res.json({ response: fallbackUsed ? "Menu sent as fallback text" : "Menu sent successfully", id: messageId, messageId, status: "sent", fallbackUsed });
    } catch (error) {
      return res.status(500).json({ error: sanitizePublicError(error) });
    }
  }

  async function getIntegration(instanceId: number, provider: string) {
    const row = await get("SELECT * FROM integration_settings WHERE instance_id = ? AND provider = ? AND enabled = 1", [instanceId, provider]);
    if (!row) return null;
    try {
      return { ...row, config: JSON.parse(row.config_json || "{}") };
    } catch {
      return { ...row, config: {} };
    }
  }

  function typebotTextMessages(response: any) {
    const messages = Array.isArray(response?.messages) ? response.messages : [];
    return messages
      .map((msg: any) => {
        if (typeof msg?.content?.plainText === "string") return msg.content.plainText;
        if (typeof msg?.content?.text === "string") return msg.content.text;
        if (typeof msg?.content?.richText === "string") return msg.content.richText;
        if (Array.isArray(msg?.content?.richText)) {
          return msg.content.richText.map((block: any) =>
            Array.isArray(block?.children) ? block.children.map((child: any) => child.text || "").join("") : ""
          ).join("\n");
        }
        return "";
      })
      .filter(Boolean);
  }

  async function callTypebot(instanceId: number, accountId: number, contactKey: string, text: string) {
    const integration = await getIntegration(instanceId, "typebot");
    if (!integration || !text) return;
    const config = integration.config || {};
    const apiUrl = String(config.apiUrl || "https://typebot.io").replace(/\/$/, "");
    const publicId = config.publicId || config.typebotId;
    const token = config.token || config.apiToken;
    if (!publicId || !token) return;

    const existing = await get("SELECT * FROM integration_sessions WHERE instance_id = ? AND provider = ? AND contact_key = ?", [instanceId, "typebot", contactKey]);
    const endpoint = existing?.session_id
      ? `${apiUrl}/api/v1/sessions/${existing.session_id}/continueChat`
      : `${apiUrl}/api/v1/typebots/${publicId}/startChat`;
    const body = existing?.session_id
      ? { message: text }
      : { message: { type: "text", text }, prefilledVariables: { phone: contactKey } };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.message || data?.error || `Typebot ${response.status}`);

    if (data.sessionId) {
      await run(
        "INSERT INTO integration_sessions (account_id, instance_id, provider, contact_key, session_id, result_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(instance_id, provider, contact_key) DO UPDATE SET session_id = excluded.session_id, result_id = excluded.result_id, updated_at = CURRENT_TIMESTAMP",
        [accountId, instanceId, "typebot", contactKey, data.sessionId, data.resultId || existing?.result_id || null]
      );
    }

    for (const reply of typebotTextMessages(data)) {
      await sendWhatsAppMessage(instanceId, accountId, contactKey.includes("@") ? contactKey : `${contactKey}@s.whatsapp.net`, reply);
    }
  }

  async function dispatchIntegrations(instanceId: number, accountId: number, event: string, payload: any) {
    if (event !== "message.received") return;
    const message = payload?.message;
    if (!message) return;
    const contactKey = message.author_phone || payload?.conversation?.contact_phone || payload?.conversation?.remote_jid;
    if (!contactKey) return;

    if (message.content_type === "text" && message.content_text) {
      await callTypebot(instanceId, accountId, String(contactKey), String(message.content_text)).catch(async (error) => {
        await run("INSERT INTO webhook_events (account_id, instance_id, event, payload, status, error) VALUES (?, ?, ?, ?, ?, ?)", [
          accountId,
          instanceId,
          "integration.typebot.failed",
          JSON.stringify({ contactKey, messageId: message.id }),
          "failed",
          String(error?.message || error)
        ]);
      });
    }

    const jobData: any = {
      instanceId,
      accountId,
      contactPhone: String(contactKey),
      contactName: message.author_push_name || undefined,
      messageText: message.content_text || undefined,
      messageId: message.id,
      contentType: message.content_type || "text",
      mediaUrl: undefined as string | undefined,
    };

    if (message.content_type !== "text" && message.content_text && message.content_text.startsWith("http")) {
      jobData.mediaUrl = message.content_text;
    }

    chatwootSyncQueue.add("sync-message", jobData).catch(() => null);
  }

  async function dispatchIntegrationsStatus(instanceId: number, accountId: number, contactPhone: string | undefined, messageId: string, status: string) {
    if (!contactPhone || !messageId) return;
    const chatwootEnabled = await get(
      "SELECT 1 FROM integration_settings WHERE instance_id = ? AND provider = ? AND enabled = 1",
      [instanceId, "chatwoot"]
    );
    if (!chatwootEnabled) return;
    chatwootSyncQueue.add("sync-status", {
      instanceId,
      accountId,
      contactPhone: String(contactPhone),
      messageId,
      status
    }).catch(() => null);
  }

  function getApiKey(req: express.Request) {
    const bearer = String(req.headers.authorization || "");
    const explicitKey = String(req.headers["x-api-key"] || req.headers.token || "").trim();
    if (explicitKey) return explicitKey;
    return bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
  }

  async function requireInstanceApiKey(req: express.Request, res: express.Response) {
    const apiKey = getApiKey(req);
    const instanceId = Number(req.params.id || req.body?.instanceId);
    if (!apiKey || !instanceId) {
      publicError(res, 401, "AUTH_REQUIRED", "API key e instanceId obrigatórios");
      return null;
    }
    const inst = await get(`
      SELECT instances.*, accounts.status AS account_status, accounts.account_type
      FROM instances
      LEFT JOIN accounts ON accounts.id = instances.account_id
      WHERE instances.id = ? AND instances.api_key = ? AND instances.deleted_at IS NULL
    `, [instanceId, apiKey]);
    if (!inst) {
      publicError(res, 403, "INVALID_API_KEY", "Chave inválida para esta instância");
      return null;
    }
    if (inactiveAccountStatuses.has(String(inst.account_status || "active")) || ["blocked", "paused"].includes(String(inst.status || ""))) {
      publicError(res, 403, "ACCOUNT_RESTRICTED", "Conta ou instância sem permissão para executar esta operação");
      return null;
    }
    if (!(await getAccountFeatureFlags(Number(inst.account_id))).api) {
      publicError(res, 403, "PLAN_FEATURE_DISABLED", "API pública não está habilitada para esta conta");
      return null;
    }
    return inst;
  }

  async function requireAccount(req: AccountRequest, res: express.Response, next: express.NextFunction) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : String(req.headers["x-auth-token"] || "");
    const payload = verifyToken(token);
    if (payload?.accountId) {
      const account = await get("SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL", [payload.accountId]);
      if (!accountCanOperate(account) && payload.role !== "super_admin") {
        return res.status(403).json({ error: "Conta pausada ou bloqueada" });
      }
      if (payload.role !== "super_admin") {
        const billingError = await enforceBilling(account);
        if (billingError) {
          return res.status(402).json({ error: billingError });
        }
      }
      req.accountId = Number(payload.accountId);
      req.user = payload;
      req.account = account;
      return next();
    }

    return res.status(401).json({ error: "Não autenticado" });
  }

  function requireSuperAdmin(req: AccountRequest, res: express.Response, next: express.NextFunction) {
    if (req.user?.role !== "super_admin") {
      return res.status(403).json({ error: "Acesso restrito ao Super Admin" });
    }
    return next();
  }

  function requireAccountType(types: string[]) {
    return (req: AccountRequest, res: express.Response, next: express.NextFunction) => {
      const accountType = String(req.account?.account_type || "");
      if (!types.includes(accountType) && req.user?.role !== "super_admin") {
        return res.status(403).json({ error: "Permissão insuficiente" });
      }
      return next();
    };
  }

  async function getAccountScopedInstance(req: AccountRequest, instanceId: any, columns = "*") {
    const id = Number(instanceId);
    if (!Number.isFinite(id)) return null;
    const params: any[] = [id];
    const accountFilter = req.user?.role === "super_admin" ? "" : " AND account_id = ?";
    if (accountFilter) params.push(req.accountId);
    return await get(`SELECT ${columns} FROM instances WHERE id = ?${accountFilter} AND deleted_at IS NULL`, params);
  }

  async function getAccountPlan(accountId: number) {
    return await get(`
      SELECT
        plans.*,
        COALESCE(accounts.instance_quota, plans.instance_quota, plans.max_instances, 0) AS max_instances,
        COALESCE(accounts.max_client_accounts, plans.max_client_accounts, 0) AS max_client_accounts
      FROM accounts
      LEFT JOIN plans ON plans.id = accounts.plan_id
      WHERE accounts.id = ?
    `, [accountId]) || {};
  }

  async function getChildInstanceAllocation(accountId: number) {
    return (await get("SELECT COALESCE(SUM(COALESCE(instance_quota, 0)), 0) AS total FROM accounts WHERE parent_account_id = ? AND deleted_at IS NULL", [accountId]))?.total || 0;
  }

  async function getAccountQuotaUsage(accountId: number) {
    const account = await get("SELECT id, account_type, status, trial_ends_at, instance_quota, plan_id FROM accounts WHERE id = ? AND deleted_at IS NULL", [accountId]);
    const plan = await getAccountPlan(accountId);
    const instanceQuota = Number(account?.instance_quota ?? plan?.max_instances ?? 0);
    const ownInstancesUsed = Number((await get("SELECT COUNT(*) AS total FROM instances WHERE account_id = ? AND deleted_at IS NULL", [accountId]))?.total || 0);
    const allocatedToChildren = Number(await getChildInstanceAllocation(accountId));
    const childrenInstancesUsed = Number((await get(`
      SELECT COUNT(*) AS total
      FROM instances
      INNER JOIN accounts ON accounts.id = instances.account_id
      WHERE accounts.parent_account_id = ? AND accounts.deleted_at IS NULL AND instances.deleted_at IS NULL
    `, [accountId]))?.total || 0);
    const available = Math.max(instanceQuota - ownInstancesUsed - allocatedToChildren, 0);
    return {
      accountId,
      accountType: account?.account_type || "client",
      instanceQuota,
      ownInstancesUsed,
      allocatedToChildren,
      childrenInstancesUsed,
      availableToAllocate: available,
      availableToCreateOwn: available
    };
  }

  async function getAccountUsage(accountId: number) {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const since = monthStart.toISOString();
    return {
      instances: (await get("SELECT COUNT(*) AS total FROM instances WHERE account_id = ? AND deleted_at IS NULL", [accountId]))?.total || 0,
      users: (await get("SELECT COUNT(*) AS total FROM users WHERE account_id = ?", [accountId]))?.total || 0,
      agents: (await get("SELECT COUNT(*) AS total FROM agents WHERE account_id = ?", [accountId]))?.total || 0,
      campaigns: (await get("SELECT COUNT(*) AS total FROM campaigns WHERE account_id = ?", [accountId]))?.total || 0,
      leads: (await get("SELECT COUNT(*) AS total FROM leads WHERE account_id = ?", [accountId]))?.total || 0,
      messages: (await get("SELECT COUNT(*) AS total FROM messages WHERE account_id = ? AND created_at >= ?", [accountId, since]))?.total || 0,
      client_accounts: (await get("SELECT COUNT(*) AS total FROM accounts WHERE parent_account_id = ? AND deleted_at IS NULL", [accountId]))?.total || 0,
      allocated_child_instances: await getChildInstanceAllocation(accountId),
      webhook_failures: (await get("SELECT COUNT(*) AS total FROM webhook_events WHERE account_id = ? AND status = 'failed' AND created_at >= ?", [accountId, since]))?.total || 0
    };
  }

  async function ensureLimit(accountId: number, key: string, current: number) {
    const plan = await getAccountPlan(accountId);
    const limit = Number(plan?.[key] || 0);
    if (limit > 0 && current >= limit) {
      return { allowed: false, limit, error: `Limite do plano atingido (${limit})` };
    }
    return { allowed: true, limit };
  }

  async function ensureInstanceCapacity(accountId: number, requestedAdditional = 1) {
    const usage = await getAccountQuotaUsage(accountId);
    const account = await get("SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL", [accountId]);
    if (!accountCanOperate(account)) {
      return { allowed: false, limit: 0, used: 0, usage, error: "Conta expirada, pausada ou bloqueada" };
    }
    const limit = Number(usage.instanceQuota || 0);
    if (!limit) return { allowed: true, limit, usage };
    const used = Number(usage.ownInstancesUsed || 0) + Number(usage.allocatedToChildren || 0);
    if (used + requestedAdditional > limit) {
      return { allowed: false, limit, used, usage, error: `Cota de instancias insuficiente (${used}/${limit})` };
    }
    return { allowed: true, limit, used, usage };
  }

  app.use("/api/v1", globalRateLimit, apiKeyRateLimit);
  app.use("/api/auth/login", loginRateLimit);
  app.use((req: AccountRequest, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    const startedAt = Date.now();
    res.on("finish", async () => {
      try {
        const apiKey = getApiKey(req);
        const inst = apiKey ? await get("SELECT id, account_id FROM instances WHERE api_key = ?", [apiKey]) : null;
        const tokenPayload = verifyToken(String(req.headers.authorization || "").replace(/^Bearer\s+/i, "") || String(req.headers["x-auth-token"] || ""));
        const accountId = Number(req.accountId || inst?.account_id || tokenPayload?.accountId || 0) || null;
        await run(
          "INSERT INTO api_request_logs (account_id, instance_id, method, path, status_code, ip, user_agent, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [accountId, inst?.id || null, req.method, req.path, res.statusCode, req.ip, String(req.headers["user-agent"] || ""), Date.now() - startedAt]
        );
      } catch {
        // Request logging must not affect the API response.
      }
    });
    return next();
  });

  app.post("/api/auth/register", async (req, res) => {
    const { companyName, name, email, password } = req.body || {};
    const referralCode = String(req.body?.referral_code || req.body?.ref || "").trim();
    if (!companyName || !name || !email || !password) return res.status(400).json({ error: "Dados obrigatórios ausentes" });
    if (await get("SELECT id FROM users WHERE email = ?", [email])) return res.status(409).json({ error: "E-mail já cadastrado" });

    const defaultPlan = await get("SELECT id, max_instances, max_client_accounts FROM plans WHERE is_active = 1 AND name <> ? AND price > 0 ORDER BY price ASC, max_instances ASC LIMIT 1", ["Teste Gratis"]);
    const accountType = "client";
    const partner: any = referralCode ? await get("SELECT id FROM partners WHERE referral_code = ? AND status = 'active'", [referralCode]) : null;
    const account = await run("INSERT INTO accounts (name, plan_id, account_type, instance_quota, max_client_accounts, owner_name, owner_email, referred_partner_id, referral_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [companyName, defaultPlan?.id || null, accountType, defaultPlan?.max_instances || 1, defaultPlan?.max_client_accounts || 0, name, email, partner?.id || null, partner?.id ? referralCode : null]);
    const role = "admin";
    await run("INSERT INTO users (account_id, name, email, password, role) VALUES (?, ?, ?, ?, ?)", [
      account.lastInsertRowid, name, email, hashPassword(password), role
    ]);
    if (partner?.id) await recordPartnerReferral(Number(account.lastInsertRowid), referralCode, "register", { companyName, email });
    await audit(Number(account.lastInsertRowid), null, "account.created", { companyName, email, role, referral_code: partner?.id ? referralCode : null });
    res.json({ success: true });
  });

  app.post("/api/auth/trial", async (req, res) => {
    const { companyName, name, email, password } = req.body || {};
    const referralCode = String(req.body?.referral_code || req.body?.ref || "").trim();
    if (!companyName || !name || !email || !password) return res.status(400).json({ error: "Dados obrigatorios ausentes" });
    if (String(password).length < 6) return res.status(400).json({ error: "Use uma senha com pelo menos 6 caracteres" });
    if (await get("SELECT id FROM users WHERE email = ?", [email])) return res.status(409).json({ error: "E-mail ja cadastrado" });

    const trialPlan = await get("SELECT * FROM plans WHERE name = ? AND is_active = 1", ["Teste Gratis"]);
    if (!trialPlan?.id) return res.status(503).json({ error: "Plano de teste indisponivel" });

    const trialEndsAt = new Date(Date.now() + TRIAL_TEST_HOURS * 60 * 60 * 1000).toISOString();
    const partner: any = referralCode ? await get("SELECT id FROM partners WHERE referral_code = ? AND status = 'active'", [referralCode]) : null;
    const account = await run(
      "INSERT INTO accounts (name, plan_id, account_type, instance_quota, max_client_accounts, owner_name, owner_email, email, status, billing_status, trial_ends_at, referred_partner_id, referral_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        companyName,
        trialPlan.id,
        "client",
        Number(trialPlan.max_instances || trialPlan.instance_quota || 1),
        0,
        name,
        email,
        email,
        "trial",
        "trial",
        trialEndsAt,
        partner?.id || null,
        partner?.id ? referralCode : null
      ]
    );
    const accountId = Number(account.lastInsertRowid);
    const user = await run(
      "INSERT INTO users (account_id, name, email, password, role) VALUES (?, ?, ?, ?, 'admin')",
      [accountId, name, email, hashPassword(password)]
    );
    if (partner?.id) await recordPartnerReferral(accountId, referralCode, "trial", { companyName, email });
    await audit(accountId, null, "trial.account.created", {
      companyName,
      email,
      referral_code: partner?.id ? referralCode : null,
      trial_hours: TRIAL_TEST_HOURS,
      trial_ends_at: trialEndsAt,
      auto_delete: true
    });

    const savedUser: any = await get("SELECT id, account_id, name, email, role, status, created_at FROM users WHERE id = ?", [user.lastInsertRowid]);
    const savedAccount = await get("SELECT * FROM accounts WHERE id = ?", [accountId]);
    const token = signToken({ userId: savedUser?.id, accountId, role: savedUser?.role, email: savedUser?.email });
    res.json({
      success: true,
      token,
      accountId,
      account: savedAccount,
      user: savedUser,
      trial: {
        hours: TRIAL_TEST_HOURS,
        ends_at: trialEndsAt,
        auto_delete: true,
        message: "A conta teste dura 1 hora e sera excluida automaticamente com todos os dados criados no teste."
      }
    });
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body || {};
    const user = await get("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) return res.status(401).json({ error: "Inválido" });
    const passwordResult = verifyPassword(password, user.password);
    if (!passwordResult) return res.status(401).json({ error: "Inválido" });

    if (user.status && user.status !== "active") return res.status(403).json({ error: "Usuário bloqueado" });
    const account = await get("SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL", [user.account_id]);
    if (!accountCanOperate(account) && user.role !== "super_admin") return res.status(403).json({ error: "Conta pausada ou bloqueada" });

    if (passwordResult === "needs_rehash" || !String(user.password).startsWith("pbkdf2$")) {
      await run("UPDATE users SET password = ? WHERE id = ?", [hashPassword(password), user.id]);
    }

    const token = signToken({ userId: user.id, accountId: user.account_id, role: user.role, email: user.email });
    delete user.password;
    res.json({ success: true, token, accountId: user.account_id, account, user });
  });

  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth/") || req.path.startsWith("/bridge/") || req.path.startsWith("/v1/")) return next();
    return requireAccount(req as AccountRequest, res, next);
  });

  app.use("/api/admin", (req, res, next) => {
    if (req.path.startsWith("/wooapi-monitor") || req.path.startsWith("/live-logs") || req.path.startsWith("/alerts")) return next();
    return requireSuperAdmin(req as AccountRequest, res, next);
  });
  app.use("/api/reseller", requireAccountType(["owner", "reseller"]));

  app.get("/api/admin/accounts", async (req: AccountRequest, res) => {
    const rows = await Promise.all((await query(`
      SELECT accounts.*, plans.name AS plan_name,
        COALESCE(accounts.instance_quota, plans.max_instances) AS max_instances,
        COALESCE(accounts.max_client_accounts, plans.max_client_accounts, 0) AS max_client_accounts,
        plans.max_users, plans.max_agents, plans.max_campaigns, plans.max_leads, plans.max_messages,
        COALESCE(user_counts.total, 0) AS user_count,
        COALESCE(instance_counts.total, 0) AS instance_count
      FROM accounts
      LEFT JOIN plans ON plans.id = accounts.plan_id
      LEFT JOIN (
        SELECT account_id, COUNT(*) AS total
        FROM users
        GROUP BY account_id
      ) user_counts ON user_counts.account_id = accounts.id
      LEFT JOIN (
        SELECT account_id, COUNT(*) AS total
        FROM instances
        WHERE deleted_at IS NULL
        GROUP BY account_id
      ) instance_counts ON instance_counts.account_id = accounts.id
      ORDER BY accounts.created_at DESC
    `)).map(async (row) => ({ ...row, usage: await getAccountUsage(row.id) })));
    res.json(rows);
  });

  app.get("/api/admin/overview", async (_req: AccountRequest, res) => {
    return publicSuccess(res, {
      accounts: (await get("SELECT COUNT(*) AS total FROM accounts"))?.total || 0,
      active_accounts: (await get("SELECT COUNT(*) AS total FROM accounts WHERE status = 'active'"))?.total || 0,
      resellers: (await get("SELECT COUNT(*) AS total FROM accounts WHERE account_type = 'reseller'"))?.total || 0,
      customers: (await get("SELECT COUNT(*) AS total FROM accounts WHERE account_type = 'client'"))?.total || 0,
      users: (await get("SELECT COUNT(*) AS total FROM users"))?.total || 0,
      instances: (await get("SELECT COUNT(*) AS total FROM instances"))?.total || 0,
      connected_instances: (await get("SELECT COUNT(*) AS total FROM instances WHERE status = 'open'"))?.total || 0,
      messages_month: (await get("SELECT COUNT(*) AS total FROM messages WHERE created_at >= date('now','start of month')"))?.total || 0,
      failed_webhooks: (await get("SELECT COUNT(*) AS total FROM webhook_events WHERE status = 'failed' AND created_at >= date('now','start of month')"))?.total || 0
    });
  });

  app.get("/api/admin/logs", async (req, res) => {
    const type = String(req.query.type || "audit");
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 300);
    if (type === "api") {
      return res.json(await query("SELECT * FROM api_request_logs ORDER BY id DESC LIMIT ?", [limit]));
    }
    if (type === "connections") {
      return res.json(await query("SELECT * FROM connection_logs ORDER BY id DESC LIMIT ?", [limit]));
    }
    if (type === "messages") {
      return res.json(await query("SELECT * FROM message_logs ORDER BY id DESC LIMIT ?", [limit]));
    }
    if (type === "webhooks") {
      return res.json(await query("SELECT id, account_id, instance_id, event, status, response_status, error, attempts, delivered_at, created_at FROM webhook_events ORDER BY id DESC LIMIT ?", [limit]));
    }
    return res.json(await query("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?", [limit]));
  });

  app.get("/api/admin/live-logs", async (req: AccountRequest, res) => {
    const scopedAccountId = req.user?.role === "super_admin"
      ? (req.query.account_id ? Number(req.query.account_id) : null)
      : Number(req.accountId);
    const logs = await getMergedLiveLogs({
      accountId: scopedAccountId,
      instanceId: req.query.instance_id ? Number(req.query.instance_id) : null,
      limit: Number(req.query.limit || 150)
    });
    return publicSuccess(res, logs);
  });

  app.get("/api/admin/wooapi-monitor", async (req: AccountRequest, res) => {
    const since24h = "datetime('now','-24 hours')";
    const isGlobalMonitor = req.user?.role === "super_admin";
    const accountScope = isGlobalMonitor ? "" : " AND instances.account_id = ?";
    const accountParams = isGlobalMonitor ? [] : [Number(req.accountId)];
    const queueRefs = [
      { key: "webhookDelivery", label: "Webhook Delivery", name: WOOAPI_QUEUE_DISPLAY_NAMES.webhookDelivery, queue: webhookDeliveryQueue },
      { key: "messageSend", label: "Message Send", name: WOOAPI_QUEUE_DISPLAY_NAMES.messageSend, queue: messageSendQueue },
      { key: "messageScheduled", label: "Message Scheduled", name: WOOAPI_QUEUE_DISPLAY_NAMES.messageScheduled, queue: messageScheduledQueue },
      { key: "messageRetry", label: "Message Retry", name: WOOAPI_QUEUE_DISPLAY_NAMES.messageRetry, queue: messageRetryQueue },
      { key: "instanceMonitor", label: "Instance Monitor", name: WOOAPI_QUEUE_DISPLAY_NAMES.instanceMonitor, queue: instanceMonitorQueue },
      { key: "instanceLifecycle", label: "Instance Lifecycle", name: WOOAPI_QUEUE_DISPLAY_NAMES.instanceLifecycle, queue: instanceLifecycleQueue },
      { key: "instanceMigration", label: "Instance Migration", name: WOOAPI_QUEUE_DISPLAY_NAMES.instanceMigration, queue: instanceMigrationQueue },
      { key: "supportAlerts", label: "Support Alerts", name: WOOAPI_QUEUE_DISPLAY_NAMES.supportAlerts, queue: supportAlertsQueue },
      { key: "reputationUpdate", label: "Reputation Update", name: WOOAPI_QUEUE_DISPLAY_NAMES.reputationUpdate, queue: reputationUpdateQueue },
      { key: "chatwootSync", label: "Chatwoot Sync", name: WOOAPI_QUEUE_DISPLAY_NAMES.chatwootSync, queue: chatwootSyncQueue },
      { key: "cleanupLogs", label: "Cleanup Logs", name: WOOAPI_QUEUE_DISPLAY_NAMES.cleanupLogs, queue: cleanupLogsQueue },
      { key: "deadLetter", label: "Dead Letter", name: WOOAPI_QUEUE_DISPLAY_NAMES.deadLetter, queue: deadLetterQueue }
    ];

    const queues: any[] = [];
    for (const item of queueRefs) {
      try {
        const counts = await item.queue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused");
        queues.push({
          key: item.key,
          label: item.label,
          name: item.name,
          available: true,
          ...counts,
          pending: Number(counts.waiting || 0) + Number(counts.delayed || 0)
        });
      } catch (error) {
        queues.push({
          key: item.key,
          label: item.label,
          name: item.name,
          available: false,
          waiting: 0,
          active: 0,
          delayed: 0,
          failed: 0,
          completed: 0,
          paused: 0,
          pending: 0,
          error: sanitizePublicError(error)
        });
      }
    }

    const instanceRows = (await query(`
      SELECT instances.id,
             instances.account_id,
             accounts.name AS account_name,
             instances.name,
             instances.phone,
             instances.phone_connected,
             instances.status,
             instances.connection_status,
             instances.assigned_node_id,
             instances.ip_pool_id,
             instances.risk_profile,
             instances.risk_score,
             instances.last_seen_at,
             instances.connected_at,
             instances.disconnected_at,
             instances.updated_at,
             COALESCE(active_hooks.total, 0) AS active_webhooks,
             COALESCE(messages_24h.total, 0) AS messages_24h,
             COALESCE(message_failures_24h.total, 0) AS message_failures_24h,
             COALESCE(webhook_failures_24h.total, 0) AS webhook_failures_24h,
             COALESCE(webhook_logs_24h.avg_duration_ms, 0) AS avg_webhook_duration_ms
      FROM instances
      LEFT JOIN accounts ON accounts.id = instances.account_id
      LEFT JOIN (
        SELECT instance_id, COUNT(*) AS total
        FROM instance_webhooks
        WHERE is_active = 1
        GROUP BY instance_id
      ) active_hooks ON active_hooks.instance_id = instances.id
      LEFT JOIN (
        SELECT instance_id, COUNT(*) AS total
        FROM messages
        WHERE created_at >= ${since24h}
        GROUP BY instance_id
      ) messages_24h ON messages_24h.instance_id = instances.id
      LEFT JOIN (
        SELECT instance_id, COUNT(*) AS total
        FROM message_logs
        WHERE status = 'failed' AND created_at >= ${since24h}
        GROUP BY instance_id
      ) message_failures_24h ON message_failures_24h.instance_id = instances.id
      LEFT JOIN (
        SELECT instance_id, COUNT(*) AS total
        FROM webhook_delivery_logs
        WHERE success = 0 AND created_at >= ${since24h}
        GROUP BY instance_id
      ) webhook_failures_24h ON webhook_failures_24h.instance_id = instances.id
      LEFT JOIN (
        SELECT instance_id, AVG(duration_ms) AS avg_duration_ms
        FROM webhook_delivery_logs
        WHERE created_at >= ${since24h}
        GROUP BY instance_id
      ) webhook_logs_24h ON webhook_logs_24h.instance_id = instances.id
      WHERE instances.deleted_at IS NULL${accountScope}
      ORDER BY instances.updated_at DESC, instances.id DESC
      LIMIT 200
    `, accountParams)).map((row) => {
      const status = publicInstanceStatus(row.connection_status || row.status);
      const failures = Number(row.message_failures_24h || 0) + Number(row.webhook_failures_24h || 0);
      const lastSeenAt = row.last_seen_at || row.connected_at || row.updated_at;
      const lastSeenMinutes = lastSeenAt ? Math.max(0, Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / 60000)) : null;
      const operationalStatus = isConnectedInstanceStatus(status)
        ? (failures > 0 || Number(lastSeenMinutes || 0) > 30 ? "degraded" : "healthy")
        : (status === "qr_pending" || status === "connecting" ? "unstable" : "offline");
      const riskScore =
        (operationalStatus === "offline" ? 70 : operationalStatus === "unstable" ? 50 : operationalStatus === "degraded" ? 35 : 0)
        + Math.min(failures * 8, 40)
        + (Number(lastSeenMinutes || 0) > 60 ? 20 : Number(lastSeenMinutes || 0) > 30 ? 10 : 0);
      const recommendedAction = operationalStatus === "offline"
        ? "Acionar reconexao preventiva e avisar suporte antes do cliente abrir chamado."
        : operationalStatus === "unstable"
          ? "Verificar QR/conexao em andamento e concluir pareamento."
          : operationalStatus === "degraded"
            ? "Investigar falhas recentes de mensagem/webhook e latencia."
            : "Sem acao imediata.";
      return {
        ...row,
        status,
        operational_status: operationalStatus,
        risk_score: Math.min(riskScore, 100),
        last_seen_minutes: lastSeenMinutes,
        recommended_action: recommendedAction,
        active_webhooks: Number(row.active_webhooks || 0),
        messages_24h: Number(row.messages_24h || 0),
        message_failures_24h: Number(row.message_failures_24h || 0),
        webhook_failures_24h: Number(row.webhook_failures_24h || 0),
        avg_webhook_duration_ms: Math.round(Number(row.avg_webhook_duration_ms || 0))
      };
    });

    const metrics = {
      instances_online: instanceRows.filter((row) => isConnectedInstanceStatus(row.status)).length,
      instances_offline: instanceRows.filter((row) => ["offline", "disconnected", "logged_out"].includes(row.operational_status) || ["disconnected", "logged_out"].includes(row.status)).length,
      instances_unstable: instanceRows.filter((row) => ["degraded", "unstable"].includes(row.operational_status)).length,
      messages_24h: instanceRows.reduce((total, row) => total + Number(row.messages_24h || 0), 0),
      message_failures_24h: instanceRows.reduce((total, row) => total + Number(row.message_failures_24h || 0), 0),
      webhooks_configured: (await get(`SELECT COUNT(*) AS total FROM instance_webhooks WHERE 1=1${isGlobalMonitor ? "" : " AND account_id = ?"}`, isGlobalMonitor ? [] : [req.accountId]))?.total || 0,
      webhooks_active: (await get(`SELECT COUNT(*) AS total FROM instance_webhooks WHERE is_active = 1${isGlobalMonitor ? "" : " AND account_id = ?"}`, isGlobalMonitor ? [] : [req.accountId]))?.total || 0,
      webhook_failures_24h: instanceRows.reduce((total, row) => total + Number(row.webhook_failures_24h || 0), 0),
      webhook_success_24h: (await get(`SELECT COUNT(*) AS total FROM webhook_delivery_logs WHERE success = 1 AND created_at >= datetime('now','-24 hours')${isGlobalMonitor ? "" : " AND account_id = ?"}`, isGlobalMonitor ? [] : [req.accountId]))?.total || 0,
      webhook_retrying: (await get(`SELECT COUNT(*) AS total FROM webhook_events WHERE status = 'retrying'${isGlobalMonitor ? "" : " AND account_id = ?"}`, isGlobalMonitor ? [] : [req.accountId]))?.total || 0,
      webhook_pending: (await get(`SELECT COUNT(*) AS total FROM webhook_events WHERE status = 'pending'${isGlobalMonitor ? "" : " AND account_id = ?"}`, isGlobalMonitor ? [] : [req.accountId]))?.total || 0,
      wooapi_events_24h: (await get(`SELECT COUNT(*) AS total FROM wooapi_events WHERE created_at >= datetime('now','-24 hours')${isGlobalMonitor ? "" : " AND account_id = ?"}`, isGlobalMonitor ? [] : [req.accountId]))?.total || 0,
      open_alerts: (await get(`SELECT COUNT(*) AS total FROM support_alerts WHERE status = 'open'${isGlobalMonitor ? "" : " AND account_id = ?"}`, isGlobalMonitor ? [] : [req.accountId]))?.total || 0,
      avg_webhook_duration_ms: Math.round(Number((await get(`SELECT AVG(duration_ms) AS total FROM webhook_delivery_logs WHERE created_at >= datetime('now','-24 hours')${isGlobalMonitor ? "" : " AND account_id = ?"}`, isGlobalMonitor ? [] : [req.accountId]))?.total || 0)),
      pending_jobs: queues.reduce((total, queue) => total + Number(queue.pending || 0) + Number(queue.active || 0), 0)
    };

    const criticalInstances = instanceRows.filter((row) => ["critical", "offline"].includes(row.operational_status) || Number(row.risk_score || 0) >= 70);
    const degradedInstances = instanceRows.filter((row) => ["degraded", "unstable"].includes(row.operational_status));
    const queueOutages = queues.filter((queue) => !queue.available);
    const totalWebhookAttempts = Number(metrics.webhook_success_24h || 0) + Number(metrics.webhook_failures_24h || 0);
    const webhookSuccessRate = totalWebhookAttempts ? Math.round((Number(metrics.webhook_success_24h || 0) / totalWebhookAttempts) * 1000) / 10 : 100;
    const globalSeverity = criticalInstances.length || queueOutages.length ? "critical"
      : degradedInstances.length || Number(metrics.webhook_failures_24h || 0) > 0 || Number(metrics.message_failures_24h || 0) > 0 ? "warning"
        : "healthy";
    const nocSummary = {
      severity: globalSeverity,
      headline: globalSeverity === "critical"
        ? "Incidente operacional exige acao imediata"
        : globalSeverity === "warning"
          ? "Operacao com risco preventivo"
          : "Operacao nominal",
      critical_count: criticalInstances.length,
      degraded_count: degradedInstances.length,
      queue_outages: queueOutages.length,
      webhook_success_rate: webhookSuccessRate,
      watchlist: instanceRows
        .filter((row) => Number(row.risk_score || 0) > 0)
        .sort((a, b) => Number(b.risk_score || 0) - Number(a.risk_score || 0))
        .slice(0, 8),
      next_actions: [
        ...(criticalInstances.length ? [`Reconectar/verificar ${criticalInstances.length} instancia(s) critica(s).`] : []),
        ...(queueOutages.length ? [`Restaurar ${queueOutages.length} fila(s)/worker(s) indisponivel(is).`] : []),
        ...(Number(metrics.webhook_failures_24h || 0) > 0 ? [`Revisar ${metrics.webhook_failures_24h} falha(s) de webhook nas ultimas 24h.`] : []),
        ...(Number(metrics.message_failures_24h || 0) > 0 ? [`Investigar ${metrics.message_failures_24h} falha(s) de envio nas ultimas 24h.`] : []),
        ...(!criticalInstances.length && !queueOutages.length && !Number(metrics.webhook_failures_24h || 0) && !Number(metrics.message_failures_24h || 0) ? ["Manter monitoramento ativo e validar alertas preventivos diariamente."] : [])
      ].slice(0, 6)
    };

    const syntheticAlerts = [
      ...(metrics.instances_offline > 0 ? [{
        severity: "warning",
        type: "instance_disconnected",
        title: "Instancias offline",
        description: `${metrics.instances_offline} instancia(s) precisam de atencao.`
      }] : []),
      ...(metrics.webhook_failures_24h > 0 ? [{
        severity: "warning",
        type: "webhook_failure_rate_high",
        title: "Falhas recentes de webhook",
        description: `${metrics.webhook_failures_24h} falha(s) nas ultimas 24h.`
      }] : []),
      ...(metrics.pending_jobs > 1000 ? [{
        severity: "critical",
        type: "queue_backlog_high",
        title: "Fila com backlog alto",
        description: `${metrics.pending_jobs} job(s) pendente(s)/ativos.`
      }] : []),
      ...(queues.some((queue) => !queue.available) ? [{
        severity: "critical",
        type: "worker_down",
        title: "Redis ou filas indisponiveis",
        description: "Uma ou mais filas BullMQ nao responderam."
      }] : [])
    ];

    return publicSuccess(res, {
      generated_at: new Date().toISOString(),
      noc: nocSummary,
      metrics,
      queues,
      instances: instanceRows,
      webhooks: (await query(`
        SELECT instance_webhooks.id,
               instance_webhooks.account_id,
               accounts.name AS account_name,
               instance_webhooks.instance_id,
               instances.name AS instance_name,
               instance_webhooks.name,
               instance_webhooks.url,
               instance_webhooks.events,
               instance_webhooks.is_active,
               instance_webhooks.retry_enabled,
               instance_webhooks.max_attempts,
               instance_webhooks.created_at,
               instance_webhooks.updated_at
        FROM instance_webhooks
        LEFT JOIN instances ON instances.id = instance_webhooks.instance_id
        LEFT JOIN accounts ON accounts.id = instance_webhooks.account_id
        WHERE 1=1${isGlobalMonitor ? "" : " AND instance_webhooks.account_id = ?"}
        ORDER BY instance_webhooks.updated_at DESC, instance_webhooks.id DESC
        LIMIT 100
      `, isGlobalMonitor ? [] : [req.accountId])).map((row) => ({
        ...row,
        events: parseJsonList(row.events),
        is_active: Number(row.is_active ?? 1) === 1,
        retry_enabled: Number(row.retry_enabled ?? 1) === 1
      })),
      recent_webhook_logs: (await query(`
        SELECT webhook_delivery_logs.id,
               webhook_delivery_logs.account_id,
               accounts.name AS account_name,
               webhook_delivery_logs.instance_id,
               instances.name AS instance_name,
               webhook_delivery_logs.webhook_id,
               instance_webhooks.name AS webhook_name,
               webhook_delivery_logs.event,
               webhook_delivery_logs.url,
               webhook_delivery_logs.status_code,
               webhook_delivery_logs.success,
               webhook_delivery_logs.attempt,
               webhook_delivery_logs.error,
               webhook_delivery_logs.duration_ms,
               webhook_delivery_logs.created_at
        FROM webhook_delivery_logs
        LEFT JOIN accounts ON accounts.id = webhook_delivery_logs.account_id
        LEFT JOIN instances ON instances.id = webhook_delivery_logs.instance_id
        LEFT JOIN instance_webhooks ON instance_webhooks.id = webhook_delivery_logs.webhook_id
        WHERE 1=1${isGlobalMonitor ? "" : " AND webhook_delivery_logs.account_id = ?"}
        ORDER BY webhook_delivery_logs.id DESC
        LIMIT 50
      `, isGlobalMonitor ? [] : [req.accountId])).map((row) => ({ ...row, success: Number(row.success || 0) === 1 })),
      recent_events: await query(`
        SELECT wooapi_events.id,
               wooapi_events.account_id,
               accounts.name AS account_name,
               wooapi_events.instance_id,
               instances.name AS instance_name,
               wooapi_events.event_id,
               wooapi_events.event,
               wooapi_events.created_at
        FROM wooapi_events
        LEFT JOIN accounts ON accounts.id = wooapi_events.account_id
        LEFT JOIN instances ON instances.id = wooapi_events.instance_id
        WHERE 1=1${isGlobalMonitor ? "" : " AND wooapi_events.account_id = ?"}
        ORDER BY wooapi_events.id DESC
        LIMIT 50
      `, isGlobalMonitor ? [] : [req.accountId]),
      alerts: [
        ...(await query(`SELECT id, account_id, instance_id, severity, type, title, description, status, opened_at FROM support_alerts WHERE status = 'open'${isGlobalMonitor ? "" : " AND account_id = ?"} ORDER BY id DESC LIMIT 50`, isGlobalMonitor ? [] : [req.accountId])),
        ...syntheticAlerts.map((alert, index) => ({ id: `synthetic_${index}`, status: "open", opened_at: new Date().toISOString(), ...alert }))
      ],
      live_logs: await getMergedLiveLogs({ accountId: isGlobalMonitor ? null : Number(req.accountId), limit: 80 }),
      core_nodes: await query("SELECT * FROM core_nodes ORDER BY status ASC, updated_at DESC LIMIT 100").catch(() => []),
      reputation: await listReputation().catch(() => []),
      state_machine: getInstanceStateMachine(),
      traffic_policy: {
        global_per_minute: Number(process.env.TRAFFIC_GLOBAL_PER_MINUTE || 600),
        tenant_per_minute: Number(process.env.TRAFFIC_TENANT_PER_MINUTE || 120),
        instance_per_minute: Number(process.env.TRAFFIC_INSTANCE_PER_MINUTE || 20),
        phone_per_minute: Number(process.env.TRAFFIC_PHONE_PER_MINUTE || 12),
        node_per_minute: Number(process.env.TRAFFIC_NODE_PER_MINUTE || 300)
      },
      support_tickets: await query(`
        SELECT support_tickets.*,
               accounts.name AS account_name,
               instances.name AS instance_name
        FROM support_tickets
        LEFT JOIN accounts ON accounts.id = support_tickets.account_id
        LEFT JOIN instances ON instances.id = support_tickets.instance_id
        WHERE 1=1${isGlobalMonitor ? "" : " AND support_tickets.account_id = ?"}
        ORDER BY support_tickets.updated_at DESC, support_tickets.id DESC
        LIMIT 50
      `, isGlobalMonitor ? [] : [req.accountId])
    });
  });

  app.post("/api/admin/platform/core-nodes/heartbeat", async (req: AccountRequest, res) => {
    if (req.user?.role !== "super_admin") return publicError(res, 403, "FORBIDDEN", "Apenas super admin");
    const node = await registerCoreNode({
      id: String(req.body?.id || req.body?.node_id || "core-node-local"),
      region: req.body?.region,
      profile: req.body?.profile,
      ipPoolId: req.body?.ip_pool_id || req.body?.ipPoolId,
      maxInstances: Number(req.body?.max_instances || req.body?.maxInstances || 150),
      cpuPercent: Number(req.body?.cpu_percent || req.body?.cpuPercent || 0),
      memoryPercent: Number(req.body?.memory_percent || req.body?.memoryPercent || 0),
      errorRate: Number(req.body?.error_rate || req.body?.errorRate || 0),
      status: req.body?.status || "ACTIVE"
    });
    return publicSuccess(res, node, "Core node atualizado");
  });

  app.post("/api/admin/platform/core-nodes/:id/drain", async (req: AccountRequest, res) => {
    if (req.user?.role !== "super_admin") return publicError(res, 403, "FORBIDDEN", "Apenas super admin");
    const node = await setCoreNodeDrainMode(String(req.params.id), Boolean(req.body?.enabled ?? true));
    return publicSuccess(res, node, "Drain mode atualizado");
  });

  app.post("/api/admin/platform/instances/:id/assign", async (req: AccountRequest, res) => {
    const inst = await get(`SELECT id, account_id FROM instances WHERE id = ?${req.user?.role === "super_admin" ? "" : " AND account_id = ?"}`, req.user?.role === "super_admin" ? [req.params.id] : [req.params.id, req.accountId]);
    if (!inst) return publicError(res, 404, "NOT_FOUND", "Instancia nao encontrada");
    const result = await assignInstance(Number(inst.id), Number(inst.account_id));
    return publicSuccess(res, result, "Instancia atribuida pelo orchestrator");
  });

  app.post("/api/admin/platform/instances/:id/state", async (req: AccountRequest, res) => {
    const inst = await get(`SELECT id, account_id FROM instances WHERE id = ?${req.user?.role === "super_admin" ? "" : " AND account_id = ?"}`, req.user?.role === "super_admin" ? [req.params.id] : [req.params.id, req.accountId]);
    if (!inst) return publicError(res, 404, "NOT_FOUND", "Instancia nao encontrada");
    const result = await transitionInstance(Number(inst.id), Number(inst.account_id), req.body?.trigger, req.body?.metadata || {});
    return publicSuccess(res, result, "State machine processada");
  });

  app.post("/api/admin/platform/traffic/check", async (req: AccountRequest, res) => {
    const accountId = req.user?.role === "super_admin" ? Number(req.body?.account_id || req.body?.accountId || req.accountId) : Number(req.accountId);
    const instanceId = Number(req.body?.instance_id || req.body?.instanceId);
    if (!accountId || !instanceId) return publicError(res, 400, "INVALID_INPUT", "account_id e instance_id sao obrigatorios");
    const decision = await canSendMessage({
      accountId,
      instanceId,
      jid: req.body?.jid || req.body?.phone_id || req.body?.phoneId,
      phoneId: req.body?.phone_id || req.body?.phoneId || req.body?.jid,
      messageType: req.body?.message_type || req.body?.messageType || "text",
      campaignId: req.body?.campaign_id || req.body?.campaignId || null,
      priority: Number(req.body?.priority || 2)
    });
    return publicSuccess(res, decision);
  });

  app.get("/api/admin/alerts", async (req: AccountRequest, res) => {
    const status = String(req.query.status || "open");
    const isGlobalMonitor = req.user?.role === "super_admin";
    const rows = status === "all"
      ? await query(`SELECT id, account_id, instance_id, severity, type, title, description, status, metadata, opened_at, acknowledged_at, resolved_at FROM support_alerts WHERE 1=1${isGlobalMonitor ? "" : " AND account_id = ?"} ORDER BY id DESC LIMIT 100`, isGlobalMonitor ? [] : [req.accountId])
      : await query(`SELECT id, account_id, instance_id, severity, type, title, description, status, metadata, opened_at, acknowledged_at, resolved_at FROM support_alerts WHERE status = ?${isGlobalMonitor ? "" : " AND account_id = ?"} ORDER BY id DESC LIMIT 100`, isGlobalMonitor ? [status] : [status, req.accountId]);
    return publicSuccess(res, rows.map((row: any) => ({ ...row, metadata: parseJsonObject(row.metadata) })));
  });

  app.post("/api/admin/alerts/:id/acknowledge", async (req: AccountRequest, res) => {
    const alert = await get(`SELECT id FROM support_alerts WHERE id = ?${req.user?.role === "super_admin" ? "" : " AND account_id = ?"}`, req.user?.role === "super_admin" ? [req.params.id] : [req.params.id, req.accountId]);
    if (!alert) return publicError(res, 404, "NOT_FOUND", "Alerta nao encontrado");
    await run("UPDATE support_alerts SET status = 'acknowledged', acknowledged_at = CURRENT_TIMESTAMP WHERE id = ?", [req.params.id]);
    io.to("admin:monitor").emit("support.alert.resolved", { alertId: Number(req.params.id), status: "acknowledged", timestamp: new Date().toISOString() });
    return publicSuccess(res, { id: Number(req.params.id), status: "acknowledged" }, "Alerta reconhecido");
  });

  app.post("/api/admin/alerts/:id/resolve", async (req: AccountRequest, res) => {
    const alert = await get(`SELECT id FROM support_alerts WHERE id = ?${req.user?.role === "super_admin" ? "" : " AND account_id = ?"}`, req.user?.role === "super_admin" ? [req.params.id] : [req.params.id, req.accountId]);
    if (!alert) return publicError(res, 404, "NOT_FOUND", "Alerta nao encontrado");
    await run("UPDATE support_alerts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?", [req.params.id]);
    io.to("admin:monitor").emit("support.alert.resolved", { alertId: Number(req.params.id), status: "resolved", timestamp: new Date().toISOString() });
    return publicSuccess(res, { id: Number(req.params.id), status: "resolved" }, "Alerta resolvido");
  });

  app.post("/api/admin/alerts/:id/retry", async (req: AccountRequest, res) => {
    const alert = await get("SELECT id, type FROM support_alerts WHERE id = ? AND status != 'resolved'", [req.params.id]);
    if (!alert) return publicError(res, 404, "NOT_FOUND", "Alerta nao encontrado ou ja resolvido");
    const event = await get("SELECT id FROM webhook_events WHERE id = (SELECT MAX(we.id) FROM webhook_events we JOIN support_alerts sa ON sa.instance_id = we.instance_id WHERE sa.id = ?)", [req.params.id]);
    if (event) {
      await deliverWebhookEvent(Number(event.id));
      return publicSuccess(res, { alerted: true }, "Notificacao reenviada");
    }
    return publicSuccess(res, { alerted: false, reason: "Nenhum evento encontrado" });
  });

  app.post("/api/admin/alerts/:id/ai-resolve", async (req: AccountRequest, res) => {
    const alert = await get("SELECT * FROM support_alerts WHERE id = ?", [req.params.id]);
    if (!alert) return publicError(res, 404, "NOT_FOUND", "Alerta nao encontrado");
    if (!alert.account_id) return publicError(res, 400, "ALERT_WITHOUT_ACCOUNT", "Este alerta nao possui conta vinculada para abertura de ticket");
    const existing = await get("SELECT * FROM support_tickets WHERE alert_id = ? ORDER BY id DESC LIMIT 1", [alert.id]);
    if (existing) return publicSuccess(res, { ticket: existing, escalated: true }, "Ticket ja existia para este alerta");
    const message = `${alert.title || "Alerta operacional"}: ${alert.description || alert.type || ""}`;
    const ticket = await createSupportTicket({
      accountId: Number(alert.account_id || 0),
      instanceId: alert.instance_id ? Number(alert.instance_id) : null,
      alertId: Number(alert.id),
      subject: String(alert.title || "Alerta operacional"),
      priority: alert.severity === "critical" ? "high" : "normal",
      source: "monitor_ai",
      aiSummary: "Alerta recebido pelo monitor global. Agente tentou classificar e escalou para revisao humana.",
      firstMessage: message,
      userId: Number(req.user?.userId || 0) || null
    });
    await addSupportTicketMessage(Number(ticket?.id), Number(alert.account_id || 0), null, "ai", "Abri este ticket automaticamente porque o alerta precisa de acompanhamento humano no console global.", { alertId: alert.id });
    return publicSuccess(res, { ticket, escalated: true }, "Ticket aberto pelo agente");
  });

  app.get("/api/admin/support/tickets", async (req: AccountRequest, res) => {
    const status = String(req.query.status || "all");
    const rows = status === "all"
      ? await query(`
        SELECT support_tickets.*, accounts.name AS account_name, instances.name AS instance_name
        FROM support_tickets
        LEFT JOIN accounts ON accounts.id = support_tickets.account_id
        LEFT JOIN instances ON instances.id = support_tickets.instance_id
        ORDER BY support_tickets.updated_at DESC, support_tickets.id DESC
        LIMIT 150
      `)
      : await query(`
        SELECT support_tickets.*, accounts.name AS account_name, instances.name AS instance_name
        FROM support_tickets
        LEFT JOIN accounts ON accounts.id = support_tickets.account_id
        LEFT JOIN instances ON instances.id = support_tickets.instance_id
        WHERE support_tickets.status = ?
        ORDER BY support_tickets.updated_at DESC, support_tickets.id DESC
        LIMIT 150
      `, [status]);
    return publicSuccess(res, rows);
  });

  app.get("/api/admin/support/tickets/:id/messages", async (req: AccountRequest, res) => {
    const ticket = await get("SELECT * FROM support_tickets WHERE id = ?", [req.params.id]);
    if (!ticket) return publicError(res, 404, "NOT_FOUND", "Ticket nao encontrado");
    const rows = await query("SELECT * FROM support_ticket_messages WHERE ticket_id = ? ORDER BY id ASC", [ticket.id]);
    return publicSuccess(res, rows.map((row: any) => ({ ...row, metadata: parseJsonObject(row.metadata) })));
  });

  app.patch("/api/admin/support/tickets/:id", async (req: AccountRequest, res) => {
    const ticket = await get("SELECT * FROM support_tickets WHERE id = ?", [req.params.id]);
    if (!ticket) return publicError(res, 404, "NOT_FOUND", "Ticket nao encontrado");
    const status = String(req.body?.status || ticket.status);
    const assignedTo = req.body?.assigned_to === undefined ? ticket.assigned_to : String(req.body.assigned_to || "");
    const resolvedAtSql = status === "resolved" ? ", resolved_at = CURRENT_TIMESTAMP" : "";
    await run(`UPDATE support_tickets SET status = ?, assigned_to = ?, updated_at = CURRENT_TIMESTAMP${resolvedAtSql} WHERE id = ?`, [status, assignedTo, ticket.id]);
    const updated = await get("SELECT * FROM support_tickets WHERE id = ?", [ticket.id]);
    io.to(`account:${ticket.account_id}`).emit("support.ticket.updated", updated);
    io.to("admin:monitor").emit("support.ticket.updated", updated);
    return publicSuccess(res, updated);
  });

  app.post("/api/admin/support/tickets/:id/messages", async (req: AccountRequest, res) => {
    const ticket = await get("SELECT * FROM support_tickets WHERE id = ?", [req.params.id]);
    if (!ticket) return publicError(res, 404, "NOT_FOUND", "Ticket nao encontrado");
    const message = String(req.body?.message || "").trim();
    if (!message) return publicError(res, 400, "VALIDATION_ERROR", "Mensagem obrigatoria");
    const row = await addSupportTicketMessage(Number(ticket.id), Number(ticket.account_id), Number(req.user?.userId || 0) || null, "human", message, { via: "admin_panel" });
    await run("UPDATE support_tickets SET status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [ticket.id]);
    return publicSuccess(res, row);
  });

  app.get("/api/support/tickets", async (req: AccountRequest, res) => {
    const rows = await query("SELECT * FROM support_tickets WHERE account_id = ? ORDER BY updated_at DESC, id DESC LIMIT 100", [req.accountId]);
    return publicSuccess(res, rows);
  });

  app.post("/api/support/tickets", async (req: AccountRequest, res) => {
    const subject = String(req.body?.subject || "Novo atendimento").trim();
    const message = String(req.body?.message || subject).trim();
    const instanceId = req.body?.instance_id ? Number(req.body.instance_id) : null;
    if (instanceId) {
      const inst = await get("SELECT id FROM instances WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [instanceId, req.accountId]);
      if (!inst) return publicError(res, 404, "INSTANCE_NOT_FOUND", "Instancia nao encontrada");
    }
    const ticket = await createSupportTicket({
      accountId: Number(req.accountId),
      instanceId,
      subject,
      priority: String(req.body?.priority || "normal"),
      source: "customer_panel",
      firstMessage: message,
      userId: Number(req.user?.userId || 0) || null
    });
    return publicSuccess(res, ticket, "Ticket aberto");
  });

  app.get("/api/support/tickets/:id/messages", async (req: AccountRequest, res) => {
    const ticket = await get("SELECT * FROM support_tickets WHERE id = ? AND account_id = ?", [req.params.id, req.accountId]);
    if (!ticket) return publicError(res, 404, "NOT_FOUND", "Ticket nao encontrado");
    const rows = await query("SELECT * FROM support_ticket_messages WHERE ticket_id = ? ORDER BY id ASC", [ticket.id]);
    return publicSuccess(res, rows.map((row: any) => ({ ...row, metadata: parseJsonObject(row.metadata) })));
  });

  app.post("/api/support/tickets/:id/messages", async (req: AccountRequest, res) => {
    const ticket = await get("SELECT * FROM support_tickets WHERE id = ? AND account_id = ?", [req.params.id, req.accountId]);
    if (!ticket) return publicError(res, 404, "NOT_FOUND", "Ticket nao encontrado");
    const message = String(req.body?.message || "").trim();
    if (!message) return publicError(res, 400, "VALIDATION_ERROR", "Mensagem obrigatoria");
    const row = await addSupportTicketMessage(Number(ticket.id), Number(req.accountId), Number(req.user?.userId || 0) || null, "customer", message);
    await run("UPDATE support_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [ticket.id]);
    return publicSuccess(res, row);
  });

  app.post("/api/support/chat", async (req: AccountRequest, res) => {
    const message = String(req.body?.message || "").trim();
    if (!message) return publicError(res, 400, "VALIDATION_ERROR", "Mensagem obrigatoria");
    const instanceId = req.body?.instance_id ? Number(req.body.instance_id) : null;
    if (instanceId) {
      const inst = await get("SELECT id FROM instances WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [instanceId, req.accountId]);
      if (!inst) return publicError(res, 404, "INSTANCE_NOT_FOUND", "Instancia nao encontrada");
    }
    const result = await supportAgentReply({
      accountId: Number(req.accountId),
      instanceId,
      message,
      userId: Number(req.user?.userId || 0) || null
    });
    return publicSuccess(res, result);
  });

  app.get("/api/admin/backups", async (_req: AccountRequest, res) => {
    const backups = fs.existsSync(BACKUP_DIR)
      ? fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const manifestPath = path.join(BACKUP_DIR, entry.name, "manifest.json");
          return fs.existsSync(manifestPath)
            ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
            : { id: entry.name };
        })
        .sort((a, b) => String(b.created_at || b.id).localeCompare(String(a.created_at || a.id)))
      : [];
    return publicSuccess(res, backups);
  });

  app.post("/api/admin/backups", async (req: AccountRequest, res) => {
    const manifest = await createOperationalBackup(Number(req.user?.userId || 0) || null);
    await audit(null, Number(req.user?.userId || 0) || null, "admin.backup.created", manifest);
    return publicSuccess(res, manifest, "Backup criado");
  });

  app.post("/api/admin/backups/:id/restore", async (req: AccountRequest, res) => {
    if (!ALLOW_RESTORE) {
      return publicError(res, 403, "RESTORE_DISABLED", "Defina ALLOW_RESTORE=true durante uma janela de manutencao para restaurar backups.");
    }
    if (DATABASE_URL) {
      return publicError(res, 400, "POSTGRES_RESTORE_EXTERNAL", "Restaure o PostgreSQL/Supabase pelo provedor ou pg_restore. Este endpoint restaura apenas artefatos locais.");
    }
    const id = safeBackupId(req.params.id);
    const dir = path.join(BACKUP_DIR, id);
    if (!id || !fs.existsSync(path.join(dir, "manifest.json"))) {
      return publicError(res, 404, "BACKUP_NOT_FOUND", "Backup nao encontrado");
    }
    const sqlitePath = path.join(dataDir, process.env.SQLITE_FILENAME || "database.db");
    const bridgeDbPath = path.resolve(process.env.BRIDGE_DB_PATH || path.join(dataDir, "wooapi_bridge.db"));
    const bridgeMediaPath = path.resolve(process.env.BRIDGE_MEDIA_CACHE_DIR || path.join(process.cwd(), "go-bridge", "media-cache"));
    copyIfExists(path.join(dir, "database.db"), sqlitePath);
    copyIfExists(path.join(dir, "database.db-wal"), `${sqlitePath}-wal`);
    copyIfExists(path.join(dir, "database.db-shm"), `${sqlitePath}-shm`);
    copyIfExists(path.join(dir, "wooapi_bridge.db"), bridgeDbPath);
    copyIfExists(path.join(dir, "wooapi_bridge.db-wal"), `${bridgeDbPath}-wal`);
    copyIfExists(path.join(dir, "wooapi_bridge.db-shm"), `${bridgeDbPath}-shm`);
    copyIfExists(path.join(dir, "media-cache"), bridgeMediaPath);
    await audit(null, Number(req.user?.userId || 0) || null, "admin.backup.restored", { id });
    return publicSuccess(res, { id }, "Backup restaurado. Reinicie os servicos para aplicar tudo.");
  });

  app.get("/api/admin/external-integrations", async (_req: AccountRequest, res) => {
    const rows = await query(`
      SELECT external_integrations.*,
             COALESCE(access_counts.total, 0) AS allowed_accounts
      FROM external_integrations
      LEFT JOIN (
        SELECT integration_id, COUNT(*) AS total
        FROM external_integration_account_access
        WHERE enabled = 1
        GROUP BY integration_id
      ) access_counts ON access_counts.integration_id = external_integrations.id
      ORDER BY external_integrations.created_at DESC
    `);
    return publicSuccess(res, rows.map((row: any) => ({
      ...row,
      admin_key_masked: maskSecret(row.admin_key),
      admin_key: undefined,
      is_active: Number(row.is_active ?? 1) === 1
    })));
  });

  app.post("/api/admin/external-integrations", async (req: AccountRequest, res) => {
    const name = String(req.body?.name || "").trim();
    const baseUrl = String(req.body?.base_url || req.body?.baseUrl || "").trim();
    const adminKey = String(req.body?.admin_key || req.body?.adminKey || "").trim();
    if (!name || !baseUrl || !adminKey) return publicError(res, 400, "VALIDATION_ERROR", "Nome, URL base e chave admin sao obrigatorios");
    const info = await run(`
      INSERT INTO external_integrations (provider, name, base_url, admin_key, auth_header, auth_prefix, list_instances_path, create_instance_path, is_active, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      String(req.body?.provider || "evolution_api"),
      name,
      baseUrl,
      adminKey,
      String(req.body?.auth_header || "apikey"),
      String(req.body?.auth_prefix || ""),
      normalizeExternalPath(req.body?.list_instances_path, "/instance/fetchInstances"),
      normalizeExternalPath(req.body?.create_instance_path, "/instance/create"),
      req.body?.is_active === false ? 0 : 1,
      String(req.body?.notes || "")
    ]);
    await audit(null, Number(req.user?.userId || 0) || null, "admin.external_integration.created", { id: info.lastInsertRowid, name });
    return publicSuccess(res, { id: info.lastInsertRowid }, "Integracao externa criada");
  });

  app.patch("/api/admin/external-integrations/:id", async (req: AccountRequest, res) => {
    const current: any = await get("SELECT * FROM external_integrations WHERE id = ?", [req.params.id]);
    if (!current) return publicError(res, 404, "NOT_FOUND", "Integracao externa nao encontrada");
    const next = { ...current, ...req.body };
    await run(`
      UPDATE external_integrations
      SET provider = ?, name = ?, base_url = ?, admin_key = ?, auth_header = ?, auth_prefix = ?, list_instances_path = ?, create_instance_path = ?, is_active = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      String(next.provider || "evolution_api"),
      String(next.name || current.name),
      String(next.base_url || next.baseUrl || current.base_url),
      req.body?.admin_key || req.body?.adminKey ? String(req.body?.admin_key || req.body?.adminKey) : current.admin_key,
      String(next.auth_header || "apikey"),
      String(next.auth_prefix || ""),
      normalizeExternalPath(next.list_instances_path, "/instance/fetchInstances"),
      normalizeExternalPath(next.create_instance_path, "/instance/create"),
      next.is_active === false || Number(next.is_active) === 0 ? 0 : 1,
      String(next.notes || ""),
      req.params.id
    ]);
    await audit(null, Number(req.user?.userId || 0) || null, "admin.external_integration.updated", { id: req.params.id });
    return publicSuccess(res, { id: Number(req.params.id) }, "Integracao externa atualizada");
  });

  app.get("/api/admin/external-integrations/:id/accounts", async (req: AccountRequest, res) => {
    const rows = await query(`
      SELECT accounts.id, accounts.name, accounts.owner_email, accounts.account_type, accounts.status,
             COALESCE(access.enabled, 0) AS enabled
      FROM accounts
      LEFT JOIN external_integration_account_access access
        ON access.account_id = accounts.id AND access.integration_id = ?
      WHERE accounts.deleted_at IS NULL
      ORDER BY accounts.name ASC
    `, [req.params.id]);
    return publicSuccess(res, rows.map((row: any) => ({ ...row, enabled: Number(row.enabled || 0) === 1 })));
  });

  app.patch("/api/admin/external-integrations/:id/accounts/:accountId", async (req: AccountRequest, res) => {
    const integration = await get("SELECT id FROM external_integrations WHERE id = ?", [req.params.id]);
    const account = await get("SELECT id FROM accounts WHERE id = ? AND deleted_at IS NULL", [req.params.accountId]);
    if (!integration || !account) return publicError(res, 404, "NOT_FOUND", "Integracao ou cliente nao encontrado");
    const enabled = req.body?.enabled === false || Number(req.body?.enabled) === 0 ? 0 : 1;
    const current = await get("SELECT id FROM external_integration_account_access WHERE integration_id = ? AND account_id = ?", [req.params.id, req.params.accountId]);
    if (current) {
      await run("UPDATE external_integration_account_access SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [enabled, (current as any).id]);
    } else {
      await run("INSERT INTO external_integration_account_access (integration_id, account_id, enabled) VALUES (?, ?, ?)", [req.params.id, req.params.accountId, enabled]);
    }
    await audit(Number(req.params.accountId), Number(req.user?.userId || 0) || null, "admin.external_integration.account_access", { integrationId: req.params.id, enabled });
    return publicSuccess(res, { integration_id: Number(req.params.id), account_id: Number(req.params.accountId), enabled: Boolean(enabled) });
  });

  app.post("/api/admin/external-integrations/:id/list-instances", async (req: AccountRequest, res) => {
    const integration = await get("SELECT * FROM external_integrations WHERE id = ? AND is_active = 1", [req.params.id]);
    if (!integration) return publicError(res, 404, "NOT_FOUND", "Integracao externa ativa nao encontrada");
    try {
      const data = await externalIntegrationRequest(integration, (integration as any).list_instances_path, { method: "GET" });
      await audit(null, Number(req.user?.userId || 0) || null, "admin.external_integration.instances_listed", { integrationId: req.params.id });
      return publicSuccess(res, data);
    } catch (error: any) {
      return publicError(res, 502, "EXTERNAL_SYSTEM_ERROR", sanitizePublicError(error), { status: error?.status });
    }
  });

  app.post("/api/admin/external-integrations/:id/create-instance", async (req: AccountRequest, res) => {
    const integration = await get("SELECT * FROM external_integrations WHERE id = ? AND is_active = 1", [req.params.id]);
    if (!integration) return publicError(res, 404, "NOT_FOUND", "Integracao externa ativa nao encontrada");
    const instanceName = String(req.body?.instanceName || req.body?.instance_name || req.body?.name || "").trim();
    if (!instanceName) return publicError(res, 400, "VALIDATION_ERROR", "Nome da instancia obrigatorio");
    const payload = { ...req.body, instanceName };
    delete payload.instance_name;
    try {
      const data = await externalIntegrationRequest(integration, (integration as any).create_instance_path, { method: "POST", body: payload });
      await audit(null, Number(req.user?.userId || 0) || null, "admin.external_integration.instance_created", { integrationId: req.params.id, instanceName });
      return publicSuccess(res, data, "Instancia solicitada no sistema externo");
    } catch (error: any) {
      return publicError(res, 502, "EXTERNAL_SYSTEM_ERROR", sanitizePublicError(error), { status: error?.status });
    }
  });

  app.get("/api/admin/partners", async (_req: AccountRequest, res) => {
    const rows = await query(`
      SELECT partners.*,
             COALESCE(commissions.total_amount, 0) AS total_commissions,
             COALESCE(commissions.pending_amount, 0) AS pending_commissions,
             COALESCE(commissions.paid_amount, 0) AS paid_commissions,
             COALESCE(commissions.total_count, 0) AS commission_count,
             COALESCE(referrals.total_count, 0) AS referral_count
      FROM partners
      LEFT JOIN (
        SELECT partner_id,
               SUM(amount) AS total_amount,
               SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) AS pending_amount,
               SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) AS paid_amount,
               COUNT(*) AS total_count
        FROM partner_commissions
        GROUP BY partner_id
      ) commissions ON commissions.partner_id = partners.id
      LEFT JOIN (
        SELECT partner_id, COUNT(*) AS total_count
        FROM partner_referrals
        GROUP BY partner_id
      ) referrals ON referrals.partner_id = partners.id
      ORDER BY partners.created_at DESC
    `);
    return publicSuccess(res, rows.map((row: any) => ({ ...row, referral_link: partnerReferralLink(row.referral_code) })));
  });

  app.post("/api/admin/partners", async (req: AccountRequest, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) return publicError(res, 400, "VALIDATION_ERROR", "Nome do parceiro obrigatorio");
    const referralCode = String(req.body?.referral_code || "").trim() || referralCodeFromName(name);
    const info = await run(`
      INSERT INTO partners (name, email, phone, referral_code, commission_rate, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      name,
      String(req.body?.email || ""),
      String(req.body?.phone || ""),
      referralCode,
      Number(req.body?.commission_rate || 10),
      String(req.body?.status || "active"),
      String(req.body?.notes || "")
    ]);
    await audit(null, Number(req.user?.userId || 0) || null, "admin.partner.created", { id: info.lastInsertRowid, referralCode });
    return publicSuccess(res, { id: info.lastInsertRowid, referral_code: referralCode, referral_link: partnerReferralLink(referralCode) }, "Parceiro criado");
  });

  app.patch("/api/admin/partners/:id", async (req: AccountRequest, res) => {
    const current: any = await get("SELECT * FROM partners WHERE id = ?", [req.params.id]);
    if (!current) return publicError(res, 404, "NOT_FOUND", "Parceiro nao encontrado");
    const next = { ...current, ...req.body };
    await run(`
      UPDATE partners
      SET name = ?, email = ?, phone = ?, commission_rate = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      String(next.name || current.name),
      String(next.email || ""),
      String(next.phone || ""),
      Number(next.commission_rate || 0),
      String(next.status || "active"),
      String(next.notes || ""),
      req.params.id
    ]);
    await audit(null, Number(req.user?.userId || 0) || null, "admin.partner.updated", { id: req.params.id });
    return publicSuccess(res, await get("SELECT * FROM partners WHERE id = ?", [req.params.id]));
  });

  app.get("/api/admin/partners/:id/referrals", async (req: AccountRequest, res) => {
    const rows = await query(`
      SELECT partner_referrals.*,
             accounts.name AS account_name,
             accounts.owner_name,
             accounts.owner_email,
             accounts.status AS account_status,
             accounts.created_at AS account_created_at
      FROM partner_referrals
      LEFT JOIN accounts ON accounts.id = partner_referrals.account_id
      WHERE partner_referrals.partner_id = ?
      ORDER BY partner_referrals.created_at DESC
    `, [req.params.id]);
    return publicSuccess(res, rows.map((row: any) => ({ ...row, metadata: parseJsonObject(row.metadata_json) })));
  });

  app.post("/api/admin/partners/:id/referrals", async (req: AccountRequest, res) => {
    const partner: any = await get("SELECT * FROM partners WHERE id = ?", [req.params.id]);
    if (!partner) return publicError(res, 404, "NOT_FOUND", "Parceiro nao encontrado");
    const accountId = Number(req.body?.account_id || req.body?.accountId || 0);
    const account: any = accountId ? await get("SELECT id, name, owner_email FROM accounts WHERE id = ? AND deleted_at IS NULL", [accountId]) : null;
    if (!account) return publicError(res, 404, "NOT_FOUND", "Cliente nao encontrado");
    await recordPartnerReferral(accountId, partner.referral_code, "manual_admin", {
      linked_by: req.user?.userId || null,
      account_name: account.name,
      email: account.owner_email
    });
    await audit(accountId, Number(req.user?.userId || 0) || null, "admin.partner_referral.linked", { partnerId: partner.id, referralCode: partner.referral_code });
    return publicSuccess(res, { partner_id: Number(partner.id), account_id: accountId }, "Indicacao vinculada");
  });

  app.get("/api/admin/partners/:id/commissions", async (req: AccountRequest, res) => {
    const rows = await query(`
      SELECT partner_commissions.*, accounts.name AS account_name, accounts.owner_email
      FROM partner_commissions
      LEFT JOIN accounts ON accounts.id = partner_commissions.account_id
      WHERE partner_commissions.partner_id = ?
      ORDER BY partner_commissions.created_at DESC
    `, [req.params.id]);
    return publicSuccess(res, rows);
  });

  app.post("/api/admin/partners/:id/commissions", async (req: AccountRequest, res) => {
    const partner = await get("SELECT id FROM partners WHERE id = ?", [req.params.id]);
    if (!partner) return publicError(res, 404, "NOT_FOUND", "Parceiro nao encontrado");
    const amount = Number(req.body?.amount || 0);
    if (amount <= 0) return publicError(res, 400, "VALIDATION_ERROR", "Valor da comissao deve ser maior que zero");
    const info = await run(`
      INSERT INTO partner_commissions (partner_id, account_id, amount, status, description, due_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      req.params.id,
      req.body?.account_id || null,
      amount,
      String(req.body?.status || "pending"),
      String(req.body?.description || ""),
      req.body?.due_at || null
    ]);
    await audit(null, Number(req.user?.userId || 0) || null, "admin.partner_commission.created", { partnerId: req.params.id, id: info.lastInsertRowid, amount });
    return publicSuccess(res, { id: info.lastInsertRowid }, "Comissao registrada");
  });

  app.patch("/api/admin/partner-commissions/:id", async (req: AccountRequest, res) => {
    const current: any = await get("SELECT * FROM partner_commissions WHERE id = ?", [req.params.id]);
    if (!current) return publicError(res, 404, "NOT_FOUND", "Comissao nao encontrada");
    const status = String(req.body?.status || current.status);
    const paidAt = status === "paid" ? (req.body?.paid_at || new Date().toISOString()) : current.paid_at;
    await run(`
      UPDATE partner_commissions
      SET amount = ?, status = ?, description = ?, due_at = ?, paid_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      req.body?.amount === undefined ? current.amount : Number(req.body.amount),
      status,
      req.body?.description === undefined ? current.description : String(req.body.description || ""),
      req.body?.due_at === undefined ? current.due_at : req.body.due_at,
      paidAt,
      req.params.id
    ]);
    await audit(null, Number(req.user?.userId || 0) || null, "admin.partner_commission.updated", { id: req.params.id, status });
    return publicSuccess(res, await get("SELECT * FROM partner_commissions WHERE id = ?", [req.params.id]));
  });

  app.post("/api/admin/accounts", async (req: AccountRequest, res) => {
    const { name, owner_name, owner_email, password, plan_id, status = "active", account_type = "client", instance_quota, max_client_accounts } = req.body || {};
    if (!name || !owner_name || !owner_email || !password) return res.status(400).json({ error: "Dados obrigatórios ausentes" });
    if (!accountTypes.has(String(account_type))) return res.status(400).json({ error: "Tipo de conta inválido" });
    if (!accountStatuses.has(String(status))) return res.status(400).json({ error: "Status de conta inválido" });
    if (await get("SELECT id FROM users WHERE email = ?", [owner_email])) return res.status(409).json({ error: "E-mail já cadastrado" });
    const plan = plan_id ? await get("SELECT * FROM plans WHERE id = ? AND is_active = 1", [plan_id]) : {};
    if (plan_id && !plan?.id) return res.status(400).json({ error: "Plano inativo ou inexistente" });
    if (plan_id && !plan) return res.status(400).json({ error: "Plano inativo ou inexistente" });
    const account = await run("INSERT INTO accounts (name, plan_id, account_type, instance_quota, max_client_accounts, owner_name, owner_email, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      name,
      plan_id || null,
      account_type,
      instance_quota ?? plan?.max_instances ?? 1,
      max_client_accounts ?? plan?.max_client_accounts ?? 0,
      owner_name,
      owner_email,
      status
    ]);
    const user = await run("INSERT INTO users (account_id, name, email, password, role) VALUES (?, ?, ?, ?, 'admin')", [account.lastInsertRowid, owner_name, owner_email, hashPassword(password)]);
    await audit(Number(account.lastInsertRowid), Number(req.user?.userId), "admin.account.created", { name, owner_email });
    res.json({ id: account.lastInsertRowid, owner_user_id: user.lastInsertRowid });
  });

  app.get("/api/admin/plans", async (_req, res) => res.json(await query("SELECT * FROM plans ORDER BY price ASC")));

  app.post("/api/admin/plans", async (req, res) => {
    const { name, description, price, billing_cycle, max_instances, instance_quota, max_users, max_messages, max_client_accounts, webhook_enabled, websocket_enabled, api_enabled, chatwoot_enabled, typebot_enabled, n8n_enabled, support_level, features_json, api_rate_limit_per_minute, instance_rate_limit_per_minute, message_rate_limit_per_minute } = req.body || {};
    if (!name) return res.status(400).json({ error: "Nome do plano obrigatório" });
    const quota = Number(instance_quota ?? max_instances ?? 1);
    const info = await run("INSERT INTO plans (name, description, price, billing_cycle, instance_quota, max_instances, max_users, max_messages, max_client_accounts, webhook_enabled, websocket_enabled, api_enabled, chatwoot_enabled, typebot_enabled, n8n_enabled, support_level, is_active, features_json, api_rate_limit_per_minute, instance_rate_limit_per_minute, message_rate_limit_per_minute) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)", [
      name,
      description || "",
      price || 0,
      billing_cycle || "monthly",
      quota,
      quota,
      max_users || 2,
      max_messages || 5000,
      max_client_accounts || 0,
      webhook_enabled === false ? 0 : 1,
      websocket_enabled === false ? 0 : 1,
      api_enabled === false ? 0 : 1,
      chatwoot_enabled === false ? 0 : 1,
      typebot_enabled === false ? 0 : 1,
      n8n_enabled === false ? 0 : 1,
      support_level || "standard",
      JSON.stringify(features_json || []),
      Number(api_rate_limit_per_minute || 60),
      Number(instance_rate_limit_per_minute || 30),
      Number(message_rate_limit_per_minute || 20)
    ]);
    res.json({ id: info.lastInsertRowid });
  });

  app.patch("/api/admin/plans/:id", async (req, res) => {
    const current = await get("SELECT * FROM plans WHERE id = ?", [req.params.id]);
    if (!current) return res.status(404).json({ error: "Plano não encontrado" });
    const next = { ...current, ...req.body };
    await run(
      "UPDATE plans SET name = ?, description = ?, price = ?, billing_cycle = ?, instance_quota = ?, max_instances = ?, max_users = ?, max_messages = ?, max_client_accounts = ?, webhook_enabled = ?, websocket_enabled = ?, api_enabled = ?, chatwoot_enabled = ?, typebot_enabled = ?, n8n_enabled = ?, support_level = ?, is_active = ?, features_json = ?, api_rate_limit_per_minute = ?, instance_rate_limit_per_minute = ?, message_rate_limit_per_minute = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [
        next.name,
        next.description || null,
        Number(next.price || 0),
        next.billing_cycle || "monthly",
        Number(next.instance_quota ?? next.max_instances ?? 1),
        Number(next.max_instances ?? next.instance_quota ?? 1),
        Number(next.max_users || 2),
        Number(next.max_messages || 5000),
        Number(next.max_client_accounts || 0),
        next.webhook_enabled === false || Number(next.webhook_enabled) === 0 ? 0 : 1,
        next.websocket_enabled === false || Number(next.websocket_enabled) === 0 ? 0 : 1,
        next.api_enabled === false || Number(next.api_enabled) === 0 ? 0 : 1,
        next.chatwoot_enabled === false || Number(next.chatwoot_enabled) === 0 ? 0 : 1,
        next.typebot_enabled === false || Number(next.typebot_enabled) === 0 ? 0 : 1,
        next.n8n_enabled === false || Number(next.n8n_enabled) === 0 ? 0 : 1,
        next.support_level || "standard",
        next.is_active === false || Number(next.is_active) === 0 ? 0 : 1,
        JSON.stringify(next.features_json || JSON.parse(current.features_json || "[]")),
        Number(next.api_rate_limit_per_minute || 60),
        Number(next.instance_rate_limit_per_minute || 30),
        Number(next.message_rate_limit_per_minute || 20),
        req.params.id
      ]
    );
    await audit(null, Number((req as AccountRequest).user?.userId), "admin.plan.updated", { planId: req.params.id });
    res.json(await get("SELECT * FROM plans WHERE id = ?", [req.params.id]));
  });

  app.patch("/api/admin/accounts/:id/plan", async (req, res) => {
    const planId = req.body.plan_id || null;
    const plan = planId ? await get("SELECT * FROM plans WHERE id = ? AND is_active = 1", [planId]) : null;
    if (planId && !plan?.id) return res.status(400).json({ error: "Plano inativo ou inexistente" });
    await run(
      "UPDATE accounts SET plan_id = ?, instance_quota = ?, max_client_accounts = ?, status = CASE WHEN status = 'trial' THEN 'active' ELSE status END, billing_status = CASE WHEN billing_status = 'trial' THEN 'active' ELSE billing_status END, trial_ends_at = CASE WHEN status = 'trial' THEN NULL ELSE trial_ends_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [planId, plan ? Number(plan.instance_quota ?? plan.max_instances ?? 1) : null, plan ? Number(plan.max_client_accounts || 0) : 0, req.params.id]
    );
    await audit(Number(req.params.id), Number((req as AccountRequest).user?.userId), "admin.account.plan_changed", { plan_id: planId, instance_quota: plan ? Number(plan.instance_quota ?? plan.max_instances ?? 1) : null });
    res.json({ success: true, account: await get("SELECT * FROM accounts WHERE id = ?", [req.params.id]) });
  });

  app.patch("/api/admin/accounts/:id", async (req: AccountRequest, res) => {
    const { name, status, plan_id, notes, account_type, instance_quota, max_client_accounts } = req.body || {};
    const current = await get("SELECT * FROM accounts WHERE id = ?", [req.params.id]);
    if (!current) return res.status(404).json({ error: "Conta não encontrada" });
    if (account_type !== undefined && !accountTypes.has(String(account_type))) return res.status(400).json({ error: "Tipo de conta inválido" });
    if (status !== undefined && !accountStatuses.has(String(status))) return res.status(400).json({ error: "Status de conta inválido" });
    const selectedPlan = plan_id !== undefined && plan_id ? await get("SELECT * FROM plans WHERE id = ? AND is_active = 1", [plan_id]) : null;
    if (plan_id !== undefined && plan_id && !selectedPlan?.id) return res.status(400).json({ error: "Plano inativo ou inexistente" });
    const planChanged = plan_id !== undefined && Number(plan_id || 0) !== Number(current.plan_id || 0);
    await run(
      "UPDATE accounts SET name = ?, status = ?, plan_id = ?, notes = ?, account_type = ?, instance_quota = ?, max_client_accounts = ?, billing_status = CASE WHEN ? = 1 AND billing_status = 'trial' THEN 'active' ELSE billing_status END, trial_ends_at = CASE WHEN ? = 1 AND status = 'trial' THEN NULL ELSE trial_ends_at END, paused_at = CASE WHEN ? = 'paused' THEN CURRENT_TIMESTAMP ELSE paused_at END, blocked_at = CASE WHEN ? = 'blocked' THEN CURRENT_TIMESTAMP ELSE blocked_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [
        name ?? current.name,
        planChanged && current.status === "trial" && status === undefined ? "active" : status ?? current.status,
        plan_id ?? current.plan_id,
        notes ?? current.notes,
        account_type ?? current.account_type,
        instance_quota ?? (planChanged && selectedPlan ? Number(selectedPlan.instance_quota ?? selectedPlan.max_instances ?? 1) : current.instance_quota),
        max_client_accounts ?? (planChanged && selectedPlan ? Number(selectedPlan.max_client_accounts || 0) : current.max_client_accounts),
        planChanged ? 1 : 0,
        planChanged ? 1 : 0,
        status ?? current.status,
        status ?? current.status,
        req.params.id
      ]
    );
    await audit(Number(req.params.id), Number(req.user?.userId), "admin.account.updated", { name, status, plan_id, account_type, instance_quota, max_client_accounts });
    res.json(await get("SELECT * FROM accounts WHERE id = ?", [req.params.id]));
  });

  app.get("/api/admin/accounts/:id/users", async (req, res) => {
    res.json(await query("SELECT id, account_id, name, email, role, status, created_at FROM users WHERE account_id = ? ORDER BY created_at DESC", [req.params.id]));
  });

  app.post("/api/admin/accounts/:id/impersonate", async (req: AccountRequest, res) => {
    const account = await get("SELECT * FROM accounts WHERE id = ?", [req.params.id]);
    if (!account) return res.status(404).json({ error: "Conta não encontrada" });
    const owner = await get("SELECT * FROM users WHERE account_id = ? ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, id ASC LIMIT 1", [req.params.id]);
    if (!owner) return res.status(404).json({ error: "Conta sem usuário" });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await run(
      "INSERT INTO support_sessions (super_admin_user_id, target_account_id, reason, expires_at) VALUES (?, ?, ?, ?)",
      [req.user?.userId, req.params.id, req.body?.reason || "Suporte", expiresAt]
    );
    const token = signToken({
      userId: owner.id,
      accountId: owner.account_id,
      role: owner.role,
      email: owner.email,
      impersonatedBy: req.user?.userId,
      support: true,
      exp: expiresAt
    });
    const safeOwner = { ...owner };
    delete safeOwner.password;
    await audit(Number(req.params.id), Number(req.user?.userId), "support.impersonate", { targetUserId: owner.id });
    res.json({ token, accountId: owner.account_id, account, user: safeOwner, expiresAt });
  });

  app.get("/api/reseller/overview", async (req: AccountRequest, res) => {
    const account = await get("SELECT * FROM accounts WHERE id = ?", [req.accountId]);
    const plan = await getAccountPlan(Number(req.accountId));
    const usage = await getAccountUsage(Number(req.accountId));
    const quota = await getAccountQuotaUsage(Number(req.accountId));
    const maxInstances = Number(plan?.max_instances || 0);
    const maxClients = Number(plan?.max_client_accounts || 0);
    const usedInstances = Number(usage.instances || 0) + Number(usage.allocated_child_instances || 0);
    res.json({
      account,
      plan,
      usage,
      quota,
      available_instances: maxInstances ? Math.max(maxInstances - usedInstances, 0) : null,
      available_client_accounts: maxClients ? Math.max(maxClients - Number(usage.client_accounts || 0), 0) : null
    });
  });

  app.get("/api/reseller/clients", async (req: AccountRequest, res) => {
    const rows = await Promise.all((await query(
      `SELECT accounts.*, COUNT(DISTINCT instances.id) AS instance_count
       FROM accounts
       LEFT JOIN instances ON instances.account_id = accounts.id
       WHERE accounts.parent_account_id = ?
       GROUP BY accounts.id
       ORDER BY accounts.created_at DESC`,
      [req.accountId]
    )).map(async (row) => ({ ...row, usage: await getAccountUsage(row.id) })));
    res.json(rows);
  });

  app.post("/api/reseller/clients", async (req: AccountRequest, res) => {
    const { name, owner_name, owner_email, password, instance_quota = 1, max_client_accounts = 0, status = "active" } = req.body || {};
    if (!name || !owner_name || !owner_email || !password) return res.status(400).json({ error: "Dados obrigatorios ausentes" });
    if (!accountStatuses.has(String(status))) return res.status(400).json({ error: "Status de conta invalido" });
    if (await get("SELECT id FROM users WHERE email = ?", [owner_email])) return res.status(409).json({ error: "E-mail ja cadastrado" });

    const parentPlan = await getAccountPlan(Number(req.accountId));
    const parentUsage = await getAccountUsage(Number(req.accountId));
    const maxClients = Number(parentPlan?.max_client_accounts || 0);
    if (maxClients && Number(parentUsage.client_accounts || 0) >= maxClients) {
      return res.status(403).json({ error: `Limite de clientes atingido (${parentUsage.client_accounts}/${maxClients})` });
    }

    const requestedQuota = Math.max(Number(instance_quota || 0), 0);
    const capacity = await ensureInstanceCapacity(Number(req.accountId), requestedQuota);
    if (!capacity.allowed) return res.status(403).json({ error: capacity.error });

    const account = await run(
      "INSERT INTO accounts (parent_account_id, name, plan_id, account_type, instance_quota, max_client_accounts, owner_name, owner_email, status) VALUES (?, ?, ?, 'client', ?, ?, ?, ?, ?)",
      [req.accountId, name, parentPlan?.id || null, requestedQuota, 0, owner_name, owner_email, status]
    );
    const user = await run(
      "INSERT INTO users (account_id, name, email, password, role) VALUES (?, ?, ?, ?, 'admin')",
      [account.lastInsertRowid, owner_name, owner_email, hashPassword(password)]
    );
    await audit(Number(req.accountId), Number(req.user?.userId), "reseller.client.created", { clientAccountId: account.lastInsertRowid, owner_email, instance_quota: requestedQuota });
    res.json({ id: account.lastInsertRowid, owner_user_id: user.lastInsertRowid });
  });

  app.patch("/api/reseller/clients/:id", async (req: AccountRequest, res) => {
    const current = await get("SELECT * FROM accounts WHERE id = ? AND parent_account_id = ?", [req.params.id, req.accountId]);
    if (!current) return res.status(404).json({ error: "Cliente nao encontrado" });
    const { name, status, instance_quota, max_client_accounts } = req.body || {};
    if (status !== undefined && !accountStatuses.has(String(status))) return res.status(400).json({ error: "Status de conta invalido" });
    const nextQuota = instance_quota === undefined ? Number(current.instance_quota || 0) : Math.max(Number(instance_quota || 0), 0);
    const delta = nextQuota - Number(current.instance_quota || 0);
    if (delta > 0) {
      const capacity = await ensureInstanceCapacity(Number(req.accountId), delta);
      if (!capacity.allowed) return res.status(403).json({ error: capacity.error });
    }
    await run(
      "UPDATE accounts SET name = ?, status = ?, instance_quota = ?, max_client_accounts = ? WHERE id = ? AND parent_account_id = ?",
      [name ?? current.name, status ?? current.status, nextQuota, 0, req.params.id, req.accountId]
    );
    await audit(Number(req.accountId), Number(req.user?.userId), "reseller.client.updated", { clientAccountId: req.params.id, instance_quota: nextQuota, status });
    res.json(await get("SELECT * FROM accounts WHERE id = ?", [req.params.id]));
  });

  app.post("/api/reseller/clients/:id/instances", async (req: AccountRequest, res) => {
    const child = await get("SELECT * FROM accounts WHERE id = ? AND parent_account_id = ? AND deleted_at IS NULL", [req.params.id, req.accountId]);
    if (!child) return res.status(404).json({ error: "Cliente nao encontrado" });
    if (!accountCanOperate(child)) return res.status(403).json({ error: "Cliente pausado ou bloqueado" });
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Nome da instancia obrigatorio" });
    const limit = await ensureInstanceCapacity(Number(child.id), 1);
    if (!limit.allowed) return res.status(403).json({ error: limit.error });
    const created = await createInstanceWithCredentials(Number(child.id), name, req.body?.webhook_url || req.body?.webhookUrl || req.body?.url, req.body?.engine);
    await audit(Number(req.accountId), Number(req.user?.userId), "reseller.child_instance.created", { clientAccountId: child.id, instanceId: created.id, name });
    res.json({
      id: created.id,
      account_id: child.id,
      api_key: created.apiKey,
      webhook_secret: created.webhookSecret,
      webhook: instanceWebhookPackage(created.inst, { includeSecret: true }),
      default_webhook: created.defaultWebhook ? serializeWebhook(created.defaultWebhook) : null
    });
  });

  app.get("/api/whatsapp/instances", async (req: AccountRequest, res) => {
    const rows = await query("SELECT * FROM instances WHERE account_id = ? AND deleted_at IS NULL ORDER BY id DESC", [req.accountId]);
    const instances = await Promise.all(rows.map(async (row) => {
      const inst = await syncInstanceStatusFromBridge(row);
      return {
      ...serializeInstance(inst),
      api_key: inst.api_key,
      qr: await qrToImage(inst.qr)
      };
    }));
    res.json(instances);
  });

  app.get("/api/whatsapp/instances/:id", async (req: AccountRequest, res) => {
    const row = await get("SELECT * FROM instances WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [req.params.id, req.accountId]);
    if (!row) return res.status(404).json({ error: "Instancia nao encontrada" });
    const inst = await syncInstanceStatusFromBridge(row);
    res.json({
      ...serializeInstance(inst),
      api_key: inst.api_key,
      qr: await qrToImage(inst.qr),
      last_qr: await qrToImage(inst.last_qr)
    });
  });

  app.post("/api/whatsapp/instances", async (req: AccountRequest, res) => {
    const { name } = req.body || {};
    const limit = await ensureInstanceCapacity(Number(req.accountId), 1);
    if (!limit.allowed) return res.status(403).json({ error: limit.error });
    const created = await createInstanceWithCredentials(Number(req.accountId), name, req.body?.webhook_url || req.body?.webhookUrl || req.body?.url, req.body?.engine);
    await audit(Number(req.accountId), Number(req.user?.userId), "instance.created", { instanceId: created.id, name });
    res.json({
      id: created.id,
      api_key: created.apiKey,
      webhook_secret: created.webhookSecret,
      webhook: instanceWebhookPackage(created.inst, { includeSecret: true }),
      default_webhook: created.defaultWebhook ? serializeWebhook(created.defaultWebhook) : null
    });
  });

  app.post("/api/whatsapp/instances/:id/connect", async (req: AccountRequest, res) => {
    const inst = await get("SELECT * FROM instances WHERE id = ? AND account_id = ?", [req.params.id, req.accountId]);
    if (!inst) return res.status(404).json({ error: "Instância não encontrada" });
    const forceNewQr = Boolean(req.body?.forceNewQr || req.body?.force_new_qr || req.body?.resetQr || req.body?.reset_qr);
    try {
      const result = await connectInstance(Number(req.params.id), Number(req.accountId), forceNewQr);
      res.json({ success: true, ...result });
    } catch (error) {
      await run(
        "UPDATE instances SET status = ?, connection_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ? AND deleted_at IS NULL",
        ["disconnected", "disconnected", req.params.id, req.accountId]
      ).catch(() => null);
      const rawMessage = String((error as any)?.message || error || "");
      const publicMessage = /Wozapi 2\.0 upstream|WAHA|WOZAPI_V2_UPSTREAM_URL/i.test(rawMessage)
        ? rawMessage.slice(0, 500)
        : sanitizePublicError(error);
      res.status(502).json({ error: publicMessage });
    }
  });

  app.post("/api/whatsapp/instances/:id/logout", async (req: AccountRequest, res) => {
    await bridgeFetch(`/instances/${req.params.id}/logout`, { method: "POST" }).catch(() => null);
    await run("UPDATE instances SET status = ?, connection_status = ?, qr = NULL, phone = NULL, phone_connected = NULL, jid = NULL, profile_name = NULL, profile_picture_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ?", ["none", "none", req.params.id, req.accountId]);
    io.to(`account:${req.accountId}`).emit("instance.status", { instanceId: Number(req.params.id), status: "logged_out" });
    res.json({ success: true });
  });

  app.delete("/api/whatsapp/instances/:id", async (req: AccountRequest, res) => {
    await run("UPDATE instances SET deleted_at = CURRENT_TIMESTAMP, status = ?, connection_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ?", ["disconnected", "disconnected", req.params.id, req.accountId]);
    res.json({ success: true });
  });

  app.patch("/api/whatsapp/instances/:id/webhook", async (req: AccountRequest, res) => {
    await run("UPDATE instances SET webhook_url = ? WHERE id = ? AND account_id = ?", [req.body.webhook_url || null, req.params.id, req.accountId]);
    res.json({ success: true });
  });

  app.get("/api/whatsapp/instances/:id/webhooks", async (req: AccountRequest, res) => {
    const inst = await getAccountScopedInstance(req, req.params.id);
    if (!inst) return res.json([]);
    const rows = await query("SELECT * FROM instance_webhooks WHERE account_id = ? AND instance_id = ? ORDER BY id DESC", [inst.account_id, inst.id]);
    res.json(rows.map(serializeWebhook));
  });

  app.post("/api/whatsapp/instances/:id/webhooks", async (req: AccountRequest, res) => {
    const inst = await getAccountScopedInstance(req, req.params.id);
    if (!inst) return res.status(404).json({ error: "Instancia nao encontrada" });
    if (!(await getAccountFeatureFlags(Number(inst.account_id))).webhook) return res.status(403).json({ error: "Webhook nao esta habilitado para esta conta" });
    const name = String(req.body?.name || "Webhook WooAPI").trim();
    const url = String(req.body?.url || "").trim();
    const events = Array.isArray(req.body?.events) ? req.body.events.map((item: any) => String(item)) : [];
    const retryEnabled = req.body?.retry_enabled === false ? 0 : 1;
    const maxAttempts = Math.max(1, Math.min(Number(req.body?.max_attempts || 5), 20));
    if (!isWebhookUrl(url)) return res.status(400).json({ error: "URL de webhook invalida" });
    const secret = randomToken("whsec");
    const info = await run(
      "INSERT INTO instance_webhooks (account_id, instance_id, name, url, secret, events, is_active, retry_enabled, max_attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [inst.account_id, inst.id, name, url, secret, JSON.stringify(events), 1, retryEnabled, maxAttempts]
    );
    await audit(Number(inst.account_id), Number(req.user?.userId), "webhook.created", { instanceId: inst.id, webhookId: info.lastInsertRowid });
    const row = await get("SELECT * FROM instance_webhooks WHERE id = ?", [info.lastInsertRowid]);
    res.json({ ...serializeWebhook(row), secret });
  });

  app.patch("/api/whatsapp/instances/:id/webhooks/:webhookId", async (req: AccountRequest, res) => {
    const inst = await getAccountScopedInstance(req, req.params.id);
    if (!inst) return res.status(404).json({ error: "Instancia nao encontrada" });
    const row = await get("SELECT * FROM instance_webhooks WHERE id = ? AND account_id = ? AND instance_id = ?", [req.params.webhookId, inst.account_id, inst.id]);
    if (!row) return res.status(404).json({ error: "Webhook nao encontrado" });
    const url = req.body?.url === undefined ? row.url : String(req.body.url || "").trim();
    if (!isWebhookUrl(url)) return res.status(400).json({ error: "URL de webhook invalida" });
    const events = req.body?.events === undefined
      ? parseJsonList(row.events)
      : (Array.isArray(req.body.events) ? req.body.events.map((item: any) => String(item)) : []);
    const secret = req.body?.rotate_secret ? randomToken("whsec") : row.secret;
    await run(
      "UPDATE instance_webhooks SET name = ?, url = ?, secret = ?, events = ?, is_active = ?, retry_enabled = ?, max_attempts = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [
        req.body?.name === undefined ? row.name : String(req.body.name || "").trim(),
        url,
        secret,
        JSON.stringify(events),
        req.body?.is_active === undefined ? Number(row.is_active ?? 1) : (req.body.is_active ? 1 : 0),
        req.body?.retry_enabled === undefined ? Number(row.retry_enabled ?? 1) : (req.body.retry_enabled ? 1 : 0),
        req.body?.max_attempts === undefined ? Number(row.max_attempts || 5) : Math.max(1, Math.min(Number(req.body.max_attempts || 5), 20)),
        row.id
      ]
    );
    const updated = await get("SELECT * FROM instance_webhooks WHERE id = ?", [row.id]);
    res.json(req.body?.rotate_secret ? { ...serializeWebhook(updated), secret } : serializeWebhook(updated));
  });

  app.delete("/api/whatsapp/instances/:id/webhooks/:webhookId", async (req: AccountRequest, res) => {
    const inst = await getAccountScopedInstance(req, req.params.id, "id, account_id");
    if (!inst) return res.status(404).json({ error: "Instancia nao encontrada" });
    const row = await get("SELECT id FROM instance_webhooks WHERE id = ? AND account_id = ? AND instance_id = ?", [req.params.webhookId, inst.account_id, inst.id]);
    if (!row) return res.status(404).json({ error: "Webhook nao encontrado" });
    await run("DELETE FROM instance_webhooks WHERE id = ?", [row.id]);
    res.json({ success: true, id: row.id });
  });

  app.post("/api/whatsapp/instances/:id/webhooks/:webhookId/test", async (req: AccountRequest, res) => {
    const inst = await getAccountScopedInstance(req, req.params.id);
    if (!inst) return res.status(404).json({ error: "Instancia nao encontrada" });
    const row = await get("SELECT id FROM instance_webhooks WHERE id = ? AND account_id = ? AND instance_id = ?", [req.params.webhookId, inst.account_id, inst.id]);
    if (!row) return res.status(404).json({ error: "Webhook nao encontrado" });
    const result = await dispatchWebhook(Number(inst.id), "webhook.sent", { message: "Teste de webhook WooAPI", sample: req.body || {} }, { targetWebhookId: Number(row.id), bypassEventFilter: true });
    res.json({ success: true, ...result });
  });

  app.get("/api/whatsapp/instances/:id/webhook-logs", async (req: AccountRequest, res) => {
    const inst = await getAccountScopedInstance(req, req.params.id, "id, account_id");
    if (!inst) return res.json([]);
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 300);
    res.json((await query(`
      SELECT webhook_delivery_logs.*, instance_webhooks.name AS webhook_name
      FROM webhook_delivery_logs
      LEFT JOIN instance_webhooks ON instance_webhooks.id = webhook_delivery_logs.webhook_id
      WHERE webhook_delivery_logs.account_id = ? AND webhook_delivery_logs.instance_id = ?
      ORDER BY webhook_delivery_logs.id DESC
      LIMIT ?
    `, [inst.account_id, inst.id, limit])).map((row) => ({ ...row, success: Number(row.success || 0) === 1 })));
  });

  app.get("/api/whatsapp/instances/:id/webhook-events", async (req: AccountRequest, res) => {
    const inst = await getAccountScopedInstance(req, req.params.id, "id, account_id");
    if (!inst) return res.json([]);
    res.json(await query("SELECT id, event, status, response_status, error, attempts, retry_count, last_attempt_at, next_retry_at, delivered_at, created_at FROM webhook_events WHERE account_id = ? AND instance_id = ? ORDER BY id DESC LIMIT 100", [inst.account_id, inst.id]));
  });

  app.post("/api/whatsapp/webhook-logs/:logId/retry", async (req: AccountRequest, res) => {
    const row = req.user?.role === "super_admin"
      ? await get("SELECT * FROM webhook_delivery_logs WHERE id = ?", [req.params.logId])
      : await get("SELECT * FROM webhook_delivery_logs WHERE id = ? AND account_id = ?", [req.params.logId, req.accountId]);
    if (!row) return res.status(404).json({ error: "Log de webhook nao encontrado" });
    if (!row.webhook_event_id) return res.status(400).json({ error: "Log sem evento associado" });
    const result = await enqueueWebhookDeliveryByEventId(Number(row.webhook_event_id));
    if (!result.queued) return res.status(503).json({ error: "Nao foi possivel reenfileirar", details: result });
    res.json({ success: true, ...result });
  });

  app.post("/api/whatsapp/instances/:id/api-key/regenerate", async (req: AccountRequest, res) => {
    const inst = await get("SELECT id FROM instances WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [req.params.id, req.accountId]);
    if (!inst) return res.status(404).json({ error: "Instância não encontrada" });
    const apiKey = randomToken("woo");
    await run("UPDATE instances SET api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [apiKey, inst.id]);
    await audit(Number(req.accountId), Number(req.user?.userId), "instance.api_key.regenerated", { instanceId: inst.id });
    res.json({ success: true, api_key: apiKey });
  });

  app.get("/api/whatsapp/instances/:id/live-logs", async (req: AccountRequest, res) => {
    const inst = await get("SELECT id FROM instances WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [req.params.id, req.accountId]);
    if (!inst) return res.status(404).json({ error: "Instancia nao encontrada" });
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 300);
    res.json({
      messages: (await query("SELECT id, account_id, instance_id, message_id, direction, status, details_json, created_at FROM message_logs WHERE instance_id = ? ORDER BY id DESC LIMIT ?", [inst.id, limit])).map((row) => normalizeLogRow("message", row)),
      connections: (await query("SELECT id, account_id, instance_id, event, status, details_json, created_at FROM connection_logs WHERE instance_id = ? ORDER BY id DESC LIMIT ?", [inst.id, limit])).map((row) => normalizeLogRow("connection", row)),
      webhooks: (await query("SELECT id, account_id, instance_id, event, status, response_status, error, attempts, delivered_at, created_at FROM webhook_events WHERE instance_id = ? ORDER BY id DESC LIMIT ?", [inst.id, limit])).map((row) => normalizeLogRow("webhook_event", row)),
      api: (await query("SELECT id, account_id, instance_id, method, path, status_code, error, duration_ms, created_at FROM api_request_logs WHERE instance_id = ? ORDER BY id DESC LIMIT ?", [inst.id, limit])).map((row) => normalizeLogRow("api", row)),
      all: await getMergedLiveLogs({ accountId: Number(req.accountId), instanceId: Number(inst.id), limit })
    });
  });

  app.get("/api/whatsapp/instances/:id/logs", async (req: AccountRequest, res) => {
    const inst = await get("SELECT id FROM instances WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [req.params.id, req.accountId]);
    if (!inst) return res.status(404).json({ error: "Instância não encontrada" });
    res.json({
      messages: await query("SELECT id, message_id, direction, status, details_json, created_at FROM message_logs WHERE instance_id = ? ORDER BY id DESC LIMIT 50", [inst.id]),
      connections: await query("SELECT id, event, status, details_json, created_at FROM connection_logs WHERE instance_id = ? ORDER BY id DESC LIMIT 50", [inst.id]),
      webhooks: await query("SELECT id, event, status, response_status, error, attempts, delivered_at, created_at FROM webhook_events WHERE instance_id = ? ORDER BY id DESC LIMIT 50", [inst.id])
    });
  });

  async function resolveSendInstance(accountId: number, requestedInstanceId: any, allowConnectedFallback = false) {
    const numericId = Number(requestedInstanceId);
    const requested = Number.isFinite(numericId)
      ? await get("SELECT * FROM instances WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [numericId, accountId])
      : null;
    if (requested && isConnectedInstanceStatus(requested.status)) return requested;
    if (!allowConnectedFallback) return requested;
    return await get(
      "SELECT * FROM instances WHERE account_id = ? AND deleted_at IS NULL AND status IN ('open', 'connected') ORDER BY last_seen_at DESC, connected_at DESC, updated_at DESC, id DESC LIMIT 1",
      [accountId]
    ) || requested;
  }

  function wantsAsyncSend(req: express.Request) {
    const value = req.body?.async ?? req.body?.async_send ?? req.body?.send_async ?? req.query?.async;
    const mode = String(req.body?.mode || req.body?.send_mode || req.query?.mode || "").toLowerCase();
    return value === true || value === 1 || String(value).toLowerCase() === "true" || ["async", "queued", "queue"].includes(mode);
  }

  async function handleSend(req: AccountRequest, res: express.Response, publicAccountId?: number, options: { allowConnectedFallback?: boolean } = {}) {
    let pendingMessageDbId: number | null = null;
    let pendingMessageId: string | null = null;
    let pendingInstanceId: number | null = null;
    try {
      const accountId = publicAccountId || Number(req.accountId);
      const { instanceId, jid, number, phone, text, message, conversationId, contentType = "text", mediaUrl, media_url, mimeType, mime_type, fileName, file_name } = req.body || {};
      const targetJid = resolveTargetJid(jid || number || phone);
      const outboundMediaUrl = mediaUrl || media_url || "";
      const normalizedContentType = outboundMediaUrl ? normalizeOutgoingMediaType(contentType, mimeType || mime_type) : contentType;
      const content = outboundMediaUrl || text || message || "";
      const inst = await resolveSendInstance(accountId, instanceId, Boolean(options.allowConnectedFallback));
      if (!inst) return res.status(404).json({ error: "Instância não encontrada" });
      if (!targetJid) return res.status(400).json({ error: "Destinatário inválido" });
      if (!isConnectedInstanceStatus(inst.status)) {
        const error: any = new Error("Instancia nao conectada. Conecte o WhatsApp antes de enviar.");
        error.statusCode = 409;
        error.code = "INSTANCE_NOT_CONNECTED";
        throw error;
      }

      const sendInstanceId = Number(inst.id);

      const conversation = conversationId
        ? await get("SELECT * FROM conversations WHERE id = ? AND account_id = ?", [conversationId, accountId])
        : await ensureConversation(accountId, sendInstanceId, targetJid);
      if (conversation?.id && Number(conversation.instance_id) !== sendInstanceId) {
        await run("UPDATE conversations SET instance_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ?", [sendInstanceId, conversation.id, accountId]);
        conversation.instance_id = sendInstanceId;
      }

      const pendingId = `out_${Date.now()}`;
      pendingMessageId = pendingId;
      pendingInstanceId = sendInstanceId;
      const info = await run(
        "INSERT INTO messages (account_id, instance_id, conversation_id, direction, chat_type, content_type, content_text, message_id, delivery_status, from_me, sender) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [accountId, sendInstanceId, conversation?.id, "outbound", conversation?.type || "contact", normalizedContentType, content, pendingId, "pending", 1, req.path.startsWith("/api/") ? "api" : "human"]
      );
      pendingMessageDbId = Number(info.lastInsertRowid);
      const savedPending = await get("SELECT * FROM messages WHERE id = ?", [info.lastInsertRowid]);
      await logMessage(accountId, sendInstanceId, pendingId, "outbound", "pending", { conversationId: conversation?.id });
      io.to(`account:${accountId}`).emit("message.new", { conversationId: conversation?.id, message: savedPending, conversation });

      if (wantsAsyncSend(req)) {
        if (QUEUE_DRIVER !== "bullmq") {
          const error: any = new Error("Envio assincrono requer QUEUE_DRIVER=bullmq e Redis ativo.");
          error.statusCode = 503;
          error.code = "QUEUE_UNAVAILABLE";
          throw error;
        }
        await run(
          "UPDATE conversations SET last_message_preview = ?, last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [outboundMediaUrl ? mediaPreview(normalizedContentType, content) : content, conversation?.id]
        );
        const job = await messageSendQueue.add("api-message", {
          accountId,
          instanceId: sendInstanceId,
          jid: targetJid,
          text: outboundMediaUrl ? (text || message || "") : content,
          mediaUrl: outboundMediaUrl || undefined,
          caption: outboundMediaUrl ? (text || message || "") : undefined,
          mimeType: mimeType || mime_type || "",
          fileName: fileName || file_name || "",
          type: outboundMediaUrl ? normalizedContentType : undefined,
          conversationId: conversation?.id,
          pendingMessageId: pendingId,
          messageDbId: Number(info.lastInsertRowid),
          priority: 2
        }, {
          jobId: `api-message-${info.lastInsertRowid}-${Date.now()}`
        });
        const payload = {
          queued: true,
          jobId: String(job.id),
          pendingMessageId: pendingId,
          message: savedPending
        };
        if (req.path.startsWith("/api/v1/")) {
          return res.status(202).json({ success: true, message: "Mensagem enfileirada para envio", data: payload });
        }
        return res.status(202).json({ success: true, ...payload });
      }

      const result = outboundMediaUrl
        ? await sendWhatsAppMedia(sendInstanceId, accountId, targetJid, {
            mediaUrl: outboundMediaUrl,
            caption: text || message || "",
            mimeType: mimeType || mime_type || "",
            fileName: fileName || file_name || "",
            type: normalizedContentType
          })
        : await sendWhatsAppMessage(sendInstanceId, accountId, targetJid, content);
      const providerMessageId = result?.ID || result?.id || result?.messageID || pendingId;
      await run("UPDATE messages SET message_id = ?, delivery_status = ? WHERE id = ?", [providerMessageId, "sent", info.lastInsertRowid]);
      await run("UPDATE conversations SET last_message_preview = ?, last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [outboundMediaUrl ? mediaPreview(normalizedContentType, content) : content, conversation?.id]);

      const savedMessage = await get("SELECT * FROM messages WHERE id = ?", [info.lastInsertRowid]);
      await logMessage(accountId, sendInstanceId, providerMessageId, "outbound", "sent", { conversationId: conversation?.id });
      io.to(`account:${accountId}`).emit("message.status", { messageId: providerMessageId, status: "sent" });
      await dispatchWebhook(sendInstanceId, "message.sent", { message: savedMessage, conversation }).catch(() => null);
      if (req.path.startsWith("/api/v1/")) {
        return publicSuccess(res, { providerMessageId, message: savedMessage }, "Mensagem enviada com sucesso");
      }
      return res.json({ success: true, providerMessageId, result });
    } catch (error: any) {
      console.error("[SEND_ERROR]", error);
      if (pendingMessageDbId) {
        await run("UPDATE messages SET delivery_status = ? WHERE id = ?", ["failed", pendingMessageDbId]);
      }
      if (pendingInstanceId && pendingMessageId) {
        await logMessage(Number(publicAccountId || req.accountId || 0) || null, pendingInstanceId, pendingMessageId, "outbound", "failed", { error: sanitizePublicError(error) });
        io.to(`account:${publicAccountId || req.accountId}`).emit("message.status", { messageId: pendingMessageId, status: "failed" });
      }
      let statusCode = Number(error?.statusCode || 500);
      if (statusCode < 100 || statusCode > 599) statusCode = 502;
      const publicMessage = sanitizePublicError(error);
      const has463 = /463/.test(publicMessage);
      const hint = has463
        ? ". Verifique se o numero existe no WhatsApp ou tente reconectar a instancia."
        : "";
      if (req.path.startsWith("/api/v1/")) {
        return publicError(res, statusCode, error?.code || "SEND_FAILED", publicMessage + hint);
      }
      return res.status(statusCode).json({ error: publicMessage + hint });
    }
  }

  app.post("/api/whatsapp/send", (req: AccountRequest, res) => handleSend(req, res, undefined, { allowConnectedFallback: true }));

  app.post("/api/whatsapp/send-buttons", async (req: AccountRequest, res) => {
    if (!EXPERIMENTAL_INTERACTIVE_MESSAGES) {
      return res.status(501).json({
        success: false,
        code: "INTERACTIVE_MESSAGES_OFFICIAL_ONLY",
        error: "Botões interativos foram removidos do produto vendável. Use mensagem de texto/mídia ou WhatsApp Cloud API oficial para botões nativos."
      });
    }
    const accountId = Number(req.accountId);
    const { instanceId, jid, number, phone, text, message, body, title, footer } = req.body || {};
    const targetJid = resolveTargetJid(jid || number || phone);
    const buttons = normalizeInteractiveButtons(req.body || {});
    const content = String(text || message || body || "").trim();
    if (!instanceId) return res.status(400).json({ error: "Instância obrigatória" });
    if (!targetJid) return res.status(400).json({ error: "Destinatário inválido" });
    if (!content) return res.status(400).json({ error: "Mensagem obrigatória" });
    if (!buttons.length) return res.status(400).json({ error: "Botões obrigatórios" });
    const inst = await get("SELECT * FROM instances WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [instanceId, accountId]);
    if (!inst) return res.status(404).json({ error: "Instância não encontrada" });
    if (!isConnectedInstanceStatus(inst.status)) return res.status(409).json({ error: "Instância não conectada" });

    try {
      const result = await sendWhatsAppButtons(Number(inst.id), accountId, targetJid, { title, text: content, footer, buttons });
      const providerMessageId = result?.ID || result?.id || result?.messageID || `buttons_${Date.now()}`;
      const fallbackUsed = Boolean(result.fallbackUsed);
      const storedContentType = fallbackUsed ? "text" : "buttons";
      const storedContent = fallbackUsed ? String(result.fallbackText || content) : content;
      const conversation = await ensureConversation(accountId, Number(inst.id), targetJid);
      const info = await run(
        "INSERT INTO messages (account_id, instance_id, conversation_id, direction, chat_type, content_type, content_text, message_id, delivery_status, from_me, sender, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [accountId, inst.id, conversation?.id, "outbound", conversation?.type || "contact", storedContentType, storedContent, providerMessageId, "sent", 1, "human", JSON.stringify({ title, footer, buttons, fallbackUsed, fallbackReason: result.fallbackReason || null })]
      );
      await run("UPDATE conversations SET last_message_preview = ?, last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [storedContent, conversation?.id]);
      const savedMessage = await get("SELECT * FROM messages WHERE id = ?", [info.lastInsertRowid]);
      await logMessage(accountId, Number(inst.id), providerMessageId, "outbound", "sent", { conversationId: conversation?.id, requestedContentType: "buttons", contentType: storedContentType, fallbackUsed, fallbackReason: result.fallbackReason || null });
      io.to(`account:${accountId}`).emit("message.new", { conversationId: conversation?.id, message: savedMessage, conversation });
      await dispatchWebhook(Number(inst.id), "message.sent", { message: savedMessage, conversation, buttons, fallbackUsed }).catch(() => null);
      return res.json({ success: true, providerMessageId, result, fallbackUsed });
    } catch (error) {
      return res.status(500).json({ error: sanitizePublicError(error) });
    }
  });

  app.post("/api/whatsapp/send-menu", async (req: AccountRequest, res) => {
    const accountId = Number(req.accountId);
    const { instanceId, jid, number, phone, text, message, body, title, footer, buttonText } = req.body || {};
    const targetJid = resolveTargetJid(jid || number || phone);
    const sections = normalizeInteractiveSections(req.body || {});
    const content = String(text || message || body || "").trim();
    if (!instanceId) return res.status(400).json({ error: "Instância obrigatória" });
    if (!targetJid) return res.status(400).json({ error: "Destinatário inválido" });
    if (!content) return res.status(400).json({ error: "Mensagem obrigatória" });
    if (!sections.length) return res.status(400).json({ error: "Seções ou linhas obrigatórias" });
    const inst = await get("SELECT * FROM instances WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [instanceId, accountId]);
    if (!inst) return res.status(404).json({ error: "Instância não encontrada" });
    if (!isConnectedInstanceStatus(inst.status)) return res.status(409).json({ error: "Instância não conectada" });

    try {
      const result = await sendWhatsAppList(Number(inst.id), accountId, targetJid, { title, text: content, footer, buttonText, sections });
      const providerMessageId = result?.ID || result?.id || result?.messageID || `menu_${Date.now()}`;
      const fallbackUsed = Boolean(result.fallbackUsed);
      const storedContentType = fallbackUsed ? "text" : "menu";
      const storedContent = fallbackUsed ? String(result.fallbackText || content) : content;
      const conversation = await ensureConversation(accountId, Number(inst.id), targetJid);
      const info = await run(
        "INSERT INTO messages (account_id, instance_id, conversation_id, direction, chat_type, content_type, content_text, message_id, delivery_status, from_me, sender, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [accountId, inst.id, conversation?.id, "outbound", conversation?.type || "contact", storedContentType, storedContent, providerMessageId, "sent", 1, "human", JSON.stringify({ title, footer, buttonText, sections, fallbackUsed, fallbackReason: result.fallbackReason || null })]
      );
      await run("UPDATE conversations SET last_message_preview = ?, last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [storedContent, conversation?.id]);
      const savedMessage = await get("SELECT * FROM messages WHERE id = ?", [info.lastInsertRowid]);
      await logMessage(accountId, Number(inst.id), providerMessageId, "outbound", "sent", { conversationId: conversation?.id, requestedContentType: "menu", contentType: storedContentType, fallbackUsed, fallbackReason: result.fallbackReason || null });
      io.to(`account:${accountId}`).emit("message.new", { conversationId: conversation?.id, message: savedMessage, conversation });
      await dispatchWebhook(Number(inst.id), "message.sent", { message: savedMessage, conversation, sections, fallbackUsed }).catch(() => null);
      return res.json({ success: true, providerMessageId, result, fallbackUsed });
    } catch (error) {
      return res.status(500).json({ error: sanitizePublicError(error) });
    }
  });

  app.post("/api/v1/send", async (req: AccountRequest, res) => {
    const apiKey = getApiKey(req);
    const { instanceId } = req.body || {};
    const inst = await get(`
      SELECT instances.*, accounts.status AS account_status
      FROM instances
      LEFT JOIN accounts ON accounts.id = instances.account_id
      WHERE instances.id = ? AND instances.api_key = ? AND instances.deleted_at IS NULL
    `, [instanceId, apiKey]);
    if (!inst) return publicError(res, 403, "INVALID_API_KEY", "Chave inválida para esta instância");
    if (inactiveAccountStatuses.has(String(inst.account_status || "active")) || ["blocked", "paused"].includes(String(inst.status || ""))) {
      return publicError(res, 403, "ACCOUNT_RESTRICTED", "Conta ou instância sem permissão para executar esta operação");
    }
    if (!(await getAccountFeatureFlags(Number(inst.account_id))).api) return publicError(res, 403, "PLAN_FEATURE_DISABLED", "API pública não está habilitada para esta conta");
    return handleSend(req, res, inst.account_id);
  });

  app.post("/instance/create", async (req, res) => {
    const scope = await requireUazManagement(req, res);
    if (!scope) return;
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    const requestedAccountId = Number(req.body?.account_id || req.body?.accountId || 0);
    const targetAccountId = scope.isAdmin
      ? requestedAccountId
      : Number(scope.accountId);
    if (!scope.isAdmin && requestedAccountId && requestedAccountId !== targetAccountId) {
      return res.status(403).json({ error: "token cannot create instances for another account" });
    }
    const account = targetAccountId
      ? await get("SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL", [targetAccountId])
      : await get("SELECT * FROM accounts WHERE deleted_at IS NULL ORDER BY CASE account_type WHEN 'owner' THEN 0 WHEN 'reseller' THEN 1 ELSE 2 END, id ASC LIMIT 1");
    if (!account) return res.status(404).json({ error: "account not found" });

    const limit = await ensureInstanceCapacity(Number(account.id), 1);
    if (!limit.allowed) return res.status(403).json({ error: limit.error || "instance quota exceeded", details: limit.usage });
    const created = await createInstanceWithCredentials(Number(account.id), name, req.body?.webhook_url || req.body?.webhookUrl || req.body?.url, req.body?.engine);
    return res.json({
      response: "Instance created successfully",
      instance: serializeUazInstance(created.inst),
      connected: false,
      loggedIn: false,
      name,
      token: created.apiKey,
      webhook_secret: created.webhookSecret,
      webhook: instanceWebhookPackage(created.inst, { includeSecret: true }),
      default_webhook: created.defaultWebhook ? serializeWebhook(created.defaultWebhook) : null
    });
  });

  app.get("/instance/all", async (req, res) => {
    const scope = await requireUazManagement(req, res);
    if (!scope) return;
    const rows = scope.isAdmin
      ? await query("SELECT * FROM instances WHERE deleted_at IS NULL ORDER BY id DESC")
      : await query("SELECT * FROM instances WHERE account_id = ? AND deleted_at IS NULL ORDER BY id DESC", [scope.accountId]);
    return res.json(rows.map(serializeUazInstance));
  });

  app.get("/instance/status", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const status = uazConnectionStatus(inst.connection_status || inst.status);
    const qr = status === "connected" ? null : await qrToImage(inst.qr || inst.last_qr);
    return res.json({
      instance: { ...serializeUazInstance(inst), qrcode: qr },
      status: {
        connected: status === "connected",
        loggedIn: status === "connected",
        jid: inst.jid || null
      }
    });
  });

  app.post("/instance/connect", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    try {
      await connectInstance(Number(inst.id), Number(inst.account_id));
      emitUazSse(Number(inst.id), "connection", { status: "connecting" });
      return res.json({ response: "Instance connection started", status: "connecting", instance: serializeUazInstance({ ...inst, status: "connecting" }) });
    } catch (error) {
      return res.status(502).json({ error: sanitizePublicError(error) });
    }
  });

  app.post("/instance/disconnect", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    await bridgeFetch(`/instances/${inst.id}/logout`, { method: "POST" }).catch(() => null);
    await run("UPDATE instances SET status = ?, connection_status = ?, qr = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", ["none", "none", inst.id]);
    emitUazSse(Number(inst.id), "connection", { status: "disconnected" });
    return res.json({ response: "Instance disconnected", status: "disconnected" });
  });

  app.post("/instance/reset", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    await bridgeFetch(`/instances/${inst.id}/logout`, { method: "POST" }).catch(() => null);
    try {
      await connectInstance(Number(inst.id), Number(inst.account_id));
      emitUazSse(Number(inst.id), "connection", { status: "connecting" });
      return res.json({ response: "Instance runtime reset", status: "connecting" });
    } catch (error) {
      return res.status(502).json({ error: sanitizePublicError(error) });
    }
  });

  app.delete("/instance", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    await bridgeFetch(`/instances/${inst.id}/logout`, { method: "POST" }).catch(() => null);
    await run("UPDATE instances SET status = ?, connection_status = ?, qr = NULL, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", ["disconnected", "disconnected", inst.id]);
    return res.json({ response: "Instance deleted", success: true });
  });

  app.post("/instance/updateInstanceName", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const name = String(req.body?.name || req.body?.instanceName || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    await run("UPDATE instances SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [name, inst.id]);
    return res.json({ response: "Instance name updated", instance: serializeUazInstance({ ...inst, name }) });
  });

  app.get("/webhook", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    return res.json([{
      enabled: Number(inst.webhook_enabled ?? 1) === 1,
      url: inst.webhook_url || "",
      events: parseJsonList(inst.webhook_events),
      secret: inst.webhook_secret || ""
    }]);
  });

  app.post("/webhook", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const events = Array.isArray(req.body?.events) ? req.body.events : parseJsonList(req.body?.events);
    await run("UPDATE instances SET webhook_url = ?, webhook_enabled = ?, webhook_events = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
      req.body?.url || req.body?.webhook_url || null,
      req.body?.enabled === false ? 0 : 1,
      JSON.stringify(events),
      inst.id
    ]);
    return res.json([{ enabled: req.body?.enabled === false ? false : true, url: req.body?.url || req.body?.webhook_url || "", events }]);
  });

  app.get("/webhook/errors", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    return res.json(await query("SELECT id, event, response_status, error, attempts, last_attempt_at, created_at FROM webhook_events WHERE instance_id = ? AND status IN ('failed', 'retrying') ORDER BY id DESC LIMIT 50", [inst.id]));
  });

  app.get("/sse", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": CORS_ORIGIN
    });
    const id = Number(inst.id);
    const clients = uazSseClients.get(id) || new Set<express.Response>();
    clients.add(res);
    uazSseClients.set(id, clients);
    res.write(`event: connection\n`);
    res.write(`data: ${JSON.stringify({ EventType: "connection", eventType: "connection", status: uazConnectionStatus(inst.status), instanceId: id })}\n\n`);
    const keepAlive = setInterval(() => res.write(`: keepalive ${Date.now()}\n\n`), 25000);
    req.on("close", () => {
      clearInterval(keepAlive);
      clients.delete(res);
      if (!clients.size) uazSseClients.delete(id);
    });
  });

  app.post("/send/text", sendUazText);
  app.post("/send/media", sendUazMedia);
  app.post("/send/buttons", sendUazButtons);
  app.post("/send/menu", sendUazMenu);

  app.get("/contacts", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const contacts = await query(`
      SELECT remote_jid AS jid, contact_phone AS number, title AS name, last_message_at
      FROM conversations
      WHERE account_id = ? AND instance_id = ? AND type = 'contact'
      ORDER BY last_message_at DESC
    `, [inst.account_id, inst.id]);
    return res.json({ contacts });
  });

  app.post("/contacts/list", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const limit = Math.min(Number(req.body?.limit || 50), 200);
    const offset = Math.max(Number(req.body?.offset || 0), 0);
    const contacts = await query(`
      SELECT remote_jid AS jid, contact_phone AS number, title AS name, last_message_at
      FROM conversations
      WHERE account_id = ? AND instance_id = ? AND type = 'contact'
      ORDER BY last_message_at DESC
      LIMIT ? OFFSET ?
    `, [inst.account_id, inst.id, limit, offset]);
    return res.json({ contacts, limit, offset });
  });

  app.post("/chat/find", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const search = `%${String(req.body?.query || req.body?.search || req.body?.text || "").trim()}%`;
    const rows = await query(`
      SELECT *, last_message_preview AS lastMessage
      FROM conversations
      WHERE account_id = ? AND instance_id = ?
        AND (? = '%%' OR title LIKE ? OR remote_jid LIKE ? OR contact_phone LIKE ?)
      ORDER BY last_message_at DESC
      LIMIT ?
    `, [inst.account_id, inst.id, search, search, search, search, Math.min(Number(req.body?.limit || 50), 200)]);
    return res.json({ chats: rows });
  });

  app.post("/chat/details", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const jid = resolveUazTargetJid(req.body || {});
    const row = await get("SELECT *, last_message_preview AS lastMessage FROM conversations WHERE account_id = ? AND instance_id = ? AND (remote_jid = ? OR contact_phone = ?) ORDER BY id DESC LIMIT 1", [inst.account_id, inst.id, jid, normalizePhone(jid)]);
    if (!row) return res.status(404).json({ error: "chat not found" });
    return res.json(row);
  });

  app.post("/message/find", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const jid = resolveUazTargetJid(req.body || {});
    const search = `%${String(req.body?.query || req.body?.search || req.body?.text || "").trim()}%`;
    const rows = await query(`
      SELECT messages.*
      FROM messages
      LEFT JOIN conversations ON conversations.id = messages.conversation_id
      WHERE messages.account_id = ? AND messages.instance_id = ?
        AND (? = '' OR conversations.remote_jid = ? OR conversations.contact_phone = ?)
        AND (? = '%%' OR messages.content_text LIKE ? OR messages.message_id LIKE ?)
      ORDER BY messages.created_at DESC
      LIMIT ?
    `, [inst.account_id, inst.id, jid, jid, normalizePhone(jid), search, search, search, Math.min(Number(req.body?.limit || 50), 200)]);
    return res.json({ messages: rows });
  });

  const uazBridgePost = (path: string, endpoint: string, transform?: (body: any) => any) => {
    app.post(path, async (req, res) => {
      const inst = await requireUazInstance(req, res);
      if (!inst) return;
      try {
        const body = transform ? transform(req.body || {}) : { ...(req.body || {}) };
        if ((body.number || body.phone || body.chatid || body.chatId) && !body.jid) {
          body.jid = resolveUazTargetJid(body);
        }
        const result = await callAdvancedBridge(inst, endpoint, body);
        await persistAdvancedBridgeOperation(inst, endpoint, body, result);
        return res.json(result);
      } catch (error) {
        return res.status(502).json({ success: false, error: sanitizePublicError(error) });
      }
    });
  };

  uazBridgePost("/send/location", "/send-location");
  uazBridgePost("/send/contact", "/send-contact");
  uazBridgePost("/send/reply", "/send-reply");
  uazBridgePost("/message/react", "/messages/react");
  uazBridgePost("/message/read", "/messages/read");
  uazBridgePost("/message/edit", "/messages/edit");
  uazBridgePost("/message/delete", "/messages/delete");
  uazBridgePost("/instance/presence", "/presence");
  uazBridgePost("/contact/check", "/contacts/check");
  uazBridgePost("/contact/info", "/contacts/info");
  uazBridgePost("/contact/block", "/contacts/block", (body) => ({ ...body, action: "block" }));
  uazBridgePost("/contact/unblock", "/contacts/block", (body) => ({ ...body, action: "unblock" }));
  uazBridgePost("/chat/archive", "/chats/state", (body) => ({ ...body, action: "archive", state: body.state ?? body.archive ?? true }));
  uazBridgePost("/chat/mute", "/chats/state", (body) => ({ ...body, action: "mute", state: body.state ?? body.mute ?? true }));
  uazBridgePost("/chat/pin", "/chats/state", (body) => ({ ...body, action: "pin", state: body.state ?? body.pin ?? true }));
  uazBridgePost("/profile/name", "/profile/name");
  uazBridgePost("/profile/status", "/profile/status");
  uazBridgePost("/profile/photo", "/profile/photo");
  uazBridgePost("/group/create", "/groups");
  uazBridgePost("/group/info", "/groups/info");
  uazBridgePost("/group/participants", "/groups/participants");
  uazBridgePost("/group/name", "/groups/name");
  uazBridgePost("/group/description", "/groups/topic");
  uazBridgePost("/group/photo", "/groups/photo");
  uazBridgePost("/group/invite", "/groups/invite");
  uazBridgePost("/group/join", "/groups/join");
  uazBridgePost("/group/leave", "/groups/leave");
  uazBridgePost("/group/settings", "/groups/settings");

  app.get("/profile", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    try {
      return res.json(await bridgeFetch(`/instances/${inst.id}/profile?account_id=${inst.account_id}`));
    } catch (error) {
      return res.status(502).json({ success: false, error: sanitizePublicError(error) });
    }
  });

  app.get("/group/list", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    try {
      return res.json(await bridgeFetch(`/instances/${inst.id}/groups?account_id=${inst.account_id}`));
    } catch (error) {
      return res.status(502).json({ success: false, error: sanitizePublicError(error) });
    }
  });

  app.get("/contact/sync", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    try {
      return res.json(await bridgeFetch(`/instances/${inst.id}/contacts?account_id=${inst.account_id}`));
    } catch (error) {
      return res.status(502).json({ success: false, error: sanitizePublicError(error) });
    }
  });

  app.post("/message/download", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    try {
      const file = await bridgeBinaryFetch(`/instances/${inst.id}/messages/download`, {
        method: "POST",
        body: JSON.stringify({ account_id: Number(inst.account_id), ...(req.body || {}) })
      });
      res.setHeader("Content-Type", file.contentType);
      res.setHeader("Content-Disposition", file.disposition);
      return res.send(file.bytes);
    } catch (error) {
      return res.status(502).json({ success: false, error: sanitizePublicError(error) });
    }
  });

  app.get("/globalwebhook", async (req, res) => {
    if (!requireUazAdmin(req, res)) return;
    const row = await get("SELECT setting_value FROM system_settings WHERE setting_key = ?", ["global_webhook"]);
    return res.json(parseJsonObject(row?.setting_value));
  });

  app.put("/globalwebhook", async (req, res) => {
    if (!requireUazAdmin(req, res)) return;
    const config = {
      enabled: req.body?.enabled !== false,
      url: String(req.body?.url || "").trim(),
      secret: String(req.body?.secret || randomToken("whsec")),
      events: Array.isArray(req.body?.events) ? req.body.events : [],
      max_attempts: Math.max(1, Math.min(Number(req.body?.max_attempts || 5), 20))
    };
    if (config.url && !isWebhookUrl(config.url)) return res.status(400).json({ error: "invalid webhook URL" });
    await run(
      "INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP",
      ["global_webhook", JSON.stringify(config)]
    );
    return res.json(config);
  });

  app.post("/admin/rotate-token", async (req, res) => {
    if (!requireUazAdmin(req, res)) return;
    runtimeUazAdminToken = String(req.body?.token || randomToken("admin"));
    await run(
      "INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP",
      ["uazapi_admin_token", runtimeUazAdminToken]
    );
    await audit(null, null, "admin.token.rotated", { source: "uazapi_compat" });
    return res.json({ success: true, admintoken: runtimeUazAdminToken });
  });

  app.get("/chatwoot/config", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const integration = await get("SELECT enabled, config_json, updated_at FROM integration_settings WHERE instance_id = ? AND provider = ?", [inst.id, "chatwoot"]);
    return res.json(integration ? { enabled: Boolean(integration.enabled), ...parseJsonObject(integration.config_json), updated_at: integration.updated_at } : { enabled: false });
  });

  app.put("/chatwoot/config", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    const config = {
      apiUrl: req.body?.apiUrl || req.body?.url || "https://app.chatwoot.com",
      apiToken: req.body?.apiToken || req.body?.token || "",
      accountId: Number(req.body?.accountId || req.body?.account_id || 0),
      inboxId: Number(req.body?.inboxId || req.body?.inbox_id || 0),
    };
    if (!config.apiToken || !config.accountId || !config.inboxId) {
      return publicError(res, 400, "VALIDATION_ERROR", "apiToken, accountId e inboxId são obrigatórios");
    }
    await run(
      "INSERT INTO integration_settings (account_id, instance_id, provider, enabled, config_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(instance_id, provider) DO UPDATE SET enabled = excluded.enabled, config_json = excluded.config_json, updated_at = CURRENT_TIMESTAMP",
      [inst.account_id, inst.id, "chatwoot", req.body?.enabled === false ? 0 : 1, JSON.stringify(config)]
    );
    const webhookUrl = `${APP_URL}/api/v1/integrations/chatwoot/${inst.id}/webhook`;
    if (req.body?.enabled !== false) {
      try {
        const cwUrl = config.apiUrl;
        const cwToken = config.apiToken;
        const cwAccountId = config.accountId;
        const cwInboxId = config.inboxId;
        const existingWebhooks = await fetch(`${cwUrl}/api/v1/accounts/${cwAccountId}/inboxes/${cwInboxId}/webhooks`, {
          method: "GET",
          headers: { "Content-Type": "application/json", api_access_token: cwToken }
        }).then(r => r.json()).catch(() => ({}));
        const webhooks = existingWebhooks?.payload || existingWebhooks?.data || [];
        const alreadyRegistered = Array.isArray(webhooks) && webhooks.some((w: any) => w.url === webhookUrl);
        if (!alreadyRegistered) {
          await fetch(`${cwUrl}/api/v1/accounts/${cwAccountId}/inboxes/${cwInboxId}/webhooks`, {
            method: "POST",
            headers: { "Content-Type": "application/json", api_access_token: cwToken },
            body: JSON.stringify({ url: webhookUrl, subscriptions: ["message_created", "message_updated"] })
          });
        }
      } catch (error) {
        console.warn("[CHATWOOT_WEBHOOK_REGISTRATION_FAILED]", sanitizePublicError(error));
      }
    }
    return res.json({ success: true, enabled: req.body?.enabled !== false, webhook: webhookUrl });
  });

  app.get("/quickreply", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    return res.json(await query("SELECT * FROM quick_replies WHERE account_id = ? AND is_active = 1 ORDER BY shortcut ASC", [inst.account_id]));
  });

  app.post("/quickreply", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const shortcut = String(req.body?.shortcut || req.body?.key || "").trim();
    const content = String(req.body?.content || req.body?.text || "").trim();
    if (!shortcut || !content) return res.status(400).json({ error: "shortcut and content are required" });
    await run(
      "INSERT INTO quick_replies (account_id, shortcut, title, content, media_url, is_active) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(account_id, shortcut) DO UPDATE SET title = excluded.title, content = excluded.content, media_url = excluded.media_url, is_active = 1, updated_at = CURRENT_TIMESTAMP",
      [inst.account_id, shortcut, req.body?.title || shortcut, content, req.body?.media_url || null]
    );
    return res.json({ success: true });
  });

  app.delete("/quickreply/:shortcut", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    await run("UPDATE quick_replies SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE account_id = ? AND shortcut = ?", [inst.account_id, req.params.shortcut]);
    return res.json({ success: true });
  });

  app.post("/crm/lead", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const phone = normalizePhone(req.body?.phone || req.body?.number || "");
    if (!phone) return res.status(400).json({ error: "phone is required" });
    let lead = await get("SELECT * FROM leads WHERE account_id = ? AND phone = ? ORDER BY id DESC LIMIT 1", [inst.account_id, phone]);
    if (!lead) {
      const info = await run("INSERT INTO leads (account_id, name, phone, status, kanban_status, custom_fields_json, tags_json) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        inst.account_id, req.body?.name || phone, phone, req.body?.status || "pending", req.body?.kanban_status || "new",
        JSON.stringify(req.body?.custom_fields || {}), JSON.stringify(req.body?.tags || [])
      ]);
      lead = await get("SELECT * FROM leads WHERE id = ?", [info.lastInsertRowid]);
    } else {
      await run("UPDATE leads SET name = ?, status = ?, kanban_status = ?, custom_fields_json = ?, tags_json = ? WHERE id = ?", [
        req.body?.name ?? lead.name, req.body?.status ?? lead.status, req.body?.kanban_status ?? lead.kanban_status,
        JSON.stringify(req.body?.custom_fields ?? parseJsonObject(lead.custom_fields_json)),
        JSON.stringify(req.body?.tags ?? parseJsonList(lead.tags_json)), lead.id
      ]);
      lead = await get("SELECT * FROM leads WHERE id = ?", [lead.id]);
    }
    return res.json(lead);
  });

  app.post("/crm/lead/note", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const lead = await get("SELECT id FROM leads WHERE id = ? AND account_id = ?", [req.body?.lead_id, inst.account_id]);
    if (!lead) return res.status(404).json({ error: "lead not found" });
    const info = await run("INSERT INTO lead_notes (account_id, lead_id, note) VALUES (?, ?, ?)", [inst.account_id, lead.id, req.body?.note]);
    return res.json({ success: true, id: info.lastInsertRowid });
  });

  app.post("/crm/lead/tag", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const lead = await get("SELECT id FROM leads WHERE id = ? AND account_id = ?", [req.body?.lead_id, inst.account_id]);
    if (!lead) return res.status(404).json({ error: "lead not found" });
    const tag = String(req.body?.tag || "").trim();
    await run("INSERT INTO lead_tags (account_id, lead_id, tag) VALUES (?, ?, ?) ON CONFLICT(account_id, lead_id, tag) DO NOTHING", [inst.account_id, lead.id, tag]);
    return res.json({ success: true });
  });

  app.get("/sender", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    return res.json(await query("SELECT * FROM campaigns WHERE account_id = ? AND instance_id = ? ORDER BY id DESC", [inst.account_id, inst.id]));
  });

  app.post("/sender/create", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const name = String(req.body?.name || "").trim();
    const message = String(req.body?.message_template || req.body?.message || req.body?.text || "").trim();
    if (!name || !message) return res.status(400).json({ error: "name and message are required" });
    const minDelay = Math.max(0, Number(req.body?.min_delay_ms || req.body?.minDelay || 1000));
    const maxDelay = Math.max(minDelay, Number(req.body?.max_delay_ms || req.body?.maxDelay || 3000));
    const info = await run(
      "INSERT INTO campaigns (account_id, instance_id, name, status, message_template, media_url, min_delay_ms, max_delay_ms, scheduled_at, limit_per_instance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [inst.account_id, inst.id, name, "draft", message, req.body?.media_url || null, minDelay, maxDelay, req.body?.scheduled_at || null, Math.max(1, Number(req.body?.limit_per_instance || 1))]
    );
    return res.json({ success: true, id: info.lastInsertRowid });
  });

  app.post("/sender/:id/recipients", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const campaign = await get("SELECT * FROM campaigns WHERE id = ? AND account_id = ? AND instance_id = ?", [req.params.id, inst.account_id, inst.id]);
    if (!campaign) return res.status(404).json({ error: "campaign not found" });
    const recipients = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
    let inserted = 0;
    for (const item of recipients) {
      const phone = normalizePhone(item.phone || item.number || item.jid || "");
      if (!phone) continue;
      await run(
        "INSERT INTO campaign_recipients (account_id, campaign_id, instance_id, phone, jid, variables_json, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [inst.account_id, campaign.id, inst.id, phone, resolveTargetJid(item.jid || phone), JSON.stringify(item.variables || {}), "pending"]
      );
      inserted += 1;
    }
    await run("UPDATE campaigns SET total_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?", [campaign.id, campaign.id]);
    return res.json({ success: true, inserted });
  });

  app.post("/sender/:id/start", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const campaign = await get("SELECT * FROM campaigns WHERE id = ? AND account_id = ? AND instance_id = ?", [req.params.id, inst.account_id, inst.id]);
    if (!campaign) return res.status(404).json({ error: "campaign not found" });
    return res.json({ success: true, queued: await enqueueCampaign(campaign), status: "running" });
  });

  app.post("/sender/:id/pause", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const campaign = await get("SELECT * FROM campaigns WHERE id = ? AND account_id = ? AND instance_id = ?", [req.params.id, inst.account_id, inst.id]);
    if (!campaign) return res.status(404).json({ error: "campaign not found" });
    const recipients = await query("SELECT id, job_id FROM campaign_recipients WHERE campaign_id = ? AND status = 'queued'", [campaign.id]);
    for (const recipient of recipients) {
      if (QUEUE_DRIVER === "bullmq" && recipient.job_id) {
        const job = await messageSendQueue.getJob(String(recipient.job_id));
        if (job) await job.remove().catch(() => null);
      }
      await run("UPDATE campaign_recipients SET status = 'pending', job_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [recipient.id]);
    }
    await run("UPDATE campaigns SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [campaign.id]);
    return res.json({ success: true, status: "paused" });
  });

  app.post("/sender/:id/cancel", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const campaign = await get("SELECT * FROM campaigns WHERE id = ? AND account_id = ? AND instance_id = ?", [req.params.id, inst.account_id, inst.id]);
    if (!campaign) return res.status(404).json({ error: "campaign not found" });
    const recipients = await query("SELECT job_id FROM campaign_recipients WHERE campaign_id = ? AND status IN ('pending','queued')", [campaign.id]);
    for (const recipient of recipients) {
      if (QUEUE_DRIVER !== "bullmq" || !recipient.job_id) continue;
      const job = await messageSendQueue.getJob(String(recipient.job_id));
      if (job) await job.remove().catch(() => null);
    }
    await run("UPDATE campaign_recipients SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND status IN ('pending','queued')", [campaign.id]);
    await run("UPDATE campaigns SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [campaign.id]);
    return res.json({ success: true, status: "cancelled" });
  });

  app.get("/sender/:id/report", async (req, res) => {
    const inst = await requireUazInstance(req, res);
    if (!inst) return;
    const campaign = await get("SELECT * FROM campaigns WHERE id = ? AND account_id = ? AND instance_id = ?", [req.params.id, inst.account_id, inst.id]);
    if (!campaign) return res.status(404).json({ error: "campaign not found" });
    const byStatus = await query("SELECT status, COUNT(*) AS total FROM campaign_recipients WHERE campaign_id = ? GROUP BY status", [campaign.id]);
    return res.json({ campaign, byStatus });
  });

  const uazUnsupportedPrefixes = [
    "/admin",
    "/globalwebhook",
    "/instance/updateAdminFields",
    "/instance/updateFieldsMap",
    "/instance/updateDelaySettings",
    "/instance/privacy",
    "/instance/wa_messages_limits",
    "/instance/presence",
    "/instance/proxy",
    "/proxy-managed",
    "/profile",
    "/business",
    "/call",
    "/send",
    "/message",
    "/chat",
    "/contact",
    "/labels",
    "/label",
    "/group",
    "/community",
    "/newsletter",
    "/quickreply",
    "/sender",
    "/chatwoot"
  ];

  app.use(async (req, res, next) => {
    if (!uazUnsupportedPrefixes.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) return next();
    const adminOnly = req.path.startsWith("/admin") || req.path.startsWith("/globalwebhook") || req.path === "/instance/updateAdminFields";
    if (adminOnly ? !requireUazAdmin(req, res) : !(await requireUazInstance(req, res))) return;
    return uazNotImplemented(res, `${req.method} ${req.path}`);
  });

  app.get("/api/v1/instances", async (req, res) => {
    const session = await requireV1Account(req, res);
    if (!session) return;
    const rows = await query("SELECT * FROM instances WHERE account_id = ? AND deleted_at IS NULL ORDER BY id DESC", [session.accountId]);
    const instances = await Promise.all(rows.map(async (inst) => ({ ...serializeInstance(inst), qr: await qrToImage(inst.qr) })));
    return publicSuccess(res, instances);
  });

  app.post("/api/v1/instances", async (req, res) => {
const session = await requireV1Account(req, res);
    if (!session) return;
    const name = String(req.body?.name || "").trim();
    if (!name) return publicError(res, 400, "VALIDATION_ERROR", "Nome da instância obrigatório");
    const limit = await ensureInstanceCapacity(session.accountId, 1);
    if (!limit.allowed) return publicError(res, 403, "QUOTA_EXCEEDED", limit.error || "Cota de instâncias insuficiente", { quota: limit.usage });
    const created = await createInstanceWithCredentials(Number(session.accountId), name, req.body?.webhook_url || req.body?.webhookUrl || req.body?.url, req.body?.engine);
    await audit(session.accountId, Number(session.payload.userId), "instance.created", { instanceId: created.id, name });
    return publicSuccess(res, {
      ...serializeInstance(created.inst),
      api_key: created.apiKey,
      webhook_secret: created.webhookSecret,
      webhook: instanceWebhookPackage(created.inst, { includeSecret: true }),
      default_webhook: created.defaultWebhook ? serializeWebhook(created.defaultWebhook) : null
    }, "Instancia criada com sucesso");
  });

  app.get("/api/v1/instances/:id", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    return publicSuccess(res, { ...serializeInstance(inst), qr: await qrToImage(inst.qr) });
  });

  app.get("/api/v1/instances/:id/status", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    return publicSuccess(res, {
      id: inst.id,
      name: inst.name,
      status: publicInstanceStatus(inst.status),
      connection_status: publicInstanceStatus(inst.connection_status || inst.status),
      phoneConnected: inst.phone_connected,
      profileName: inst.profile_name,
      profilePictureUrl: inst.profile_picture_url,
      updatedAt: inst.updated_at
    });
  });

  app.get("/api/v1/instances/:id/qr", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    return publicSuccess(res, { id: inst.id, status: publicInstanceStatus(inst.status), qr: await qrToImage(inst.qr) });
  });

  app.post("/api/v1/instances/:id/connect", criticalEndpointRateLimit, perInstanceRateLimit, async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    try {
      await connectInstance(Number(inst.id), Number(inst.account_id));
      return publicSuccess(res, { id: inst.id, status: "connecting" }, "Conexão iniciada com sucesso");
    } catch (error) {
      return publicError(res, 502, "CONNECT_FAILED", sanitizePublicError(error));
    }
  });

  app.post("/api/v1/instances/:id/reconnect", criticalEndpointRateLimit, perInstanceRateLimit, async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    await bridgeFetch(`/instances/${inst.id}/logout`, { method: "POST" }).catch(() => null);
    await connectInstance(Number(inst.id), Number(inst.account_id));
    return publicSuccess(res, { id: inst.id, status: "connecting" }, "Reconexão iniciada com sucesso");
  });

  app.post("/api/v1/instances/:id/logout", criticalEndpointRateLimit, perInstanceRateLimit, async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    await bridgeFetch(`/instances/${inst.id}/logout`, { method: "POST" }).catch(() => null);
    await run("UPDATE instances SET status = ?, qr = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", ["none", inst.id]);
    emitInstanceWs(Number(inst.id), "connection.status", { status: "logged_out" });
    io.to(`instance:${inst.id}`).emit("connection.status", { status: "logged_out" });
    io.to(`account:inst.account_id`).emit("instance.status", { instanceId: Number(inst.id), status: "logged_out" });
    return publicSuccess(res, { id: inst.id, status: "logged_out" }, "Logout realizado com sucesso");
  });

  function serializeWebhook(row: any) {
    return {
      id: row.id,
      instance_id: row.instance_id,
      name: row.name,
      url: row.url,
      events: parseJsonList(row.events),
      is_active: Number(row.is_active ?? 1) === 1,
      retry_enabled: Number(row.retry_enabled ?? 1) === 1,
      max_attempts: Number(row.max_attempts || 5),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  app.get("/api/v1/instances/:id/webhooks", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    const rows = await query(
      "SELECT * FROM instance_webhooks WHERE account_id = ? AND instance_id = ? ORDER BY id DESC",
      [inst.account_id, inst.id]
    );
    return publicSuccess(res, rows.map(serializeWebhook));
  });

  app.post("/api/v1/instances/:id/webhooks", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    if (!(await getAccountFeatureFlags(Number(inst.account_id))).webhook) return publicError(res, 403, "PLAN_FEATURE_DISABLED", "Webhook nao esta habilitado para esta conta");

    const name = String(req.body?.name || "Webhook WooAPI").trim();
    const url = String(req.body?.url || "").trim();
    const events = Array.isArray(req.body?.events) ? req.body.events.map((item: any) => String(item)) : [];
    const retryEnabled = req.body?.retry_enabled === false ? 0 : 1;
    const maxAttempts = Math.max(1, Math.min(Number(req.body?.max_attempts || 5), 20));
    if (!isWebhookUrl(url)) return publicError(res, 400, "VALIDATION_ERROR", "URL de webhook invalida");

    const secret = randomToken("whsec");
    const info = await run(
      "INSERT INTO instance_webhooks (account_id, instance_id, name, url, secret, events, is_active, retry_enabled, max_attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [inst.account_id, inst.id, name, url, secret, JSON.stringify(events), 1, retryEnabled, maxAttempts]
    );
    await audit(Number(inst.account_id), null, "webhook.created", { instanceId: inst.id, webhookId: info.lastInsertRowid });
    const row = await get("SELECT * FROM instance_webhooks WHERE id = ?", [info.lastInsertRowid]);
    return publicSuccess(res, { ...serializeWebhook(row), secret }, "Webhook criado com sucesso");
  });

  app.patch("/api/v1/instances/:id/webhooks/:webhook_id", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    const row = await get("SELECT * FROM instance_webhooks WHERE id = ? AND account_id = ? AND instance_id = ?", [req.params.webhook_id, inst.account_id, inst.id]);
    if (!row) return publicError(res, 404, "NOT_FOUND", "Webhook nao encontrado");

    const url = req.body?.url === undefined ? row.url : String(req.body.url || "").trim();
    if (!isWebhookUrl(url)) return publicError(res, 400, "VALIDATION_ERROR", "URL de webhook invalida");
    const events = req.body?.events === undefined
      ? parseJsonList(row.events)
      : (Array.isArray(req.body.events) ? req.body.events.map((item: any) => String(item)) : []);
    const next = {
      name: req.body?.name === undefined ? row.name : String(req.body.name || "").trim(),
      url,
      events: JSON.stringify(events),
      is_active: req.body?.is_active === undefined ? Number(row.is_active ?? 1) : (req.body.is_active ? 1 : 0),
      retry_enabled: req.body?.retry_enabled === undefined ? Number(row.retry_enabled ?? 1) : (req.body.retry_enabled ? 1 : 0),
      max_attempts: req.body?.max_attempts === undefined ? Number(row.max_attempts || 5) : Math.max(1, Math.min(Number(req.body.max_attempts || 5), 20)),
      secret: req.body?.rotate_secret ? randomToken("whsec") : row.secret
    };
    await run(
      "UPDATE instance_webhooks SET name = ?, url = ?, secret = ?, events = ?, is_active = ?, retry_enabled = ?, max_attempts = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [next.name || row.name, next.url, next.secret, next.events, next.is_active, next.retry_enabled, next.max_attempts, row.id]
    );
    const updated = await get("SELECT * FROM instance_webhooks WHERE id = ?", [row.id]);
    return publicSuccess(res, req.body?.rotate_secret ? { ...serializeWebhook(updated), secret: next.secret } : serializeWebhook(updated), "Webhook atualizado com sucesso");
  });

  app.delete("/api/v1/instances/:id/webhooks/:webhook_id", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    const row = await get("SELECT id FROM instance_webhooks WHERE id = ? AND account_id = ? AND instance_id = ?", [req.params.webhook_id, inst.account_id, inst.id]);
    if (!row) return publicError(res, 404, "NOT_FOUND", "Webhook nao encontrado");
    await run("DELETE FROM instance_webhooks WHERE id = ?", [row.id]);
    return publicSuccess(res, { id: row.id }, "Webhook removido com sucesso");
  });

  app.post("/api/v1/instances/:id/webhooks/:webhook_id/test", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    const row = await get("SELECT id FROM instance_webhooks WHERE id = ? AND account_id = ? AND instance_id = ?", [req.params.webhook_id, inst.account_id, inst.id]);
    if (!row) return publicError(res, 404, "NOT_FOUND", "Webhook nao encontrado");
    const result = await dispatchWebhook(Number(inst.id), "webhook.sent", { message: "Teste de webhook WooAPI", sample: req.body || {} }, { targetWebhookId: Number(row.id), bypassEventFilter: true });
    return publicSuccess(res, result, "Webhook de teste adicionado a fila");
  });

  app.get("/api/v1/instances/:id/webhook-logs", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 300);
    const rows = await query(`
      SELECT webhook_delivery_logs.*, instance_webhooks.name AS webhook_name
      FROM webhook_delivery_logs
      LEFT JOIN instance_webhooks ON instance_webhooks.id = webhook_delivery_logs.webhook_id
      WHERE webhook_delivery_logs.account_id = ? AND webhook_delivery_logs.instance_id = ?
      ORDER BY webhook_delivery_logs.id DESC
      LIMIT ?
    `, [inst.account_id, inst.id, limit]);
    return publicSuccess(res, rows.map((row) => ({
      ...row,
      success: Number(row.success || 0) === 1,
      request_payload: parseJsonObject(row.request_payload)
    })));
  });

  async function requireWebhookLogAccess(req: express.Request, res: express.Response) {
    const row = await get(`
      SELECT webhook_delivery_logs.*, instances.api_key, accounts.status AS account_status
      FROM webhook_delivery_logs
      LEFT JOIN instances ON instances.id = webhook_delivery_logs.instance_id
      LEFT JOIN accounts ON accounts.id = webhook_delivery_logs.account_id
      WHERE webhook_delivery_logs.id = ?
    `, [req.params.log_id]);
    if (!row) {
      publicError(res, 404, "NOT_FOUND", "Log de webhook nao encontrado");
      return null;
    }

    const bearer = String(req.headers.authorization || "");
    const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : String(req.headers["x-auth-token"] || "");
    const payload = verifyToken(token);
    const apiKey = getApiKey(req);
    const accountAllowed = payload?.accountId && (Number(payload.accountId) === Number(row.account_id) || payload.role === "super_admin");
    const instanceAllowed = apiKey && apiKey === row.api_key;
    if (!accountAllowed && !instanceAllowed) {
      publicError(res, 403, "FORBIDDEN", "Sem permissao para acessar este log");
      return null;
    }
    if (inactiveAccountStatuses.has(String(row.account_status || "active"))) {
      publicError(res, 403, "ACCOUNT_RESTRICTED", "Conta sem permissao para executar esta operacao");
      return null;
    }
    return row;
  }

  app.post("/api/v1/webhook-logs/:log_id/retry", async (req, res) => {
    const row = await requireWebhookLogAccess(req, res);
    if (!row) return;
    if (!row.webhook_event_id) return publicError(res, 400, "WEBHOOK_EVENT_NOT_FOUND", "Log sem evento de entrega associado");
    const result = await enqueueWebhookDeliveryByEventId(Number(row.webhook_event_id));
    if (!result.queued) return publicError(res, 503, "QUEUE_UNAVAILABLE", "Nao foi possivel reenfileirar o webhook", result);
    return publicSuccess(res, result, "Webhook reenfileirado com sucesso");
  });

  app.patch("/api/v1/instances/:id/webhook", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    if (!(await getAccountFeatureFlags(Number(inst.account_id))).webhook) return publicError(res, 403, "PLAN_FEATURE_DISABLED", "Webhook não está habilitado para esta conta");
    const events = Array.isArray(req.body?.events || req.body?.webhook_events) ? req.body.events || req.body.webhook_events : null;
    await run("UPDATE instances SET webhook_url = ?, webhook_enabled = ?, webhook_secret = COALESCE(?, webhook_secret), webhook_events = COALESCE(?, webhook_events), updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
      req.body?.webhook_url || req.body?.url || null,
      req.body?.enabled === false ? 0 : 1,
      req.body?.secret || null,
      events ? JSON.stringify(events) : null,
      inst.id
    ]);
    return publicSuccess(res, { id: inst.id, webhook_enabled: req.body?.enabled === false ? false : true, webhook_events: events || parseJsonList(inst.webhook_events) });
  });

  app.post("/api/v1/instances/:id/webhook/test", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    await dispatchWebhook(Number(inst.id), "webhook.sent", { message: "WooAPI webhook test", sample: req.body || {} }, { bypassEventFilter: true });
    return publicSuccess(res, { id: inst.id }, "Webhook de teste enviado com sucesso");
  });

  app.get("/api/v1/instances/:id/webhook-events", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    return publicSuccess(res, await query("SELECT id, event, status, response_status, error, attempts, retry_count, last_attempt_at, next_retry_at, delivered_at, created_at FROM webhook_events WHERE instance_id = ? ORDER BY id DESC LIMIT 100", [inst.id]));
  });

  app.post("/api/v1/instances/:id/webhook-events/:eventId/retry", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    const event = await get("SELECT id FROM webhook_events WHERE id = ? AND instance_id = ?", [req.params.eventId, inst.id]);
    if (!event) return publicError(res, 404, "NOT_FOUND", "Evento não encontrado");
    await deliverWebhookEvent(Number(event.id));
    return publicSuccess(res, await get("SELECT id, event, status, response_status, error, attempts, delivered_at FROM webhook_events WHERE id = ?", [event.id]), "Evento reenviado com sucesso");
  });

  app.get("/api/v1/webhook-templates", async (_req, res) => {
    return res.json({
      success: true,
      data: [
        {
          id: "n8n",
          name: "n8n",
          description: "Webhook para n8n. Use o nó 'Webhook' no n8n e copie a URL gerada.",
          url: "https://seu-n8n.example.com/webhook/wooapi",
          suggestedEvents: ["message.received", "message.sent", "instance.connected", "instance.disconnected"],
          icon: "n8n"
        },
        {
          id: "typebot",
          name: "Typebot",
          description: "Webhook para Typebot. Configure no bloco 'Webhook' do seu Typebot.",
          url: "https://seu-typebot.example.com/api/v1/typebots/SEU_PUBLIC_ID/startChat",
          suggestedEvents: ["message.received"],
          icon: "typebot"
        },
        {
          id: "chatwoot",
          name: "Chatwoot",
          description: "Webhook para Chatwoot. Insira esta URL no webhook do seu inbox WhatsApp.",
          url: `${APP_URL}/api/v1/integrations/chatwoot/{{INSTANCE_ID}}/webhook`,
          suggestedEvents: ["message.received", "message.sent"],
          icon: "chatwoot"
        },
        {
          id: "generic",
          name: "HTTP Genérico",
          description: "Webhook HTTP genérico compatível com qualquer sistema que aceite POST JSON.",
          url: "https://seu-sistema.example.com/webhook",
          suggestedEvents: ["message.received", "message.sent", "instance.connected", "instance.disconnected", "instance.qr"],
          icon: "webhook"
        },
        {
          id: "evolution",
          name: "Evolution API",
          description: "Formato compatível com Evolution API para migração ou integração.",
          url: "https://seu-evolution.example.com/webhook",
          suggestedEvents: ["message.received", "message.sent", "instance.connected", "instance.disconnected"],
          icon: "evolution"
        }
      ]
    });
  });

  app.post("/api/v1/instances/:id/send-text", criticalEndpointRateLimit, perInstanceRateLimit, async (req: AccountRequest, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    req.body = { ...req.body, instanceId: inst.id };
    return handleSend(req, res, inst.account_id);
  });

  app.post("/api/v1/instances/:id/send-media", criticalEndpointRateLimit, perInstanceRateLimit, async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    const requestedMediaUrl = req.body?.mediaUrl || req.body?.media_url || req.body?.url || req.body?.link;
    if (!requestedMediaUrl) return publicError(res, 400, "VALIDATION_ERROR", "mediaUrl obrigatorio");
    req.body = {
      ...req.body,
      instanceId: inst.id,
      mediaUrl: requestedMediaUrl,
      text: req.body?.caption || req.body?.text || req.body?.message || "",
      contentType: req.body?.type || req.body?.contentType || "document"
    };
    return handleSend(req, res, inst.account_id);
  });

  app.post("/api/v1/instances/:id/send-buttons", criticalEndpointRateLimit, perInstanceRateLimit, async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    if (!EXPERIMENTAL_INTERACTIVE_MESSAGES) {
      return publicError(
        res,
        501,
        "INTERACTIVE_MESSAGES_OFFICIAL_ONLY",
        "Botões interativos não fazem parte da API não oficial vendável. Use /send-text ou a WhatsApp Cloud API oficial para botões nativos."
      );
    }
    const { jid, number, phone, text, message, body, title, footer } = req.body || {};
    const targetJid = resolveTargetJid(jid || number || phone);
    const buttons = normalizeInteractiveButtons(req.body || {});
    const content = String(text || message || body || "").trim();
    if (!targetJid) return publicError(res, 400, "VALIDATION_ERROR", "Destinatário inválido");
    if (!content) return publicError(res, 400, "VALIDATION_ERROR", "Mensagem obrigatória");
    if (!buttons.length) return publicError(res, 400, "VALIDATION_ERROR", "Botões obrigatórios");
    try {
      const result = await sendWhatsAppButtons(Number(inst.id), Number(inst.account_id), targetJid, { title, text: content, footer, buttons });
      const providerMessageId = result?.ID || result?.id || result?.messageID || `buttons_${Date.now()}`;
      await logMessage(Number(inst.account_id), Number(inst.id), providerMessageId, "outbound", "sent", { contentType: "buttons", fallbackUsed: result.fallbackUsed || false });
      await dispatchWebhook(Number(inst.id), "message.sent", { message: { message_id: providerMessageId, content_type: "buttons", text: content }, buttons, fallbackUsed: result.fallbackUsed || false }).catch(() => null);
      return publicSuccess(res, { providerMessageId, fallbackUsed: result.fallbackUsed || false }, result.fallbackUsed ? "Botões enviados como texto de fallback" : "Botões enviados com sucesso");
    } catch (error) {
      return publicError(res, 500, "SEND_BUTTONS_FAILED", sanitizePublicError(error));
    }
  });

  app.post("/api/v1/instances/:id/send-menu", criticalEndpointRateLimit, perInstanceRateLimit, async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    const { jid, number, phone, text, message, body, title, footer, buttonText } = req.body || {};
    const targetJid = resolveTargetJid(jid || number || phone);
    const sections = normalizeInteractiveSections(req.body || {});
    const content = String(text || message || body || "").trim();
    if (!targetJid) return publicError(res, 400, "VALIDATION_ERROR", "Destinatário inválido");
    if (!content) return publicError(res, 400, "VALIDATION_ERROR", "Mensagem obrigatória");
    if (!sections.length) return publicError(res, 400, "VALIDATION_ERROR", "Seções ou linhas obrigatórias");
    try {
      const result = await sendWhatsAppList(Number(inst.id), Number(inst.account_id), targetJid, { title, text: content, footer, buttonText, sections });
      const providerMessageId = result?.ID || result?.id || result?.messageID || `menu_${Date.now()}`;
      await logMessage(Number(inst.account_id), Number(inst.id), providerMessageId, "outbound", "sent", { contentType: "menu", fallbackUsed: result.fallbackUsed || false });
      await dispatchWebhook(Number(inst.id), "message.sent", { message: { message_id: providerMessageId, content_type: "menu", text: content }, sections, fallbackUsed: result.fallbackUsed || false }).catch(() => null);
      return publicSuccess(res, { providerMessageId, fallbackUsed: result.fallbackUsed || false }, result.fallbackUsed ? "Menu enviado como texto de fallback" : "Menu enviado com sucesso");
    } catch (error) {
      return publicError(res, 500, "SEND_MENU_FAILED", sanitizePublicError(error));
    }
  });

  const v1BridgePost = (path: string, endpoint: string, transform?: (body: any) => any) => {
    app.post(path, criticalEndpointRateLimit, perInstanceRateLimit, async (req, res) => {
      const inst = await requireInstanceApiKey(req, res);
      if (!inst) return;
      try {
        const body = transform ? transform(req.body || {}) : { ...(req.body || {}) };
        const result = await callAdvancedBridge(inst, endpoint, body);
        await persistAdvancedBridgeOperation(inst, endpoint, body, result);
        return publicSuccess(res, result?.result ?? result);
      } catch (error) {
        return publicError(res, 502, "BRIDGE_OPERATION_FAILED", sanitizePublicError(error));
      }
    });
  };

  v1BridgePost("/api/v1/instances/:id/send-location", "/send-location");
  v1BridgePost("/api/v1/instances/:id/send-contact", "/send-contact");
  v1BridgePost("/api/v1/instances/:id/send-reply", "/send-reply");
  v1BridgePost("/api/v1/instances/:id/messages/react", "/messages/react");
  v1BridgePost("/api/v1/instances/:id/messages/read", "/messages/read");
  v1BridgePost("/api/v1/instances/:id/messages/edit", "/messages/edit");
  v1BridgePost("/api/v1/instances/:id/messages/delete", "/messages/delete");
  v1BridgePost("/api/v1/instances/:id/presence", "/presence");
  v1BridgePost("/api/v1/instances/:id/contacts/check", "/contacts/check");
  v1BridgePost("/api/v1/instances/:id/contacts/info", "/contacts/info");
  v1BridgePost("/api/v1/instances/:id/contacts/block", "/contacts/block");
  v1BridgePost("/api/v1/instances/:id/chats/state", "/chats/state");
  v1BridgePost("/api/v1/instances/:id/profile/name", "/profile/name");
  v1BridgePost("/api/v1/instances/:id/profile/status", "/profile/status");
  v1BridgePost("/api/v1/instances/:id/profile/photo", "/profile/photo");
  v1BridgePost("/api/v1/instances/:id/groups", "/groups");
  v1BridgePost("/api/v1/instances/:id/groups/info", "/groups/info");
  v1BridgePost("/api/v1/instances/:id/groups/participants", "/groups/participants");
  v1BridgePost("/api/v1/instances/:id/groups/name", "/groups/name");
  v1BridgePost("/api/v1/instances/:id/groups/topic", "/groups/topic");
  v1BridgePost("/api/v1/instances/:id/groups/photo", "/groups/photo");
  v1BridgePost("/api/v1/instances/:id/groups/invite", "/groups/invite");
  v1BridgePost("/api/v1/instances/:id/groups/join", "/groups/join");
  v1BridgePost("/api/v1/instances/:id/groups/leave", "/groups/leave");
  v1BridgePost("/api/v1/instances/:id/groups/settings", "/groups/settings");

  app.get("/api/v1/instances/:id/profile", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    try {
      const result = await bridgeFetch(`/instances/${inst.id}/profile?account_id=${inst.account_id}`);
      return publicSuccess(res, result?.result ?? result);
    } catch (error) {
      return publicError(res, 502, "PROFILE_FETCH_FAILED", sanitizePublicError(error));
    }
  });

  app.get("/api/v1/instances/:id/contacts", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    try {
      const result = await bridgeFetch(`/instances/${inst.id}/contacts?account_id=${inst.account_id}`);
      return publicSuccess(res, result?.result ?? result);
    } catch (error) {
      return publicError(res, 502, "CONTACT_SYNC_FAILED", sanitizePublicError(error));
    }
  });

  app.get("/api/v1/instances/:id/groups", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    try {
      const result = await bridgeFetch(`/instances/${inst.id}/groups?account_id=${inst.account_id}`);
      return publicSuccess(res, result?.result ?? result);
    } catch (error) {
      return publicError(res, 502, "GROUP_LIST_FAILED", sanitizePublicError(error));
    }
  });

  app.post("/api/v1/instances/:id/messages/download", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    try {
      const file = await bridgeBinaryFetch(`/instances/${inst.id}/messages/download`, {
        method: "POST",
        body: JSON.stringify({ account_id: Number(inst.account_id), ...(req.body || {}) })
      });
      res.setHeader("Content-Type", file.contentType);
      res.setHeader("Content-Disposition", file.disposition);
      return res.send(file.bytes);
    } catch (error) {
      return publicError(res, 502, "MEDIA_DOWNLOAD_FAILED", sanitizePublicError(error));
    }
  });

  app.patch("/api/v1/instances/:id", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    const name = req.body?.name === undefined ? inst.name : String(req.body.name || "").trim();
    const websocketEnabled = req.body?.websocket_enabled === undefined ? Number(inst.websocket_enabled ?? 1) : (req.body.websocket_enabled ? 1 : 0);
    const webhookEnabled = req.body?.webhook_enabled === undefined ? Number(inst.webhook_enabled ?? 1) : (req.body.webhook_enabled ? 1 : 0);
    await run(
      "UPDATE instances SET name = ?, websocket_enabled = ?, webhook_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [name || inst.name, websocketEnabled, webhookEnabled, inst.id]
    );
    return publicSuccess(res, serializeInstance(await get("SELECT * FROM instances WHERE id = ?", [inst.id])));
  });

  app.delete("/api/v1/instances/:id", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    await bridgeFetch(`/instances/${inst.id}/logout`, { method: "POST" }).catch(() => null);
    await run("UPDATE instances SET status = ?, connection_status = ?, qr = NULL, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", ["disconnected", "disconnected", inst.id]);
    return publicSuccess(res, { id: inst.id }, "Instância removida com sucesso");
  });

  app.post("/api/v1/instances/:id/api-key/regenerate", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    const apiKey = randomToken("woo");
    await run("UPDATE instances SET api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [apiKey, inst.id]);
    await audit(Number(inst.account_id), null, "instance.api_key.regenerated", { instanceId: inst.id });
    return publicSuccess(res, { id: inst.id, api_key: apiKey }, "API key regenerada com sucesso");
  });

  app.get("/api/v1/instances/:id/logs", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    const type = String(req.query.type || "all");
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 200);
    const data: any = {};
    if (type === "all" || type === "messages") {
      data.messages = await query("SELECT id, message_id, direction, status, details_json, created_at FROM message_logs WHERE instance_id = ? ORDER BY id DESC LIMIT ?", [inst.id, limit]);
    }
    if (type === "all" || type === "connections") {
      data.connections = await query("SELECT id, event, status, details_json, created_at FROM connection_logs WHERE instance_id = ? ORDER BY id DESC LIMIT ?", [inst.id, limit]);
    }
    if (type === "all" || type === "webhooks") {
      data.webhooks = await query("SELECT id, event, status, response_status, error, attempts, delivered_at, created_at FROM webhook_events WHERE instance_id = ? ORDER BY id DESC LIMIT ?", [inst.id, limit]);
    }
    if (type === "all" || type === "api") {
      data.api = await query("SELECT id, method, path, status_code, duration_ms, created_at FROM api_request_logs WHERE instance_id = ? ORDER BY id DESC LIMIT ?", [inst.id, limit]);
    }
    return publicSuccess(res, data);
  });

  app.get("/api/v1/instances/:id/integrations", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    return publicSuccess(res, await query("SELECT provider, enabled, config_json, updated_at FROM integration_settings WHERE instance_id = ? ORDER BY provider ASC", [inst.id]));
  });

  app.put("/api/v1/instances/:id/integrations/:provider", async (req, res) => {
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    const provider = String(req.params.provider || "").toLowerCase();
    if (!["n8n", "typebot", "chatwoot"].includes(provider)) return publicError(res, 400, "INVALID_PROVIDER", "Provider inválido");
    const flags = await getAccountFeatureFlags(Number(inst.account_id));
    if ((provider === "n8n" && !flags.n8n) || (provider === "typebot" && !flags.typebot) || (provider === "chatwoot" && !flags.chatwoot)) {
      return publicError(res, 403, "PLAN_FEATURE_DISABLED", "Integração não habilitada para esta conta");
    }
    const enabled = req.body?.enabled ? 1 : 0;
    const config = req.body?.config || {};
    await run(
      "INSERT INTO integration_settings (account_id, instance_id, provider, enabled, config_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(instance_id, provider) DO UPDATE SET enabled = excluded.enabled, config_json = excluded.config_json, updated_at = CURRENT_TIMESTAMP",
      [inst.account_id, inst.id, provider, enabled, JSON.stringify(config)]
    );
    return publicSuccess(res, { provider, enabled: Boolean(enabled) });
  });

  app.post("/api/v1/integrations/chatwoot/:id/webhook", async (req, res) => {
    req.params.id = req.params.id;
    const inst = await requireInstanceApiKey(req, res);
    if (!inst) return;
    const body = req.body || {};
    const event = body.event || body.event_name;
    const messageType = body.message_type || body.message?.message_type;
    const content = body.content || body.message?.content;
    const phone = body.conversation?.meta?.sender?.phone_number || body.sender?.phone_number || body.contact?.phone_number;
    if (event && !String(event).includes("message")) return publicSuccess(res, { ignored: true }, "Evento ignorado");
    if (messageType && messageType !== "outgoing") return publicSuccess(res, { ignored: true }, "Evento ignorado");
    if (!content || !phone) return publicError(res, 400, "VALIDATION_ERROR", "Chatwoot precisa enviar content e phone_number");
    const jid = `${normalizePhone(phone)}@s.whatsapp.net`;
    try {
      const result = await sendWhatsAppMessage(Number(inst.id), Number(inst.account_id), jid, String(content));
      const messageId = result?.ID || result?.id || result?.messageID || `chatwoot_${Date.now()}`;
      const { message, conversation } = await persistOutboundMessage({
        accountId: Number(inst.account_id),
        instanceId: Number(inst.id),
        jid,
        messageId,
        contentType: "text",
        contentText: String(content),
        sender: "api",
        raw: { provider: "chatwoot", phone: normalizePhone(phone) }
      });
      await logMessage(Number(inst.account_id), Number(inst.id), messageId, "outbound", "sent", { provider: "chatwoot", phone: normalizePhone(phone) });
      return publicSuccess(res, { result, message, conversation }, "Mensagem encaminhada com sucesso");
    } catch (error) {
      await logMessage(Number(inst.account_id), Number(inst.id), null, "outbound", "failed", { provider: "chatwoot", error: sanitizePublicError(error) });
      return publicError(res, 502, "CHATWOOT_SEND_FAILED", sanitizePublicError(error));
    }
  });

  app.get("/api/billing/plans", async (_req, res) => {
    res.json(await query("SELECT id, name, description, price, billing_cycle, instance_quota, max_client_accounts, features_json, support_level FROM plans WHERE is_active = 1 ORDER BY price ASC"));
  });

  app.post("/api/billing/checkout", requireAccount, async (req: AccountRequest, res) => {
    const { priceId, planName } = req.body || {};
    if (!priceId || !planName) return res.status(400).json({ error: "priceId e planName obrigatórios" });
    const url = await createCheckoutSession(Number(req.accountId), req.user?.email || "", priceId, planName);
    if (!url) return res.status(503).json({ error: "Stripe não configurado" });
    res.json({ url });
  });

  app.get("/api/billing/portal", requireAccount, async (req: AccountRequest, res) => {
    const url = await createBillingPortalSession(Number(req.accountId));
    if (!url) return res.status(503).json({ error: "Stripe não configurado" });
    res.json({ url });
  });

  app.get("/api/billing/status", requireAccount, async (req: AccountRequest, res) => {
    const account = await get("SELECT plan_id, status, billing_status, trial_ends_at FROM accounts WHERE id = ?", [req.accountId]);
    const plan = account?.plan_id ? await get("SELECT name, price, billing_cycle FROM plans WHERE id = ?", [account.plan_id]) : null;
    res.json({ account, plan });
  });

  app.get("/api/groups", async (req: AccountRequest, res) => {
    const instanceId = Number(req.query.instance_id || 0);
    const rows = await query(
      "SELECT * FROM whatsapp_groups WHERE account_id = ? AND (? = 0 OR instance_id = ?) ORDER BY updated_at DESC, name ASC",
      [req.accountId, instanceId || 0, instanceId || 0]
    );
    res.json(rows);
  });

  app.post("/api/groups/sync", async (req: AccountRequest, res) => {
    const inst = await accountInstance(Number(req.accountId), req.body?.instance_id || req.query.instance_id);
    if (!inst) return res.status(404).json({ error: "Instancia nao encontrada" });
    try {
      const groups = await syncWhatsappGroups(inst);
      res.json({ success: true, groups });
    } catch (error) {
      res.status(502).json({ error: sanitizePublicError(error) });
    }
  });

  app.post("/api/groups", async (req: AccountRequest, res) => {
    const inst = await accountInstance(Number(req.accountId), req.body?.instance_id);
    if (!inst) return res.status(404).json({ error: "Instancia nao encontrada" });
    try {
      const result = await callAdvancedBridge(inst, "/groups", { name: req.body?.name, participants: req.body?.participants || [] });
      await syncWhatsappGroups(inst).catch(() => []);
      res.json({ success: true, result: bridgeResult(result) });
    } catch (error) {
      res.status(502).json({ error: sanitizePublicError(error) });
    }
  });

  app.get("/api/groups/moderation/rules", async (req: AccountRequest, res) => {
    const instanceId = Number(req.query.instance_id || 0);
    const groupJid = String(req.query.group_jid || "");
    res.json(await query(
      "SELECT * FROM group_moderation_rules WHERE account_id = ? AND (? = 0 OR instance_id = ?) AND (? = '' OR group_jid = ? OR group_jid IS NULL OR group_jid = '') ORDER BY enabled DESC, id DESC",
      [req.accountId, instanceId, instanceId, groupJid, groupJid]
    ));
  });

  app.post("/api/groups/moderation/rules", async (req: AccountRequest, res) => {
    const inst = await accountInstance(Number(req.accountId), req.body?.instance_id);
    if (!inst) return res.status(404).json({ error: "Instancia nao encontrada" });
    const name = String(req.body?.name || req.body?.pattern || "Regra").trim();
    const pattern = String(req.body?.pattern || "").trim();
    if (!pattern) return res.status(400).json({ error: "Padrao da regra obrigatorio" });
    const info = await run(
      `INSERT INTO group_moderation_rules
        (account_id, instance_id, group_jid, name, rule_type, pattern, action, warning_text, threshold, window_minutes, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.accountId,
        inst.id,
        req.body?.group_jid || "",
        name,
        req.body?.rule_type || "keyword",
        pattern,
        req.body?.action || "warn",
        req.body?.warning_text || "",
        Math.max(1, Number(req.body?.threshold || 1)),
        Math.max(1, Number(req.body?.window_minutes || 60)),
        req.body?.enabled === false ? 0 : 1
      ]
    );
    res.json(await get("SELECT * FROM group_moderation_rules WHERE id = ?", [info.lastInsertRowid]));
  });

  app.patch("/api/groups/moderation/rules/:id", async (req: AccountRequest, res) => {
    const existing = await get("SELECT * FROM group_moderation_rules WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    if (!existing) return res.status(404).json({ error: "Regra nao encontrada" });
    await run(
      `UPDATE group_moderation_rules SET
        name = ?, rule_type = ?, pattern = ?, action = ?, warning_text = ?,
        threshold = ?, window_minutes = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
       WHERE account_id = ? AND id = ?`,
      [
        req.body?.name ?? existing.name,
        req.body?.rule_type ?? existing.rule_type,
        req.body?.pattern ?? existing.pattern,
        req.body?.action ?? existing.action,
        req.body?.warning_text ?? existing.warning_text,
        Math.max(1, Number(req.body?.threshold ?? existing.threshold ?? 1)),
        Math.max(1, Number(req.body?.window_minutes ?? existing.window_minutes ?? 60)),
        req.body?.enabled === undefined ? existing.enabled : (req.body.enabled ? 1 : 0),
        req.accountId,
        req.params.id
      ]
    );
    res.json(await get("SELECT * FROM group_moderation_rules WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]));
  });

  app.delete("/api/groups/moderation/rules/:id", async (req: AccountRequest, res) => {
    await run("DELETE FROM group_moderation_rules WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    res.json({ success: true });
  });

  app.get("/api/groups/moderation/events", async (req: AccountRequest, res) => {
    const instanceId = Number(req.query.instance_id || 0);
    const groupJid = String(req.query.group_jid || "");
    res.json(await query(
      "SELECT group_moderation_events.*, group_moderation_rules.name AS rule_name FROM group_moderation_events LEFT JOIN group_moderation_rules ON group_moderation_rules.id = group_moderation_events.rule_id WHERE group_moderation_events.account_id = ? AND (? = 0 OR group_moderation_events.instance_id = ?) AND (? = '' OR group_moderation_events.group_jid = ?) ORDER BY group_moderation_events.id DESC LIMIT 100",
      [req.accountId, instanceId, instanceId, groupJid, groupJid]
    ));
  });

  app.get("/api/groups/:jid", async (req: AccountRequest, res) => {
    const groupJid = decodeURIComponent(req.params.jid);
    const group = await get("SELECT * FROM whatsapp_groups WHERE account_id = ? AND group_jid = ?", [req.accountId, groupJid]);
    if (!group) return res.status(404).json({ error: "Grupo nao encontrado" });
    const participants = await query("SELECT * FROM whatsapp_group_participants WHERE account_id = ? AND instance_id = ? AND group_jid = ? ORDER BY is_admin DESC, name ASC, phone ASC", [req.accountId, group.instance_id, groupJid]);
    res.json({ ...group, participants });
  });

  app.post("/api/groups/:jid/action", async (req: AccountRequest, res) => {
    const groupJid = decodeURIComponent(req.params.jid);
    const group = await get("SELECT * FROM whatsapp_groups WHERE account_id = ? AND group_jid = ?", [req.accountId, groupJid]);
    if (!group) return res.status(404).json({ error: "Grupo nao encontrado" });
    const inst = await accountInstance(Number(req.accountId), group.instance_id);
    if (!inst) return res.status(404).json({ error: "Instancia nao encontrada" });
    const action = String(req.body?.action || "");
    const map: Record<string, { endpoint: string; body: any }> = {
      name: { endpoint: "/groups/name", body: { jid: groupJid, name: req.body?.name } },
      topic: { endpoint: "/groups/topic", body: { jid: groupJid, topic: req.body?.topic } },
      photo: { endpoint: "/groups/photo", body: { jid: groupJid, media: publicMediaUrl(req.body?.media || req.body?.url) } },
      invite: { endpoint: "/groups/invite", body: { jid: groupJid, action: req.body?.reset ? "reset" : "" } },
      settings: { endpoint: "/groups/settings", body: { jid: groupJid, locked: req.body?.locked, announce: req.body?.announce } },
      participants: { endpoint: "/groups/participants", body: { jid: groupJid, participants: req.body?.participants || [], action: req.body?.participant_action || "add" } },
      leave: { endpoint: "/groups/leave", body: { jid: groupJid } }
    };
    if (!map[action]) return res.status(400).json({ error: "Acao invalida" });
    try {
      const result = await callAdvancedBridge(inst, map[action].endpoint, map[action].body);
      if (action === "invite") {
        const invite = String(bridgeResult(result) || "");
        await run("UPDATE whatsapp_groups SET invite_link = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [invite, group.id]);
      } else {
        await syncWhatsappGroups(inst).catch(() => []);
      }
      res.json({ success: true, result: bridgeResult(result) });
    } catch (error) {
      res.status(502).json({ error: sanitizePublicError(error) });
    }
  });

  app.post("/api/groups/join", async (req: AccountRequest, res) => {
    const inst = await accountInstance(Number(req.accountId), req.body?.instance_id);
    if (!inst) return res.status(404).json({ error: "Instancia nao encontrada" });
    try {
      const result = await callAdvancedBridge(inst, "/groups/join", { code: req.body?.code || req.body?.invite_link || "" });
      await syncWhatsappGroups(inst).catch(() => []);
      res.json({ success: true, result: bridgeResult(result) });
    } catch (error) {
      res.status(502).json({ error: sanitizePublicError(error) });
    }
  });

  app.get("/api/conversations", async (req: AccountRequest, res) => {
    const conversations = await query(`
      SELECT *, last_message_preview AS last_message
      FROM conversations
      WHERE account_id = ?
        AND COALESCE(remote_jid, '') NOT LIKE '%@newsletter'
        AND COALESCE(remote_jid, '') NOT LIKE '%@broadcast'
        AND COALESCE(group_jid, '') NOT LIKE '%@newsletter'
        AND COALESCE(group_jid, '') NOT LIKE '%@broadcast'
        AND COALESCE(contact_phone, '') != 'status'
      ORDER BY last_message_at DESC
    `, [req.accountId]);
    const enriched = await Promise.all(
      conversations.map((conversation: any) =>
        String(conversation.group_jid || "").endsWith("@g.us")
          ? refreshGroupConversationProfile(Number(req.accountId), conversation)
          : conversation
      )
    );
    res.json(enriched);
  });

  app.get("/api/conversations/:id/messages", async (req: AccountRequest, res) => {
    const conversation = await get("SELECT remote_jid, group_jid, contact_phone FROM conversations WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    if (!conversation || isIgnoredChatJid(conversation.remote_jid) || isIgnoredChatJid(conversation.group_jid) || String(conversation.contact_phone || "") === "status") {
      return res.json([]);
    }
    res.json(await query("SELECT * FROM messages WHERE account_id = ? AND conversation_id = ? ORDER BY created_at ASC, id ASC", [req.accountId, req.params.id]));
  });

  app.patch("/api/conversations/:id", async (req: AccountRequest, res) => {
    const { tags, status, assigned_to } = req.body || {};
    await run(
      "UPDATE conversations SET tags_json = COALESCE(?, tags_json), status = COALESCE(?, status), assigned_to = COALESCE(?, assigned_to), updated_at = CURRENT_TIMESTAMP WHERE account_id = ? AND id = ?",
      [Array.isArray(tags) ? JSON.stringify(tags) : null, status || null, assigned_to || null, req.accountId, req.params.id]
    );
    res.json(await get("SELECT *, last_message_preview AS last_message FROM conversations WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]));
  });

  app.delete("/api/conversations/:id", async (req: AccountRequest, res) => {
    await run("DELETE FROM messages WHERE account_id = ? AND conversation_id = ?", [req.accountId, req.params.id]);
    await run("DELETE FROM conversations WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    res.json({ success: true });
  });

  app.get("/api/messages", async (req: AccountRequest, res) => {
    res.json(await query("SELECT * FROM messages WHERE account_id = ? ORDER BY created_at DESC LIMIT 100", [req.accountId]));
  });

  app.post("/api/messages/save", async (req: AccountRequest, res) => {
    const { lead_id, sender, content } = req.body || {};
    const info = await run("INSERT INTO messages (account_id, direction, sender, content_text, lead_id) VALUES (?, ?, ?, ?, ?)", [
      req.accountId, sender === "lead" ? "inbound" : "outbound", sender, content, lead_id
    ]);
    res.json({ id: info.lastInsertRowid });
  });

  app.delete("/api/messages/:id", async (req: AccountRequest, res) => {
    await run("DELETE FROM messages WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    res.json({ success: true });
  });

  app.get("/api/leads", async (req: AccountRequest, res) => res.json(await query("SELECT * FROM leads WHERE account_id = ? ORDER BY id DESC", [req.accountId])));
  app.post("/api/leads", async (req: AccountRequest, res) => {
    const leads = Array.isArray(req.body?.leads) ? req.body.leads : [req.body];
    const usage = getAccountUsage(Number(req.accountId));
    const limit = await ensureLimit(Number(req.accountId), "max_leads", (await usage).leads + leads.length - 1);
    if (!limit.allowed) return res.status(403).json({ error: limit.error });
    for (const lead of leads) {
      await run("INSERT INTO leads (account_id, name, phone, address, niche, status, kanban_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [req.accountId, lead.name, lead.phone, lead.address, lead.niche, lead.status || "pending", lead.kanban_status || "new"]);
    }
    res.json({ success: true });
  });
  app.patch("/api/leads/:id/kanban", async (req: AccountRequest, res) => {
    await run("UPDATE leads SET kanban_status = ? WHERE id = ? AND account_id = ?", [req.body.kanban_status, req.params.id, req.accountId]);
    res.json({ success: true });
  });
  app.get("/api/leads/:id/details", async (req: AccountRequest, res) => {
    const lead = await get("SELECT * FROM leads WHERE id = ? AND account_id = ?", [req.params.id, req.accountId]);
    if (!lead) return res.status(404).json({ error: "Lead nao encontrado" });
    const notes = await query("SELECT * FROM lead_notes WHERE lead_id = ? AND account_id = ? ORDER BY id DESC", [lead.id, req.accountId]);
    const tags = await query("SELECT tag FROM lead_tags WHERE lead_id = ? AND account_id = ? ORDER BY tag ASC", [lead.id, req.accountId]);
    const custom_fields = await query("SELECT field_key, field_value FROM lead_custom_fields WHERE lead_id = ? AND account_id = ? ORDER BY field_key ASC", [lead.id, req.accountId]);
    res.json({ ...lead, notes, tags: tags.map((row: any) => row.tag), custom_fields });
  });
  app.post("/api/leads/:id/notes", async (req: AccountRequest, res) => {
    const lead = await get("SELECT id FROM leads WHERE id = ? AND account_id = ?", [req.params.id, req.accountId]);
    if (!lead) return res.status(404).json({ error: "Lead nao encontrado" });
    const info = await run("INSERT INTO lead_notes (account_id, lead_id, user_id, note) VALUES (?, ?, ?, ?)", [req.accountId, lead.id, req.user?.userId || null, req.body?.note]);
    res.json({ id: info.lastInsertRowid });
  });
  app.post("/api/leads/:id/tags", async (req: AccountRequest, res) => {
    const tags = Array.isArray(req.body?.tags) ? req.body.tags : [req.body?.tag];
    for (const value of tags) {
      const tag = String(value || "").trim();
      if (tag) await run("INSERT INTO lead_tags (account_id, lead_id, tag) VALUES (?, ?, ?) ON CONFLICT(account_id, lead_id, tag) DO NOTHING", [req.accountId, req.params.id, tag]);
    }
    const rows = await query("SELECT tag FROM lead_tags WHERE account_id = ? AND lead_id = ? ORDER BY tag ASC", [req.accountId, req.params.id]);
    await run("UPDATE leads SET tags_json = ? WHERE account_id = ? AND id = ?", [JSON.stringify(rows.map((row: any) => row.tag)), req.accountId, req.params.id]);
    res.json({ tags: rows.map((row: any) => row.tag) });
  });
  app.delete("/api/leads/:id/tags/:tag", async (req: AccountRequest, res) => {
    await run("DELETE FROM lead_tags WHERE account_id = ? AND lead_id = ? AND tag = ?", [req.accountId, req.params.id, req.params.tag]);
    res.json({ success: true });
  });
  app.put("/api/leads/:id/custom-fields", async (req: AccountRequest, res) => {
    const fields = req.body?.fields || req.body || {};
    for (const [key, value] of Object.entries(fields)) {
      await run(
        "INSERT INTO lead_custom_fields (account_id, lead_id, field_key, field_value) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, lead_id, field_key) DO UPDATE SET field_value = excluded.field_value, updated_at = CURRENT_TIMESTAMP",
        [req.accountId, req.params.id, key, value == null ? null : String(value)]
      );
    }
    await run("UPDATE leads SET custom_fields_json = ? WHERE account_id = ? AND id = ?", [JSON.stringify(fields), req.accountId, req.params.id]);
    res.json({ success: true, fields });
  });
  app.delete("/api/leads/:id", async (req: AccountRequest, res) => {
    await run("DELETE FROM lead_notes WHERE account_id = ? AND lead_id = ?", [req.accountId, req.params.id]);
    await run("DELETE FROM lead_tags WHERE account_id = ? AND lead_id = ?", [req.accountId, req.params.id]);
    await run("DELETE FROM lead_custom_fields WHERE account_id = ? AND lead_id = ?", [req.accountId, req.params.id]);
    await run("DELETE FROM leads WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    res.json({ success: true });
  });

  app.get("/api/quick-replies", async (req: AccountRequest, res) => {
    res.json(await query("SELECT * FROM quick_replies WHERE account_id = ? AND is_active = 1 ORDER BY shortcut ASC", [req.accountId]));
  });
  app.post("/api/quick-replies", async (req: AccountRequest, res) => {
    const shortcut = String(req.body?.shortcut || "").trim();
    const content = String(req.body?.content || "").trim();
    if (!shortcut || !content) return res.status(400).json({ error: "Atalho e conteudo obrigatorios" });
    await run(
      "INSERT INTO quick_replies (account_id, shortcut, title, content, media_url, is_active) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(account_id, shortcut) DO UPDATE SET title = excluded.title, content = excluded.content, media_url = excluded.media_url, is_active = 1, updated_at = CURRENT_TIMESTAMP",
      [req.accountId, shortcut, req.body?.title || shortcut, content, req.body?.media_url || null]
    );
    res.json({ success: true });
  });
  app.delete("/api/quick-replies/:id", async (req: AccountRequest, res) => {
    await run("UPDATE quick_replies SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ?", [req.params.id, req.accountId]);
    res.json({ success: true });
  });

  app.get("/api/agents", async (req: AccountRequest, res) => res.json(await query("SELECT * FROM agents WHERE account_id = ? ORDER BY id DESC", [req.accountId])));
  app.post("/api/agents", async (req: AccountRequest, res) => {
    const { name, system_instruction, personality, faq_json, handoff_trigger } = req.body || {};
    const usage = getAccountUsage(Number(req.accountId));
    const limit = await ensureLimit(Number(req.accountId), "max_agents", (await usage).agents);
    if (!limit.allowed) return res.status(403).json({ error: limit.error });
    const info = await run("INSERT INTO agents (account_id, name, system_instruction, personality, faq_json, handoff_trigger) VALUES (?, ?, ?, ?, ?, ?)", [
      req.accountId, name, system_instruction, personality, JSON.stringify(faq_json || []), handoff_trigger
    ]);
    res.json({ id: info.lastInsertRowid });
  });
  app.delete("/api/agents/:id", async (req: AccountRequest, res) => {
    await run("DELETE FROM agents WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    res.json({ success: true });
  });

  app.get("/api/campaigns", async (req: AccountRequest, res) => {
    const rows = await query("SELECT * FROM campaigns WHERE account_id = ? ORDER BY id DESC", [req.accountId]);
    res.json(rows.map((r) => ({ ...r, transition_rules: JSON.parse(r.transition_rules || "{}") })));
  });
  app.post("/api/campaigns", async (req: AccountRequest, res) => {
    const {
      name, agent_id, instance_id, initial_method, transition_rules, message_template,
      media_url, min_delay_ms, max_delay_ms, scheduled_at, limit_per_instance
    } = req.body || {};
    const usage = getAccountUsage(Number(req.accountId));
    const limit = await ensureLimit(Number(req.accountId), "max_campaigns", (await usage).campaigns);
    if (!limit.allowed) return res.status(403).json({ error: limit.error });
    if (!name) return res.status(400).json({ error: "name obrigatorio" });
    if (instance_id) {
      const inst = await get("SELECT id FROM instances WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [instance_id, req.accountId]);
      if (!inst) return res.status(404).json({ error: "Instancia nao encontrada" });
    }
    const minDelay = Math.max(0, Number(min_delay_ms || 1000));
    const maxDelay = Math.max(minDelay, Number(max_delay_ms || 3000));
    const info = await run("INSERT INTO campaigns (account_id, instance_id, name, agent_id, initial_method, transition_rules, status, message_template, media_url, min_delay_ms, max_delay_ms, scheduled_at, limit_per_instance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      req.accountId, instance_id || null, name, agent_id || null, initial_method || "direct", JSON.stringify(transition_rules || {}),
      "draft", message_template || null, media_url || null, minDelay, maxDelay, scheduled_at || null, Math.max(1, Number(limit_per_instance || 1))
    ]);
    res.json({ id: info.lastInsertRowid });
  });
  app.get("/api/campaigns/:id", async (req: AccountRequest, res) => {
    const campaign = await get("SELECT * FROM campaigns WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    if (!campaign) return res.status(404).json({ error: "Campanha nao encontrada" });
    const recipients = await query("SELECT * FROM campaign_recipients WHERE account_id = ? AND campaign_id = ? ORDER BY id ASC", [req.accountId, req.params.id]);
    res.json({ ...campaign, transition_rules: JSON.parse(campaign.transition_rules || "{}"), recipients });
  });
  app.patch("/api/campaigns/:id", async (req: AccountRequest, res) => {
    const campaign = await get("SELECT * FROM campaigns WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    if (!campaign) return res.status(404).json({ error: "Campanha nao encontrada" });
    if (!["draft", "paused"].includes(String(campaign.status))) return res.status(409).json({ error: "Campanha em execucao nao pode ser alterada" });
    const next = { ...campaign, ...(req.body || {}) };
    if (next.instance_id) {
      const inst = await get("SELECT id FROM instances WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [next.instance_id, req.accountId]);
      if (!inst) return res.status(404).json({ error: "Instancia nao encontrada" });
    }
    const minDelay = Math.max(0, Number(next.min_delay_ms || 0));
    const maxDelay = Math.max(minDelay, Number(next.max_delay_ms || minDelay));
    await run(
      "UPDATE campaigns SET instance_id = ?, name = ?, message_template = ?, media_url = ?, min_delay_ms = ?, max_delay_ms = ?, scheduled_at = ?, limit_per_instance = ?, transition_rules = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ?",
      [next.instance_id || null, next.name, next.message_template || null, next.media_url || null, minDelay, maxDelay, next.scheduled_at || null, Math.max(1, Number(next.limit_per_instance || 1)), JSON.stringify(req.body?.transition_rules ?? parseJsonObject(campaign.transition_rules)), campaign.id, req.accountId]
    );
    res.json(await get("SELECT * FROM campaigns WHERE id = ?", [campaign.id]));
  });
  app.post("/api/campaigns/:id/recipients", async (req: AccountRequest, res) => {
    const campaign = await get("SELECT * FROM campaigns WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    if (!campaign) return res.status(404).json({ error: "Campanha nao encontrada" });
    if (!["draft", "paused"].includes(String(campaign.status))) return res.status(409).json({ error: "Destinatarios so podem ser alterados em campanha draft ou pausada" });
    const supplied = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
    const leadIds = Array.isArray(req.body?.lead_ids) ? req.body.lead_ids.map(Number).filter(Boolean) : [];
    const leads = leadIds.length
      ? await query(`SELECT id, name, phone, address, niche, custom_fields_json FROM leads WHERE account_id = ? AND id IN (${leadIds.map(() => "?").join(",")})`, [req.accountId, ...leadIds])
      : [];
    const recipients = [
      ...supplied,
      ...leads.map((lead: any) => ({
        phone: lead.phone,
        variables: { name: lead.name || "", address: lead.address || "", niche: lead.niche || "", ...(JSON.parse(lead.custom_fields_json || "{}")) }
      }))
    ];
    let inserted = 0;
    for (const item of recipients) {
      const phone = normalizePhone(item.phone || item.number || item.jid || "");
      if (!phone) continue;
      const jid = resolveTargetJid(item.jid || phone);
      await run(
        "INSERT INTO campaign_recipients (account_id, campaign_id, instance_id, phone, jid, variables_json, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [req.accountId, campaign.id, campaign.instance_id, phone, jid, JSON.stringify(item.variables || item.custom_fields || {}), "pending"]
      );
      inserted += 1;
    }
    await run("UPDATE campaigns SET total_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?", [campaign.id, campaign.id]);
    res.json({ success: true, inserted });
  });

  const renderCampaignTemplate = (template: string, variables: any) =>
    String(template || "").replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key) => String(variables?.[key] ?? ""));

  async function enqueueCampaign(campaign: any) {
    const recipients = await query(
      "SELECT * FROM campaign_recipients WHERE campaign_id = ? AND account_id = ? AND status IN ('pending','queued','failed') ORDER BY id ASC",
      [campaign.id, campaign.account_id]
    );
    let cumulativeDelay = Math.max(0, new Date(campaign.scheduled_at || Date.now()).getTime() - Date.now());
    let queued = 0;
    for (const recipient of recipients) {
      let variables: any = {};
      try { variables = JSON.parse(recipient.variables_json || "{}"); } catch {}
      const span = Math.max(0, Number(campaign.max_delay_ms || 0) - Number(campaign.min_delay_ms || 0));
      cumulativeDelay += Number(campaign.min_delay_ms || 0) + Math.floor(Math.random() * (span + 1));
      const scheduledAt = new Date(Date.now() + cumulativeDelay).toISOString();
      let jobId = `db-campaign-${campaign.id}-${recipient.id}`;
      if (QUEUE_DRIVER === "bullmq") {
        const pendingMessageId = `campaign_${campaign.id}_${recipient.id}`;
        const renderedText = renderCampaignTemplate(campaign.message_template, variables);
        const storedContentType = campaign.media_url ? inferMediaTypeFromUrl(campaign.media_url) : "text";
        const storedContent = campaign.media_url || renderedText;
        const conversation = await ensureConversation(Number(campaign.account_id), Number(campaign.instance_id), recipient.jid);
        const info = await run(
          "INSERT INTO messages (account_id, instance_id, conversation_id, direction, chat_type, content_type, content_text, message_id, delivery_status, from_me, sender, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            campaign.account_id,
            campaign.instance_id,
            conversation?.id,
            "outbound",
            conversation?.type || "contact",
            storedContentType,
            storedContent,
            pendingMessageId,
            "pending",
            1,
            "campaign",
            JSON.stringify({ source: "campaign", campaignId: campaign.id, campaignRecipientId: recipient.id, caption: campaign.media_url ? renderedText : "" })
          ]
        );
        await run(
          "UPDATE conversations SET last_message_preview = ?, last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [campaign.media_url ? mediaPreview(storedContentType, storedContent) : renderedText, conversation?.id]
        );
        const job = await messageSendQueue.add("campaign-message", {
          accountId: Number(campaign.account_id),
          instanceId: Number(campaign.instance_id),
          jid: recipient.jid,
          text: renderedText,
          mediaUrl: campaign.media_url || undefined,
          caption: campaign.media_url ? renderedText : undefined,
          type: campaign.media_url ? storedContentType : undefined,
          campaignId: Number(campaign.id),
          campaignRecipientId: Number(recipient.id),
          pendingMessageId,
          messageDbId: Number(info.lastInsertRowid)
        }, {
          jobId: `campaign-${campaign.id}-${recipient.id}-${Date.now()}`,
          delay: cumulativeDelay,
          attempts: 3,
          backoff: { type: "exponential", delay: 15000 },
          removeOnComplete: 1000,
          removeOnFail: false
        });
        jobId = String(job.id);
      }
      await run(
        "UPDATE campaign_recipients SET status = ?, job_id = ?, scheduled_at = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        ["queued", jobId, scheduledAt, recipient.id]
      );
      queued += 1;
    }
    await run(
      "UPDATE campaigns SET status = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), total_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      ["running", campaign.id, campaign.id]
    );
    return queued;
  }

  let databaseCampaignBusy = false;
  async function processDatabaseCampaignQueue() {
    if (QUEUE_DRIVER !== "database" || databaseCampaignBusy) return;
    databaseCampaignBusy = true;
    try {
      const row = await get(`
        SELECT campaign_recipients.*, campaigns.message_template, campaigns.media_url, campaigns.status AS campaign_status
        FROM campaign_recipients
        INNER JOIN campaigns ON campaigns.id = campaign_recipients.campaign_id
        WHERE campaign_recipients.status = 'queued'
          AND campaigns.status = 'running'
          AND (campaign_recipients.scheduled_at IS NULL OR campaign_recipients.scheduled_at <= CURRENT_TIMESTAMP)
        ORDER BY campaign_recipients.scheduled_at ASC, campaign_recipients.id ASC
        LIMIT 1
      `);
      if (!row) return;
      await run("UPDATE campaign_recipients SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'", [row.id]);
      let variables: any = {};
      try { variables = JSON.parse(row.variables_json || "{}"); } catch {}
      try {
        const result = row.media_url
          ? await sendWhatsAppMedia(Number(row.instance_id), Number(row.account_id), row.jid, {
              mediaUrl: row.media_url,
              caption: renderCampaignTemplate(row.message_template, variables)
            })
          : await sendWhatsAppMessage(Number(row.instance_id), Number(row.account_id), row.jid, renderCampaignTemplate(row.message_template, variables));
        const messageId = result?.ID || result?.id || result?.messageID || `campaign_${row.campaign_id}_${row.id}`;
        const storedContent = row.media_url || renderCampaignTemplate(row.message_template, variables);
        const storedType = row.media_url ? inferMediaTypeFromUrl(row.media_url) : "text";
        await persistOutboundMessage({
          accountId: Number(row.account_id),
          instanceId: Number(row.instance_id),
          jid: row.jid,
          messageId,
          contentType: storedType,
          contentText: storedContent,
          sender: "campaign",
          raw: {
            source: "campaign",
            campaignId: row.campaign_id,
            campaignRecipientId: row.id,
            caption: row.media_url ? renderCampaignTemplate(row.message_template, variables) : ""
          }
        }).catch(() => null);
        await run("UPDATE campaign_recipients SET status = 'sent', message_id = ?, error = NULL, sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [messageId, row.id]);
      } catch (error) {
        await run("UPDATE campaign_recipients SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [sanitizePublicError(error), row.id]);
      }
      await run(
        "UPDATE campaigns SET sent_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status IN ('sent','delivered','read')), delivered_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status IN ('delivered','read')), read_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status = 'read'), failed_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status = 'failed'), status = CASE WHEN NOT EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND status IN ('pending','queued','processing')) THEN 'completed' ELSE status END, completed_at = CASE WHEN NOT EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND status IN ('pending','queued','processing')) THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE completed_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [row.campaign_id, row.campaign_id, row.campaign_id, row.campaign_id, row.campaign_id, row.campaign_id, row.campaign_id]
      );
    } finally {
      databaseCampaignBusy = false;
    }
  }
  if (QUEUE_DRIVER === "database") {
    setInterval(() => processDatabaseCampaignQueue().catch((error) => console.error("[DATABASE_CAMPAIGN_WORKER]", sanitizePublicError(error))), 1000).unref();
  }

  app.post("/api/campaigns/:id/start", async (req: AccountRequest, res) => {
    const campaign = await get("SELECT * FROM campaigns WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    if (!campaign) return res.status(404).json({ error: "Campanha nao encontrada" });
    if (campaign.status === "cancelled") return res.status(409).json({ error: "Campanha cancelada" });
    if (!campaign.instance_id || !campaign.message_template) return res.status(400).json({ error: "Configure instance_id e message_template antes de iniciar" });
    const queued = await enqueueCampaign(campaign);
    res.json({ success: true, queued, status: "running" });
  });
  app.post("/api/campaigns/:id/pause", async (req: AccountRequest, res) => {
    const campaign = await get("SELECT * FROM campaigns WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    if (!campaign) return res.status(404).json({ error: "Campanha nao encontrada" });
    const recipients = await query("SELECT id, job_id FROM campaign_recipients WHERE campaign_id = ? AND status = 'queued'", [campaign.id]);
    for (const recipient of recipients) {
      if (QUEUE_DRIVER === "bullmq" && recipient.job_id) {
        const job = await messageSendQueue.getJob(String(recipient.job_id));
        if (job) await job.remove().catch(() => null);
      }
      await run("UPDATE campaign_recipients SET status = ?, job_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", ["pending", recipient.id]);
    }
    await run("UPDATE campaigns SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", ["paused", campaign.id]);
    res.json({ success: true, status: "paused" });
  });
  app.post("/api/campaigns/:id/cancel", async (req: AccountRequest, res) => {
    const campaign = await get("SELECT * FROM campaigns WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    if (!campaign) return res.status(404).json({ error: "Campanha nao encontrada" });
    const recipients = await query("SELECT id, job_id FROM campaign_recipients WHERE campaign_id = ? AND status IN ('pending','queued')", [campaign.id]);
    for (const recipient of recipients) {
      if (QUEUE_DRIVER === "bullmq" && recipient.job_id) {
        const job = await messageSendQueue.getJob(String(recipient.job_id));
        if (job) await job.remove().catch(() => null);
      }
    }
    await run("UPDATE campaign_recipients SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND status IN ('pending','queued')", ["cancelled", campaign.id]);
    await run("UPDATE campaigns SET status = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", ["cancelled", campaign.id]);
    res.json({ success: true, status: "cancelled" });
  });
  app.get("/api/campaigns/:id/report", async (req: AccountRequest, res) => {
    const campaign = await get("SELECT * FROM campaigns WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    if (!campaign) return res.status(404).json({ error: "Campanha nao encontrada" });
    const byStatus = await query("SELECT status, COUNT(*) AS total FROM campaign_recipients WHERE campaign_id = ? GROUP BY status", [campaign.id]);
    const recipients = await query("SELECT phone, jid, status, message_id, error, scheduled_at, sent_at, delivered_at, read_at FROM campaign_recipients WHERE campaign_id = ? ORDER BY id ASC", [campaign.id]);
    res.json({ campaign, byStatus, recipients });
  });
  app.delete("/api/campaigns/:id", async (req: AccountRequest, res) => {
    await run("DELETE FROM campaign_recipients WHERE account_id = ? AND campaign_id = ?", [req.accountId, req.params.id]);
    await run("DELETE FROM campaigns WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    res.json({ success: true });
  });

  app.get("/api/team", async (req: AccountRequest, res) => res.json(await query("SELECT * FROM team_members WHERE account_id = ? ORDER BY id DESC", [req.accountId])));
  app.post("/api/team", async (req: AccountRequest, res) => {
    const usage = getAccountUsage(Number(req.accountId));
    const limit = await ensureLimit(Number(req.accountId), "max_users", (await usage).users);
    if (!limit.allowed) return res.status(403).json({ error: limit.error });
    const info = await run("INSERT INTO team_members (account_id, name, role, email) VALUES (?, ?, ?, ?)", [req.accountId, req.body.name, req.body.role, req.body.email]);
    res.json({ id: info.lastInsertRowid });
  });
  app.delete("/api/team/:id", async (req: AccountRequest, res) => {
    await run("DELETE FROM team_members WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    res.json({ success: true });
  });

  app.get("/api/credentials", async (req: AccountRequest, res) => res.json(await query("SELECT id, account_id, provider, name, model_name, is_active, created_at FROM llm_credentials WHERE account_id = ? ORDER BY id DESC", [req.accountId])));
  app.post("/api/credentials", async (req: AccountRequest, res) => {
    const info = await run("INSERT INTO llm_credentials (account_id, provider, name, api_key, model_name, is_active) VALUES (?, ?, ?, ?, ?, 0)", [
      req.accountId, req.body.provider, req.body.name, req.body.api_key, req.body.model_name
    ]);
    res.json({ id: info.lastInsertRowid });
  });
  app.patch("/api/credentials/:id/activate", async (req: AccountRequest, res) => {
    await run("UPDATE llm_credentials SET is_active = 0 WHERE account_id = ? AND provider = ?", [req.accountId, req.body.provider]);
    await run("UPDATE llm_credentials SET is_active = 1 WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    res.json({ success: true });
  });
  app.delete("/api/credentials/:id", async (req: AccountRequest, res) => {
    await run("DELETE FROM llm_credentials WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    res.json({ success: true });
  });

  app.get("/api/schedules", async (req: AccountRequest, res) => res.json(await query(`
    SELECT schedules.*, agents.name AS agent_name, team_members.name AS member_name
    FROM schedules
    LEFT JOIN agents ON agents.id = schedules.agent_id
    LEFT JOIN team_members ON team_members.id = schedules.member_id
    WHERE schedules.account_id = ?
    ORDER BY schedules.id DESC
  `, [req.accountId])));
  app.post("/api/schedules", async (req: AccountRequest, res) => {
    const info = await run("INSERT INTO schedules (account_id, name, agent_id, member_id, description) VALUES (?, ?, ?, ?, ?)", [
      req.accountId, req.body.name, req.body.agent_id || null, req.body.member_id || null, req.body.description
    ]);
    res.json({ id: info.lastInsertRowid });
  });
  app.delete("/api/schedules/:id", async (req: AccountRequest, res) => {
    await run("DELETE FROM schedules WHERE account_id = ? AND id = ?", [req.accountId, req.params.id]);
    res.json({ success: true });
  });

  app.post("/api/upload", (req: AccountRequest, res) => {
    upload.single("file")(req, res, (error: any) => {
      if (error) return res.status(400).json({ error: error?.code === "LIMIT_FILE_SIZE" ? "Arquivo excede o limite de 25MB" : sanitizePublicError(error) });
      const file = (req as any).file;
      if (!file) return res.status(400).json({ error: "Arquivo ausente" });
      const ext = safeUploadExtension(file.originalname || "");
      if (!ext) return res.status(400).json({ error: "Tipo de arquivo nao permitido" });
      const finalName = `${file.filename}${ext}`;
      fs.renameSync(file.path, path.join(uploadDir, finalName));
      const url = `/uploads/${finalName}`;
      res.json({ url, publicUrl: publicMediaUrl(url) });
    });
  });

  app.post("/api/ai/generate", async (req, res) => {
    const prompt = String(req.body?.prompt || "");
    res.json({ text: `Resposta gerada localmente para desenvolvimento: ${prompt.slice(0, 500)}` });
  });

  app.post("/api/bridge/event", async (req, res) => {
    if (req.headers["x-bridge-token"] !== BRIDGE_TOKEN) return res.status(401).json({ error: "Motor interno de mensageria não autorizado" });
    const { instanceId, accountId, event, payload } = req.body || {};
    const numericInstanceId = Number(instanceId);
    const numericAccountId = Number(accountId);

    if (event === "status") {
      const parentAccount = await get("SELECT parent_account_id FROM accounts WHERE id = ?", [numericAccountId]);
      const connected = isBridgeConnectedStatus(payload.status) && hasBridgeIdentity(payload);
      const storedStatus = connected ? payload.status : (payload.status === "open" ? "close" : payload.status);
      const publicStatus = publicInstanceStatus(storedStatus);
      const phone = payload.phoneConnected || payload.phone_connected || null;
      const profileName = payload.profileName || payload.profile_name || null;
      const profilePictureUrl = payload.profilePictureUrl || payload.profile_picture_url || null;
      await run(
        "UPDATE instances SET status = ?, connection_status = ?, phone_connected = CASE WHEN ? = 1 THEN COALESCE(?, phone_connected) ELSE NULL END, phone = CASE WHEN ? = 1 THEN COALESCE(?, phone) ELSE NULL END, jid = CASE WHEN ? = 1 THEN COALESCE(?, jid) ELSE NULL END, profile_name = CASE WHEN ? = 1 THEN COALESCE(?, profile_name) ELSE NULL END, profile_picture_url = CASE WHEN ? = 1 THEN COALESCE(?, profile_picture_url) ELSE NULL END, qr = CASE WHEN ? = 1 THEN NULL ELSE qr END, connected_at = CASE WHEN ? = 1 THEN COALESCE(connected_at, CURRENT_TIMESTAMP) ELSE connected_at END, disconnected_at = CASE WHEN ? IN ('close', 'none') THEN CURRENT_TIMESTAMP ELSE disconnected_at END, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [storedStatus, storedStatus, connected ? 1 : 0, phone, connected ? 1 : 0, phone, connected ? 1 : 0, payload.jid || null, connected ? 1 : 0, profileName, connected ? 1 : 0, profilePictureUrl, connected ? 1 : 0, connected ? 1 : 0, storedStatus, numericInstanceId]
      );
      await logConnection(numericAccountId, numericInstanceId, "connection.update", storedStatus, {
        phone: connected ? phone : null,
        profileName: connected ? profileName : null,
        ignoredOpenWithoutIdentity: payload.status === "open" && !connected
      });
      io.to(`account:${numericAccountId}`).emit("instance.status", {
        instanceId: numericInstanceId,
        status: publicStatus,
        phoneConnected: connected ? phone : null,
        profileName: connected ? profileName : null,
        profilePictureUrl: connected ? profilePictureUrl : null
      });
      if (parentAccount?.parent_account_id) {
        io.to(`account:${parentAccount.parent_account_id}`).emit("instance.status", {
          instanceId: numericInstanceId,
          accountId: numericAccountId,
          status: publicStatus
        });
      }
      io.to("admin:monitor").emit("instance.status", { instanceId: numericInstanceId, accountId: numericAccountId, status: publicStatus });
      emitInstanceWs(numericInstanceId, "connection.status", { ...payload, status: publicStatus });
      emitInstanceWs(numericInstanceId, "instance.status", {
        instanceId: numericInstanceId,
        status: publicStatus,
        phoneConnected: connected ? phone : null,
        profileName: connected ? profileName : null,
        profilePictureUrl: connected ? profilePictureUrl : null
      });
      io.to(`instance:${numericInstanceId}`).emit("connection.status", { ...payload, status: publicStatus });
      io.to(`instance:${numericInstanceId}`).emit("instance.status", {
        instanceId: numericInstanceId,
        status: publicStatus,
        phoneConnected: connected ? phone : null,
        profileName: connected ? profileName : null,
        profilePictureUrl: connected ? profilePictureUrl : null
      });
      emitUazSse(numericInstanceId, "connection", { ...payload, status: uazConnectionStatus(payload.status) });
      await dispatchWebhook(numericInstanceId, "connection.update", payload).catch(() => null);

      const disconnectedStatuses = ["close", "none", "disconnected", "logged_out"];
      if (disconnectedStatuses.includes(String(payload.status))) {
        const instName = (await get("SELECT name FROM instances WHERE id = ?", [numericInstanceId]))?.name || `Instancia #${numericInstanceId}`;
        supportAlertsQueue.add("instance-disconnected", {
          accountId: numericAccountId,
          instanceId: numericInstanceId,
          severity: "warning",
          type: "instance_disconnected",
          title: `Instância desconectada`,
          description: `${instName} foi desconectada (${payload.status}).`
        }, { attempts: 3, backoff: { type: "exponential", delay: 10000 } }).catch(() => null);

        sendDisconnectNotification(numericInstanceId, numericAccountId, String(payload.status));
      }

      emitInstanceWs(numericInstanceId, "instance.health.updated", {
        instanceId: numericInstanceId,
        status: publicStatus,
        timestamp: new Date().toISOString()
      });
      io.to("admin:monitor").emit("instance.health.updated", {
        instanceId: numericInstanceId,
        accountId: numericAccountId,
        status: publicStatus,
        timestamp: new Date().toISOString()
      });
    } else if (event === "qr") {
      const parentAccount = await get("SELECT parent_account_id FROM accounts WHERE id = ?", [numericAccountId]);
      const qrImage = await qrToImage(payload.qr);
      await run("UPDATE instances SET status = ?, connection_status = ?, qr = ?, last_qr = ?, last_qr_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", ["qr", "qr_pending", qrImage, qrImage, numericInstanceId]);
      await logConnection(numericAccountId, numericInstanceId, "qrcode.updated", "qr_pending");
      io.to(`account:${numericAccountId}`).emit("instance.qr", { instanceId: numericInstanceId, qr: qrImage });
      if (parentAccount?.parent_account_id) io.to(`account:${parentAccount.parent_account_id}`).emit("instance.qr", { instanceId: numericInstanceId, accountId: numericAccountId, qr: qrImage });
      io.to("admin:monitor").emit("instance.qr", { instanceId: numericInstanceId, accountId: numericAccountId, qr: qrImage });
      emitInstanceWs(numericInstanceId, "instance.qr", { instanceId: numericInstanceId, qr: qrImage });
      io.to(`instance:${numericInstanceId}`).emit("instance.qr", { instanceId: numericInstanceId, qr: qrImage });
      emitUazSse(numericInstanceId, "connection", { status: "connecting", qr: qrImage });
      await dispatchWebhook(numericInstanceId, "qrcode.updated", { ...payload, qr: qrImage, raw: payload.qr }).catch(() => null);
    } else if (event === "receipt") {
      const status = receiptDeliveryStatus(payload?.Type ?? payload?.type);
      const ids = (payload?.MessageIDs || payload?.messageIDs || payload?.message_ids || [])
        .map((id: any) => String(id || "").trim())
        .filter(Boolean);
      if (status && ids.length) {
        const receiptType = String(payload?.Type ?? payload?.type ?? "");
        const updated: any[] = [];
        for (const messageId of ids) {
          const campaignRecipient = await get("SELECT id, campaign_id FROM campaign_recipients WHERE message_id = ? ORDER BY id DESC LIMIT 1", [messageId]);
          if (campaignRecipient) {
            if (status === "delivered") {
              await run("UPDATE campaign_recipients SET status = CASE WHEN status = 'read' THEN status ELSE 'delivered' END, delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?", [campaignRecipient.id]);
            } else if (status === "read") {
              await run("UPDATE campaign_recipients SET status = 'read', delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP), read_at = COALESCE(read_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?", [campaignRecipient.id]);
            } else if (status === "failed") {
              await run("UPDATE campaign_recipients SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [receiptType || "delivery_failed", campaignRecipient.id]);
            }
            await run(
              "UPDATE campaigns SET sent_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status IN ('sent','delivered','read')), delivered_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status IN ('delivered','read')), read_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status = 'read'), failed_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status = 'failed'), completed_at = CASE WHEN NOT EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND status IN ('pending','queued')) THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE completed_at END, status = CASE WHEN NOT EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND status IN ('pending','queued')) THEN 'completed' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
              [campaignRecipient.campaign_id, campaignRecipient.campaign_id, campaignRecipient.campaign_id, campaignRecipient.campaign_id, campaignRecipient.campaign_id, campaignRecipient.campaign_id, campaignRecipient.campaign_id]
            );
          }
          const message = await get(
            "SELECT * FROM messages WHERE account_id = ? AND instance_id = ? AND message_id = ?",
            [numericAccountId, numericInstanceId, messageId]
          );
          if (!message) continue;
          if (status !== "failed" && deliveryStatusRank(message.delivery_status) >= deliveryStatusRank(status)) continue;
          await run("UPDATE messages SET delivery_status = ? WHERE id = ?", [status, message.id]);
          const freshMessage = await get("SELECT * FROM messages WHERE id = ?", [message.id]);
          updated.push(freshMessage);
          await logMessage(numericAccountId, numericInstanceId, messageId, message.direction || "outbound", status, { receiptType, raw: payload });
          io.to(`account:${numericAccountId}`).emit("message.status", { messageId, status, message: freshMessage });
          emitInstanceWs(numericInstanceId, "message.status", { messageId, status, message: freshMessage });
          io.to(`instance:${numericInstanceId}`).emit("message.status", { messageId, status, message: freshMessage });
          emitUazSse(numericInstanceId, "messages.status", { id: messageId, status });
          await dispatchWebhook(numericInstanceId, "message.status", { message: freshMessage, status, receiptType }).catch(() => null);
          const contactPhone = freshMessage?.author_phone || (await get("SELECT remote_jid FROM conversations WHERE id = ?", [freshMessage?.conversation_id]))?.remote_jid || "";
          dispatchIntegrationsStatus(numericInstanceId, numericAccountId, String(contactPhone), messageId, status).catch(() => null);
        }
        if (updated.length) {
          io.to("admin:monitor").emit("message.status", { accountId: numericAccountId, instanceId: numericInstanceId, status, messages: updated });
        }
      }
    } else if (event === "presence") {
      emitInstanceWs(numericInstanceId, "contact.presence", payload);
      io.to(`instance:${numericInstanceId}`).emit("contact.presence", payload);
      io.to(`account:${numericAccountId}`).emit("contact.presence", { instanceId: numericInstanceId, ...payload });
      emitUazSse(numericInstanceId, "presence", payload);
      await dispatchWebhook(numericInstanceId, "contact.presence", payload).catch(() => null);
    } else if (event === "message") {
      if (shouldSkipMessagePayload(payload)) return res.json({ success: true, skipped: true });
      const source = getMessageSource(payload);
      const isFromMe = Boolean(payload?.Info?.IsFromMe ?? payload?.info?.isFromMe);
      const chatJid = selectConversationJid(source, isFromMe);
      const authorJid = selectAuthorJid(source, isFromMe);
      if (!chatJid || isIgnoredChatJid(chatJid) || isIgnoredChatJid(source.chatJid) || isIgnoredChatJid(source.senderJid)) {
        return res.json({ success: true, skipped: true, reason: "ignored_chat_jid" });
      }
      // Resolve pushName com fallback para número formatado
      const resolvedPushName = source.pushName || source.formattedNumber || "";
      // Para grupos, tenta usar o groupName enriquecido primeiro
      let conversationTitle = source.groupName || conversationTitleFromMessage(chatJid, payload, source.pushName, source.formattedNumber);
      const conversation = await ensureConversation(numericAccountId, numericInstanceId, chatJid, conversationTitle);
      const { contentType, contentText: rawContentText } = getContentFromPayload(payload);
      let contentText = rawContentText;
      // Processa menções no texto: substitui @numero pelo push name ou número formatado
      if (contentType === "text" && contentText && contentText.includes("@")) {
        const mentionedContacts = payload?.Info?.MentionedContacts || payload?.info?.mentionedContacts || [];
        if (Array.isArray(mentionedContacts) && mentionedContacts.length > 0) {
          for (const mention of mentionedContacts) {
            const mentionJid = mention.jid || "";
            const mentionPushName = mention.pushName || "";
            const mentionFormatted = mention.formattedNumber || "";
            const mentionLabel = mentionPushName || mentionFormatted || mentionJid;
            const mentionUser = normalizePhone(mentionJid);
            if (mentionUser) {
              contentText = contentText.replace(new RegExp(`@${mentionUser}`, "g"), `@${mentionLabel}`);
            }
          }
        }
      }
      if (contentType !== "text") {
        const storedMediaUrl = await storeReceivedMedia(numericAccountId, numericInstanceId, source.id, contentType, chatJid);
        if (storedMediaUrl) contentText = storedMediaUrl;
      }
      const shouldRefreshChatProfile = !isFromMe && (
        !conversation.contact_profile_picture_url ||
        (isGroupJid(chatJid) && (!conversationTitle || String(conversation.title || "") === chatJid))
      );
      const chatProfile = shouldRefreshChatProfile
        ? await getChatProfile(numericAccountId, numericInstanceId, chatJid)
        : { name: "", pictureUrl: "" };
      if (isGroupJid(chatJid) && chatProfile.name) conversationTitle = chatProfile.name;
      const contactProfilePictureUrl = chatProfile.pictureUrl;
      const direction = isFromMe ? "outbound" : "inbound";
      const duplicate = await get("SELECT id FROM messages WHERE account_id = ? AND message_id = ?", [numericAccountId, source.id]);
      if (!duplicate) {
        const displayName = resolvedPushName;
        const info = await run(
          "INSERT INTO messages (account_id, instance_id, conversation_id, direction, chat_type, author_phone, author_push_name, content_type, content_text, message_id, delivery_status, from_me, sender, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [numericAccountId, numericInstanceId, conversation.id, direction, conversation.type, normalizePhone(authorJid), displayName, contentType, contentText, source.id, isFromMe ? "sent" : "received", isFromMe ? 1 : 0, isFromMe ? "human" : "lead", JSON.stringify(payload)]
        );
        await logMessage(numericAccountId, numericInstanceId, source.id, direction, isFromMe ? "sent" : "received", { conversationId: conversation.id, contentType });
        const conversationDisplayTitle = conversation.type === "group"
          ? conversationTitle
          : (cleanDisplayName(source.pushName) || source.formattedNumber || "");
        await run(
          "UPDATE conversations SET remote_jid = COALESCE(NULLIF(?, ''), remote_jid), title = COALESCE(NULLIF(?, ''), title), contact_profile_picture_url = COALESCE(NULLIF(?, ''), contact_profile_picture_url), last_message_preview = ?, unread_count = unread_count + ?, last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [chatJid, conversationDisplayTitle, contactProfilePictureUrl, contentType === "text" ? contentText : mediaPreview(contentType, contentText), isFromMe ? 0 : 1, conversation.id]
        );
        const message = await get("SELECT * FROM messages WHERE id = ?", [info.lastInsertRowid]);
        const updatedConversation = await get("SELECT *, last_message_preview AS last_message FROM conversations WHERE id = ?", [conversation.id]);
        io.to(`account:${numericAccountId}`).emit("message.new", { conversationId: conversation.id, message, conversation: updatedConversation });
        const parentAccount = await get("SELECT parent_account_id FROM accounts WHERE id = ?", [numericAccountId]);
        if (parentAccount?.parent_account_id) io.to(`account:${parentAccount.parent_account_id}`).emit("message.new", { accountId: numericAccountId, conversationId: conversation.id, message, conversation: updatedConversation });
        io.to("admin:monitor").emit("message.new", { accountId: numericAccountId, instanceId: numericInstanceId, conversationId: conversation.id, message, conversation: updatedConversation });
        emitInstanceWs(numericInstanceId, "message.new", { conversationId: conversation.id, message, conversation: updatedConversation });
        io.to(`instance:${numericInstanceId}`).emit("message.new", { conversationId: conversation.id, message, conversation: updatedConversation });
        emitUazSse(numericInstanceId, "messages", { message, conversation: updatedConversation });
        await dispatchWebhook(numericInstanceId, conversation.type === "group" ? "group.message.received" : "message.received", { message, conversation: updatedConversation }).catch(() => null);
        if (!isFromMe && conversation.type === "group") {
          applyGroupModeration({
            accountId: numericAccountId,
            instanceId: numericInstanceId,
            groupJid: chatJid,
            participantJid: authorJid,
            messageId: source.id,
            contentType,
            contentText
          }).catch((error) => console.error("[GROUP_MODERATION_FAILED]", sanitizePublicError(error)));
        }
        dispatchIntegrations(numericInstanceId, numericAccountId, "message.received", { message, conversation: updatedConversation }).catch(() => null);
      }
    }

    res.json({ success: true });
  });

  io.on("connection", async (socket) => {
    const { accountId, apiKey, token } = socket.handshake.query;
    const payload = verifyToken(Array.isArray(token) ? token[0] : token);
    if (payload?.accountId) {
      const account = await get("SELECT id, account_type, status FROM accounts WHERE id = ? AND deleted_at IS NULL", [payload.accountId]);
      if (!accountCanOperate(account) && payload.role !== "super_admin") return socket.disconnect();
      socket.join(`account:${payload.accountId}`);
      if (payload.role === "super_admin") socket.join("admin:monitor");
      if (["owner", "reseller"].includes(String(account?.account_type || "")) || payload.role === "super_admin") {
        for (const child of await query("SELECT id FROM accounts WHERE parent_account_id = ? AND deleted_at IS NULL", [payload.accountId])) {
          socket.join(`account:${child.id}`);
        }
      }
    }

    if (apiKey) {
      const inst = await get(`
        SELECT instances.id, instances.account_id, instances.websocket_enabled, accounts.status AS account_status
        FROM instances
        LEFT JOIN accounts ON accounts.id = instances.account_id
        WHERE instances.api_key = ? AND instances.deleted_at IS NULL
      `, [apiKey]);
      if (inst) {
        if (inactiveAccountStatuses.has(String(inst.account_status || "active"))) return socket.disconnect();
        if (Number(inst.websocket_enabled ?? 1) === 0) return socket.disconnect();
        socket.join(`instance:${inst.id}`);
      } else socket.disconnect();
    }

    if (!payload?.accountId && !apiKey) socket.disconnect();
  });

  async function processWebhookRetries() {
    const rows = await query("SELECT id FROM webhook_events WHERE status = 'retrying' AND error LIKE 'QUEUE_UNAVAILABLE:%' AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP) ORDER BY id ASC LIMIT 25");
    for (const row of rows) {
      await deliverWebhookEvent(Number(row.id));
    }
  }

  setInterval(() => {
    processWebhookRetries().catch((error) => console.error("Webhook retry failed:", error));
  }, 30000);

  setInterval(() => {
    deleteExpiredTrialAccounts().catch((error) => console.error("Trial cleanup failed:", error));
  }, 60000);

  setInterval(async () => {
    try {
      const counts = await webhookDeliveryQueue.getJobCounts("waiting", "active", "delayed", "failed");
      const msgCounts = await messageSendQueue.getJobCounts("waiting", "active", "delayed", "failed");
      const onlineInstances = await query("SELECT COUNT(*) AS total FROM instances WHERE connection_status IN ('open', 'connected') AND deleted_at IS NULL")[0]?.total || 0;
      const openAlerts = (await get("SELECT COUNT(*) AS total FROM support_alerts WHERE status = 'open'"))?.total || 0;
      const webhookFails = (await get("SELECT COUNT(*) AS total FROM webhook_delivery_logs WHERE success = 0 AND created_at >= datetime('now','-1 hour')"))?.total || 0;

      io.to("admin:monitor").emit("queue.metrics.updated", {
        webhookDelivery: { waiting: counts.waiting || 0, active: counts.active || 0, failed: counts.failed || 0 },
        messageSend: { waiting: msgCounts.waiting || 0, active: msgCounts.active || 0, failed: msgCounts.failed || 0 },
        instancesOnline: Number(onlineInstances),
        openAlerts: Number(openAlerts),
        webhookFailures1h: Number(webhookFails),
        timestamp: new Date().toISOString()
      });
    } catch (e) {}
  }, 15000);

  setInterval(() => {
    try {
      io.emit("wooapi:heartbeat", { timestamp: new Date().toISOString() });
    } catch (e) {}
  }, 30000);

  const reconnectable = await query("SELECT * FROM instances WHERE deleted_at IS NULL AND (status IN ('open', 'connected', 'connecting', 'qr') OR connection_status IN ('open', 'connected'))");
  for (const inst of reconnectable) {
    const status = String(inst.connection_status || inst.status || "");
    const updatedAt = Date.parse(String(inst.updated_at || ""));
    const freshPairing = ["connecting", "qr", "qr_pending"].includes(status)
      && Number.isFinite(updatedAt)
      && Date.now() - updatedAt <= 5 * 60 * 1000;
    const hasPersistedSession = Boolean(inst.jid) || ["open", "connected"].includes(status);
    if (!hasPersistedSession && !freshPairing) {
      await bridgeFetch(`/instances/${inst.id}/logout`, { method: "POST" }).catch(() => null);
      await run(
        "UPDATE instances SET status = ?, connection_status = ?, qr = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        ["close", "close", inst.id]
      );
      continue;
    }
    try {
      const bridgeStatus = await bridgeFetch(`/instances/${inst.id}/status?account_id=${inst.account_id}`, { method: "GET" });
      const runtimeStatus = String(bridgeStatus?.status || "").toLowerCase();
      if (["open", "connected", "connecting", "qr"].includes(runtimeStatus)) {
        await syncInstanceStatusFromBridge(inst);
        continue;
      }
    } catch {
      // A missing runtime client is restored below from its persisted device.
    }
    connectInstance(inst.id, inst.account_id).catch(async (error) => {
      await run("UPDATE instances SET status = ?, connection_status = ?, qr = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", ["close", "close", inst.id]);
      console.error("Reconnect failed:", inst.id, error);
    });
  }

  // ── LGPD / Data Privacy Endpoints ──

  app.get("/privacy", async (_req, res) => {
    const filePath = path.resolve("docs/privacy.md");
    if (fs.existsSync(filePath)) return res.type("text/markdown").sendFile(filePath);
    return res.type("text/html").send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Política de Privacidade</title><style>body{font-family:sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6}</style></head><body><h1>Política de Privacidade</h1><p>Em construção. Consulte o arquivo <code>docs/privacy.md</code> para a política completa.</p></body></html>`);
  });

  app.post("/api/data/export", requireAccount, async (req: AccountRequest, res) => {
    try {
      const accountId = Number(req.accountId);
      const instances = await query("SELECT id, name, phone, status, created_at FROM instances WHERE account_id = ? AND deleted_at IS NULL", [accountId]);
      const conversations = await query("SELECT id, remote_jid, contact_phone, title, status, last_message_preview, last_message_at, created_at FROM conversations WHERE account_id = ?", [accountId]);
      const messages = await query("SELECT id, conversation_id, direction, content_type, content_text, delivery_status, created_at FROM messages WHERE account_id = ? ORDER BY id DESC LIMIT 5000", [accountId]);
      const leads = await query("SELECT id, name, phone, email, address, status, created_at FROM leads WHERE account_id = ?", [accountId]);
      const consentRecords = await query("SELECT purpose, consent_type, granted, granted_at, revoked_at FROM data_consent WHERE account_id = ?", [accountId]);

      const account = await get("SELECT id, name, email, account_type, status, created_at FROM accounts WHERE id = ?", [accountId]);
      const subjectRequest = await run(
        "INSERT INTO data_subject_requests (account_id, request_type, status, requested_by, notes) VALUES (?, 'export', 'completed', ?, ?)",
        [accountId, req.user?.email || "api", JSON.stringify({ exportGeneratedAt: new Date().toISOString() })]
      );
      await run("UPDATE data_subject_requests SET processed_at = CURRENT_TIMESTAMP WHERE id = ?", [subjectRequest.lastInsertRowid]);

      const exportPayload = {
        exportedAt: new Date().toISOString(),
        account,
        instances,
        conversations,
        messages,
        leads,
        consentRecords
      };
      await audit(accountId, Number(req.user?.userId) || null, "data.export", { requestId: Number(subjectRequest.lastInsertRowid) });
      return res.json({ success: true, requestId: Number(subjectRequest.lastInsertRowid), data: exportPayload });
    } catch (error) {
      return res.status(500).json({ error: sanitizePublicError(error) });
    }
  });

  app.post("/api/data/anonymize", requireAccount, async (req: AccountRequest, res) => {
    try {
      const accountId = Number(req.accountId);
      const scope = String(req.body?.scope || "account");
      const subjectRequest = await run(
        "INSERT INTO data_subject_requests (account_id, request_type, status, requested_by, notes) VALUES (?, 'anonymize', 'processing', ?, ?)",
        [accountId, req.user?.email || "api", JSON.stringify({ scope, triggeredAt: new Date().toISOString() })]
      );
      const requestId = Number(subjectRequest.lastInsertRowid);

      if (scope === "messages" || scope === "all") {
        const msgCount = await query("SELECT COUNT(*) AS total FROM messages WHERE account_id = ?", [accountId]);
        await run("UPDATE messages SET content_text = '[ANONYMIZED]', author_phone = NULL, author_push_name = NULL, raw_json = '{}' WHERE account_id = ?", [accountId]);
      }
      if (scope === "leads" || scope === "all") {
        await run("UPDATE leads SET name = '[ANONYMIZED]', phone = NULL, email = NULL, address = NULL, custom_fields_json = '{}' WHERE account_id = ?", [accountId]);
      }
      if (scope === "conversations" || scope === "all") {
        await run("UPDATE conversations SET contact_phone = NULL, contact_profile_picture_url = NULL WHERE account_id = ?", [accountId]);
      }
      if (scope === "account" || scope === "all") {
        await run("UPDATE accounts SET email = CONCAT('anonymized_', id, '@anonymized.com'), name = CONCAT('Usuario ', id) WHERE id = ?", [accountId]);
      }

      await run("UPDATE data_subject_requests SET status = 'completed', processed_at = CURRENT_TIMESTAMP WHERE id = ?", [requestId]);
      await audit(accountId, Number(req.user?.userId) || null, "data.anonymize", { requestId, scope });
      return res.json({ success: true, requestId, scope, message: "Dados anonimizados com sucesso" });
    } catch (error) {
      return res.status(500).json({ error: sanitizePublicError(error) });
    }
  });

  app.post("/api/data/consent", requireAccount, async (req: AccountRequest, res) => {
    try {
      const accountId = Number(req.accountId);
      const { purpose, consent_type, granted, userId } = req.body || {};
      if (!purpose) return res.status(400).json({ error: "purpose é obrigatório" });

      if (granted === false || granted === "false") {
        await run(
          "UPDATE data_consent SET granted = 0, revoked_at = CURRENT_TIMESTAMP WHERE account_id = ? AND purpose = ? AND granted = 1",
          [accountId, purpose]
        );
        await audit(accountId, Number(req.user?.userId) || null, "data.consent.revoked", { purpose, consentType: consent_type || "lgpd" });
        return res.json({ success: true, granted: false, purpose });
      }

      const consent = await get(
        "SELECT id FROM data_consent WHERE account_id = ? AND purpose = ? AND user_id IS ? AND granted = 1",
        [accountId, purpose, userId || null]
      );
      if (consent) return res.json({ success: true, granted: true, purpose, message: "Consentimento já registrado" });

      const info = await run(
        "INSERT INTO data_consent (account_id, user_id, purpose, consent_type, granted, ip_address, user_agent) VALUES (?, ?, ?, ?, 1, ?, ?)",
        [accountId, userId || null, purpose, consent_type || "lgpd", req.ip || null, req.headers["user-agent"] || null]
      );
      await audit(accountId, Number(req.user?.userId) || null, "data.consent.granted", { purpose, consentType: consent_type || "lgpd", consentId: Number(info.lastInsertRowid) });
      return res.json({ success: true, granted: true, purpose, consentId: Number(info.lastInsertRowid) });
    } catch (error) {
      return res.status(500).json({ error: sanitizePublicError(error) });
    }
  });

  app.get("/api/data/consent/:userId", requireAccount, async (req: AccountRequest, res) => {
    try {
      const accountId = Number(req.accountId);
      const userId = req.params.userId === "me" ? null : Number(req.params.userId);
      const rows = await query(
        "SELECT id, purpose, consent_type, granted, granted_at, revoked_at, created_at FROM data_consent WHERE account_id = ? AND (? IS NULL OR user_id = ?) ORDER BY id DESC",
        [accountId, userId, userId]
      );
      return res.json({ success: true, data: rows });
    } catch (error) {
      return res.status(500).json({ error: sanitizePublicError(error) });
    }
  });

  app.get("/api/data/requests", requireAccount, async (req: AccountRequest, res) => {
    try {
      const rows = await query(
        "SELECT id, request_type, status, requested_by, notes, processed_at, expires_at, created_at FROM data_subject_requests WHERE account_id = ? ORDER BY id DESC LIMIT 50",
        [req.accountId]
      );
      return res.json({ success: true, data: rows });
    } catch (error) {
      return res.status(500).json({ error: sanitizePublicError(error) });
    }
  });

  // ── Retention Policy Scheduler ──
  setInterval(async () => {
    try {
      const policies = await query("SELECT * FROM data_retention_policies WHERE enabled = 1");
      for (const policy of policies) {
        const cutoff = new Date(Date.now() - Number(policy.retention_days) * 86400000).toISOString();
        if (policy.data_type === "messages") {
          await run("DELETE FROM messages WHERE account_id = ? AND ? = 0 OR (instance_id = ? AND created_at < ?)", [policy.account_id, policy.instance_id || 0, policy.instance_id || 0, cutoff]);
        } else if (policy.data_type === "logs") {
          await run("DELETE FROM message_logs WHERE account_id = ? AND (? = 0 OR instance_id = ?) AND created_at < ?", [policy.account_id, policy.instance_id || 0, policy.instance_id || 0, cutoff]);
          await run("DELETE FROM connection_logs WHERE account_id = ? AND (? = 0 OR instance_id = ?) AND created_at < ?", [policy.account_id, policy.instance_id || 0, policy.instance_id || 0, cutoff]);
        } else if (policy.data_type === "webhooks") {
          await run("DELETE FROM webhook_events WHERE account_id = ? AND (? = 0 OR instance_id = ?) AND created_at < ?", [policy.account_id, policy.instance_id || 0, policy.instance_id || 0, cutoff]);
          await run("DELETE FROM webhook_delivery_logs WHERE account_id = ? AND (? = 0 OR instance_id = ?) AND created_at < ?", [policy.account_id, policy.instance_id || 0, policy.instance_id || 0, cutoff]);
        } else if (policy.data_type === "consent") {
          await run("DELETE FROM data_consent WHERE account_id = ? AND revoked_at IS NOT NULL AND revoked_at < ?", [policy.account_id, cutoff]);
        }
      }
    } catch (e) {
      console.error("[RETENTION_POLICY_SCHEDULER]", e);
    }
  }, 3600000).unref();

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
    app.get("*", async (_req, res) => res.sendFile(path.resolve("dist/index.html")));
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`WOOAPI ONLINE PORT ${PORT}`);
  });
}

startServer().catch(async (error) => {
  console.error("Server failed:", error);
  process.exit(1);
});
