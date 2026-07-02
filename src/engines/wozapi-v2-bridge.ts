import dotenv from "dotenv";
import express, { type Request, type Response } from "express";

dotenv.config();

const PORT = Number(process.env.WOZAPI_V2_BRIDGE_PORT || 3003);
const TOKEN = process.env.BRIDGE_TOKEN || "dev-bridge-token";
const NODE_URL = (process.env.NODE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const UPSTREAM_URL = (process.env.WOZAPI_V2_UPSTREAM_URL || "http://127.0.0.1:3004").replace(/\/+$/, "");
const UPSTREAM_API_KEY = process.env.WOZAPI_V2_UPSTREAM_API_KEY || "";
const PUBLIC_BRIDGE_URL = (process.env.WOZAPI_V2_PUBLIC_BRIDGE_URL || "").replace(/\/+$/, "");
const WEBHOOK_URL = process.env.WOZAPI_V2_WEBHOOK_URL || (PUBLIC_BRIDGE_URL ? `${PUBLIC_BRIDGE_URL}/webhooks/wozapi-v2` : "");
const SESSION_PREFIX = process.env.WOZAPI_V2_SESSION_PREFIX || "wozapi2";
const DEVICE_NAME = process.env.WOZAPI_V2_DEVICE_NAME || "Wozapi2";
const BROWSER_NAME = process.env.WOZAPI_V2_BROWSER_NAME || "Wozapi2";

const sessions = new Map<string, { instanceId: number; accountId: number }>();
const lastQR = new Map<number, string>();
const lastStatus = new Map<number, any>();
let upstreamValidatedAt = 0;

const app = express();
app.use(express.json({ limit: "50mb" }));

function sessionName(instanceId: number | string) {
  return `${SESSION_PREFIX}_${String(instanceId).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function instanceIdFromSession(session?: string) {
  const value = String(session || "");
  const prefix = `${SESSION_PREFIX}_`;
  return value.startsWith(prefix) ? Number(value.slice(prefix.length)) : 0;
}

function authorized(req: Request) {
  return req.header("X-Bridge-Token") === TOKEN;
}

function requireAuth(req: Request, res: Response) {
  if (authorized(req)) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

function upstreamHeaders(extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (UPSTREAM_API_KEY) headers["X-Api-Key"] = UPSTREAM_API_KEY;
  return headers;
}

async function upstream(pathname: string, options: RequestInit = {}) {
  const response = await fetch(`${UPSTREAM_URL}${pathname}`, {
    ...options,
    headers: upstreamHeaders(options.headers as Record<string, string> || {})
  });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  let data: any = {};
  if (contentType.includes("application/json")) {
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  } else {
    data = text ? { error: text } : {};
  }
  if (!response.ok) {
    throw new Error(String(data?.message || data?.error || text || `Wozapi Core v2 error ${response.status}`));
  }
  return data;
}

async function ensureUpstreamReady() {
  if (Date.now() - upstreamValidatedAt < 15000) return;
  try {
    await upstream("/api/server/version", { method: "GET" });
    upstreamValidatedAt = Date.now();
  } catch (error: any) {
    throw new Error(`Wozapi 2.0 upstream indisponivel ou invalido em ${UPSTREAM_URL}. Inicie o WAHA nesse endereco e configure WOZAPI_V2_UPSTREAM_API_KEY se houver chave. Detalhe: ${error?.message || error}`);
  }
}

function toChatId(jid: string) {
  const value = String(jid || "").trim();
  if (!value) return value;
  if (value.endsWith("@s.whatsapp.net")) return `${value.replace("@s.whatsapp.net", "")}@c.us`;
  if (value.endsWith("@whatsapp.net")) return `${value.replace("@whatsapp.net", "")}@c.us`;
  return value;
}

function fromChatId(chatId?: string) {
  const value = String(chatId || "").trim();
  if (!value) return "";
  if (value.endsWith("@c.us")) return `${value.replace("@c.us", "")}@s.whatsapp.net`;
  return value;
}

function phoneFromIdentity(identity: any) {
  const raw = String(identity?.id || identity?.jid || identity?.me?.id || identity?.me?.jid || "");
  return raw.replace(/@c\.us|@s\.whatsapp\.net|:\d+/g, "").replace(/\D/g, "");
}

function normalizeStatus(value: string) {
  const status = String(value || "").toUpperCase();
  if (["WORKING", "CONNECTED", "RUNNING"].includes(status)) return "open";
  if (["SCAN_QR_CODE", "STARTING"].includes(status)) return "qr";
  if (["FAILED", "STOPPED", "OFFLINE"].includes(status)) return "close";
  if (["PAIRING", "CONNECTING"].includes(status)) return "connecting";
  return String(value || "connecting").toLowerCase();
}

async function sendToNode(event: string, instanceId: number, accountId: number, payload: any) {
  if (!instanceId) return;
  await fetch(`${NODE_URL}/api/bridge/event`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Token": TOKEN
    },
    body: JSON.stringify({ event, instanceId, accountId, payload })
  }).catch(() => null);
}

async function ensureSession(instanceId: number, accountId: number, start = false, reset = false) {
  await ensureUpstreamReady();
  const name = sessionName(instanceId);
  sessions.set(name, { instanceId, accountId });

  const config: any = {
    client: { deviceName: DEVICE_NAME, browserName: BROWSER_NAME },
    metadata: { instanceId: String(instanceId), accountId: String(accountId || "") },
    noweb: { store: { enabled: true, fullSync: false }, markOnline: true }
  };
  if (WEBHOOK_URL) {
    config.webhooks = [{
      url: WEBHOOK_URL,
      events: ["session.status", "message", "message.any", "message.ack", "message.reaction"]
    }];
  }

  if (reset) {
    await upstream(`/api/sessions/${encodeURIComponent(name)}/logout`, { method: "POST" }).catch(() => null);
    await upstream(`/api/sessions/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => null);
    lastQR.delete(instanceId);
    lastStatus.delete(instanceId);
  }

  try {
    await upstream(`/api/sessions/${encodeURIComponent(name)}`, { method: "GET" });
    await upstream(`/api/sessions/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ config })
    }).catch(() => null);
  } catch {
    await upstream("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ name, start, config })
    });
    return name;
  }

  if (start) {
    await upstream(`/api/sessions/${encodeURIComponent(name)}/start`, { method: "POST" }).catch(() => null);
  }
  return name;
}

async function readStatus(instanceId: number, accountId: number) {
  const name = await ensureSession(instanceId, accountId, false);
  const info = await upstream(`/api/sessions/${encodeURIComponent(name)}`, { method: "GET" });
  const status = normalizeStatus(info?.status);
  const phone = phoneFromIdentity(info?.me || info);
  const payload: any = {
    status,
    session: name,
    engine: "wozapi-v2",
    phoneConnected: phone || undefined,
    phone_connected: phone || undefined,
    jid: info?.me?.jid ? fromChatId(info.me.jid) : undefined,
    profileName: info?.me?.pushName || undefined,
    profile_name: info?.me?.pushName || undefined,
    qr: lastQR.get(instanceId) || undefined
  };
  if (status === "open") delete payload.qr;
  lastStatus.set(instanceId, payload);
  return payload;
}

async function sendTextMessage(instanceId: number, accountId: number, jid: string, text: string) {
  const name = await ensureSession(instanceId, accountId, false);
  const result = await upstream("/api/sendText", {
    method: "POST",
    body: JSON.stringify({
      session: name,
      chatId: toChatId(jid),
      text: String(text || "")
    })
  });
  return { ...result, ID: result?.id || result?.ID || result?.messageId };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "wozapi_core_v2", port: PORT, version: "2.0.0" });
});

app.post("/instances/:id/connect", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const instanceId = Number(req.params.id);
  const accountId = Number(req.body?.account_id || req.query.account_id || 0);
  const forceNewQr = Boolean(req.body?.force_new_qr || req.body?.forceNewQr || req.query.force_new_qr || req.query.forceNewQr);
  try {
    const name = await ensureSession(instanceId, accountId, true, forceNewQr);
    let payload = await readStatus(instanceId, accountId);
    if (payload.status !== "open") {
      const qr = await upstream(`/api/${encodeURIComponent(name)}/auth/qr?format=raw`, { method: "GET" }).catch(() => null);
      const code = typeof qr === "string" ? qr : (qr?.value || qr?.qr || qr?.code || qr?.data || "");
      if (code) {
        lastQR.set(instanceId, code);
        payload = { ...payload, status: "qr", qr: code };
      }
    }
    res.json(payload);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Wozapi Core v2 unavailable" });
  }
});

app.get("/instances/:id/status", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const instanceId = Number(req.params.id);
  const accountId = Number(req.query.account_id || 0);
  try {
    res.json(await readStatus(instanceId, accountId));
  } catch {
    res.json(lastStatus.get(instanceId) || { status: "close" });
  }
});

app.post("/instances/:id/logout", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const instanceId = Number(req.params.id);
  const name = sessionName(instanceId);
  try {
    await upstream(`/api/sessions/${encodeURIComponent(name)}/logout`, { method: "POST" }).catch(() => null);
    await upstream(`/api/sessions/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => null);
    lastQR.delete(instanceId);
    lastStatus.set(instanceId, { status: "close" });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "logout failed" });
  }
});

app.post("/instances/:id/send", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const instanceId = Number(req.params.id);
  const accountId = Number(req.body?.account_id || 0);
  try {
    const result = await sendTextMessage(instanceId, accountId, req.body?.jid || req.body?.chatId, req.body?.text || req.body?.message);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "send failed" });
  }
});

app.post("/instances/:id/send-media", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const instanceId = Number(req.params.id);
  const accountId = Number(req.body?.account_id || 0);
  const mediaUrl = String(req.body?.mediaUrl || req.body?.media_url || req.body?.url || "");
  const mimeType = String(req.body?.mimeType || req.body?.mimetype || "");
  const fileName = String(req.body?.fileName || req.body?.filename || "arquivo");
  const type = String(req.body?.type || "").toLowerCase();
  try {
    const name = await ensureSession(instanceId, accountId, false);
    const endpoint = type === "image" || mimeType.startsWith("image/") ? "/api/sendImage" : "/api/sendFile";
    const result = await upstream(endpoint, {
      method: "POST",
      body: JSON.stringify({
        session: name,
        chatId: toChatId(req.body?.jid || req.body?.chatId),
        caption: String(req.body?.caption || ""),
        file: { url: mediaUrl, mimetype: mimeType || "application/octet-stream", filename: fileName }
      })
    });
    res.json({ ...result, ID: result?.id || result?.ID || result?.messageId });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "send media failed" });
  }
});

app.post("/instances/:id/send-buttons", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const instanceId = Number(req.params.id);
  const accountId = Number(req.body?.account_id || 0);
  const text = [
    req.body?.title ? `*${req.body.title}*` : "",
    req.body?.text || req.body?.body || "",
    ...(Array.isArray(req.body?.buttons) ? req.body.buttons.map((b: any, i: number) => `${i + 1}. ${b?.text || b?.title || b}`) : []),
    req.body?.footer || ""
  ].filter(Boolean).join("\n");
  try {
    res.json(await sendTextMessage(instanceId, accountId, req.body?.jid || req.body?.chatId, text));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "send buttons failed" });
  }
});

app.post("/instances/:id/send-list", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const instanceId = Number(req.params.id);
  const accountId = Number(req.body?.account_id || 0);
  const lines = [req.body?.title ? `*${req.body.title}*` : "", req.body?.text || req.body?.body || ""];
  for (const section of Array.isArray(req.body?.sections) ? req.body.sections : []) {
    if (section?.title) lines.push(`\n${section.title}`);
    for (const row of Array.isArray(section?.rows) ? section.rows : []) lines.push(`- ${row?.title || row}`);
  }
  try {
    res.json(await sendTextMessage(instanceId, accountId, req.body?.jid || req.body?.chatId, lines.filter(Boolean).join("\n")));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "send list failed" });
  }
});

app.post("/instances/:id/send-location", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const instanceId = Number(req.params.id);
  const accountId = Number(req.body?.account_id || 0);
  try {
    const name = await ensureSession(instanceId, accountId, false);
    const result = await upstream("/api/sendLocation", {
      method: "POST",
      body: JSON.stringify({
        session: name,
        chatId: toChatId(req.body?.jid || req.body?.chatId),
        latitude: Number(req.body?.latitude || req.body?.lat),
        longitude: Number(req.body?.longitude || req.body?.lng),
        title: String(req.body?.title || req.body?.name || "")
      })
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "send location failed" });
  }
});

app.post("/instances/:id/contacts/check", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const instanceId = Number(req.params.id);
  const accountId = Number(req.body?.account_id || 0);
  try {
    const name = await ensureSession(instanceId, accountId, false);
    const phone = String(req.body?.phone || req.body?.jid || "").replace(/\D/g, "");
    const result = await upstream(`/api/checkNumberStatus?session=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`, { method: "GET" });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "contact check failed" });
  }
});

app.get("/instances/:id/profile", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const instanceId = Number(req.params.id);
  const accountId = Number(req.query.account_id || 0);
  try {
    const name = await ensureSession(instanceId, accountId, false);
    const result = await upstream(`/api/${encodeURIComponent(name)}/profile`, { method: "GET" });
    res.json({
      ...result,
      id: fromChatId(result?.id),
      name: result?.name || result?.pushName || "",
      profilePictureUrl: result?.picture || result?.profilePictureUrl || null,
      profile_picture_url: result?.picture || result?.profilePictureUrl || null
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "profile failed" });
  }
});

app.get("/instances/:id/contacts", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const instanceId = Number(req.params.id);
  const accountId = Number(req.query.account_id || 0);
  try {
    const name = await ensureSession(instanceId, accountId, false);
    const result = await upstream(`/api/contacts/all?session=${encodeURIComponent(name)}`, { method: "GET" });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "contacts failed" });
  }
});

app.post("/instances/:id/contacts/info", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const instanceId = Number(req.params.id);
  const accountId = Number(req.body?.account_id || 0);
  try {
    const name = await ensureSession(instanceId, accountId, false);
    const chatId = toChatId(req.body?.jid || req.body?.chatId || req.body?.contactId);
    const result = await upstream(`/api/contacts?session=${encodeURIComponent(name)}&contactId=${encodeURIComponent(chatId)}`, { method: "GET" });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "contact info failed" });
  }
});

app.get("/instances/:id/groups", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const instanceId = Number(req.params.id);
  const accountId = Number(req.query.account_id || 0);
  try {
    const name = await ensureSession(instanceId, accountId, false);
    const result = await upstream(`/api/${encodeURIComponent(name)}/groups`, { method: "GET" });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "groups failed" });
  }
});

app.post("/instances/:id/groups/info", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const instanceId = Number(req.params.id);
  const accountId = Number(req.body?.account_id || 0);
  try {
    const name = await ensureSession(instanceId, accountId, false);
    const groupId = encodeURIComponent(toChatId(req.body?.jid || req.body?.groupId || req.body?.id));
    const result = await upstream(`/api/${encodeURIComponent(name)}/groups/${groupId}`, { method: "GET" });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "group info failed" });
  }
});

app.post("/webhooks/wozapi-v2", async (req, res) => {
  const body = req.body || {};
  const instanceId = instanceIdFromSession(body.session || body.payload?.name);
  const meta = sessions.get(String(body.session || "")) || { instanceId, accountId: Number(body.metadata?.accountId || 0) };
  const accountId = Number(meta.accountId || body.metadata?.accountId || 0);
  const payload = body.payload || {};
  const event = String(body.event || "");

  if (event === "session.status") {
    const status = normalizeStatus(payload.status);
    const phone = phoneFromIdentity(body.me || payload.me || payload);
    const data = {
      status,
      jid: (body.me?.jid || payload.me?.jid) ? fromChatId(body.me?.jid || payload.me?.jid) : undefined,
      phoneConnected: phone || undefined,
      phone_connected: phone || undefined,
      profileName: body.me?.pushName || payload.me?.pushName || undefined,
      profile_name: body.me?.pushName || payload.me?.pushName || undefined
    };
    lastStatus.set(meta.instanceId, data);
    await sendToNode("status", meta.instanceId, accountId, data);
  } else if (event === "message" || event === "message.any") {
    await sendToNode("message", meta.instanceId, accountId, {
      id: payload.id,
      messageId: payload.id,
      from: fromChatId(payload.from || payload.fromNumber || payload.chatId),
      chatId: fromChatId(payload.chatId || payload.from),
      body: payload.body || payload.text || payload.caption || "",
      text: payload.body || payload.text || payload.caption || "",
      timestamp: payload.timestamp || body.timestamp,
      fromMe: Boolean(payload.fromMe),
      raw: payload
    });
  } else if (event === "message.ack") {
    await sendToNode("receipt", meta.instanceId, accountId, {
      id: payload.id,
      messageId: payload.id,
      from: fromChatId(payload.from),
      to: fromChatId(payload.to),
      ack: payload.ack,
      ackName: payload.ackName,
      raw: payload
    });
  } else if (event === "message.reaction") {
    await sendToNode("reaction", meta.instanceId, accountId, payload);
  }
  res.json({ ok: true });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Wozapi Core v2 endpoint not implemented" });
});

app.listen(PORT, () => {
  console.log(`Wozapi Core v2 bridge running on :${PORT}`);
});
