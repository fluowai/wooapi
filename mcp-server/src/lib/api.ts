const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:3001";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "dev-bridge-token";
const API_URL = process.env.API_URL || "http://127.0.0.1:3000";

export interface ApiConfig {
  accountId?: number;
  instanceId?: number;
  apiKey?: string;
  token?: string;
}

async function apiFetch(pathname: string, options: RequestInit = {}, config?: ApiConfig) {
  const url = `${API_URL}${pathname}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {}),
  };
  if (config?.apiKey) headers["x-api-key"] = config.apiKey;
  if (config?.token) headers["authorization"] = `Bearer ${config.token}`;
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) {
    const msg = data.error || data.message || text || `API error ${res.status}`;
    throw new Error(String(msg));
  }
  return data;
}

async function bridgeFetch(pathname: string, options: RequestInit = {}) {
  const url = `${BRIDGE_URL}${pathname}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Token": BRIDGE_TOKEN,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) {
    const msg = data.error || data.message || text || `Bridge error ${res.status}`;
    throw new Error(String(msg));
  }
  return data;
}

export async function getInstances(config: ApiConfig) {
  return apiFetch("/api/v1/instances", { method: "GET" }, config);
}

export async function getInstanceStatus(instanceId: number, config: ApiConfig) {
  return bridgeFetch(`/instances/${instanceId}/status?account_id=${config.accountId || 0}`);
}

export async function sendMessage(instanceId: number, jid: string, text: string, config: ApiConfig) {
  return bridgeFetch(`/instances/${instanceId}/send`, {
    method: "POST",
    body: JSON.stringify({ account_id: config.accountId || 0, jid, text }),
  });
}

export async function sendMedia(instanceId: number, jid: string, mediaUrl: string, mimeType: string, caption: string, config: ApiConfig) {
  return bridgeFetch(`/instances/${instanceId}/send-media`, {
    method: "POST",
    body: JSON.stringify({
      account_id: config.accountId || 0, jid, mediaUrl, mimeType, caption,
      type: mimeType?.startsWith("image/") ? "image" : mimeType?.startsWith("audio/") ? "audio" : "document",
    }),
  });
}

export async function sendButtons(instanceId: number, jid: string, title: string, text: string, buttons: { id: string; text: string }[], footer?: string, config?: ApiConfig) {
  return bridgeFetch(`/instances/${instanceId}/send-buttons`, {
    method: "POST",
    body: JSON.stringify({
      account_id: config?.accountId || 0, jid, title, text, footer,
      buttons: buttons.map((b) => ({ id: b.id, text: b.text })),
    }),
  });
}

export async function sendList(instanceId: number, jid: string, title: string, text: string, buttonText: string, sections: { title: string; rows: { id: string; title: string; description?: string }[] }[], config?: ApiConfig) {
  return bridgeFetch(`/instances/${instanceId}/send-list`, {
    method: "POST",
    body: JSON.stringify({
      account_id: config?.accountId || 0, jid, title, text, buttonText, sections,
    }),
  });
}

export async function getConversations(config: ApiConfig) {
  return apiFetch("/api/v1/conversations", { method: "GET" }, config);
}

export async function getConversationMessages(conversationId: number, config: ApiConfig) {
  return apiFetch(`/api/v1/conversations/${conversationId}/messages`, { method: "GET" }, config);
}

export async function getGroups(instanceId: number, config: ApiConfig) {
  return bridgeFetch(`/instances/${instanceId}/groups?account_id=${config.accountId || 0}`, { method: "GET" });
}

export async function getGroupInfo(instanceId: number, jid: string, config: ApiConfig) {
  return bridgeFetch(`/instances/${instanceId}/groups/info`, {
    method: "POST",
    body: JSON.stringify({ account_id: config.accountId || 0, jid }),
  });
}

export async function createGroup(instanceId: number, name: string, participants: string[], config: ApiConfig) {
  return bridgeFetch(`/instances/${instanceId}/groups`, {
    method: "POST",
    body: JSON.stringify({ account_id: config.accountId || 0, name, participants }),
  });
}

export async function updateGroupParticipants(instanceId: number, jid: string, action: string, participants: string[], config: ApiConfig) {
  return bridgeFetch(`/instances/${instanceId}/groups/participants`, {
    method: "POST",
    body: JSON.stringify({ account_id: config.accountId || 0, jid, action, participants }),
  });
}

export async function getContacts(instanceId: number, config: ApiConfig) {
  return bridgeFetch(`/instances/${instanceId}/contacts?account_id=${config.accountId || 0}`, { method: "GET" });
}

export async function getContactInfo(instanceId: number, jid: string, config: ApiConfig) {
  return bridgeFetch(`/instances/${instanceId}/contacts/info`, {
    method: "POST",
    body: JSON.stringify({ account_id: config.accountId || 0, jid }),
  });
}

export async function checkRecipient(instanceId: number, number: string, config: ApiConfig) {
  return bridgeFetch(`/instances/${instanceId}/contacts/check`, {
    method: "POST",
    body: JSON.stringify({ account_id: config.accountId || 0, number }),
  });
}

export async function sendLocation(instanceId: number, jid: string, lat: number, lng: number, name?: string, address?: string, config?: ApiConfig) {
  return bridgeFetch(`/instances/${instanceId}/send-location`, {
    method: "POST",
    body: JSON.stringify({ account_id: config?.accountId || 0, jid, latitude: lat, longitude: lng, name, address }),
  });
}

export async function sendReply(instanceId: number, jid: string, messageId: string, text: string, config?: ApiConfig) {
  return bridgeFetch(`/instances/${instanceId}/send-reply`, {
    method: "POST",
    body: JSON.stringify({ account_id: config?.accountId || 0, jid, message_id: messageId, text }),
  });
}

export async function getMessages(config: ApiConfig) {
  return apiFetch("/api/v1/messages", { method: "GET" }, config);
}

function extractResult(data: any) {
  if (data?.result !== undefined) return data.result;
  if (data?.data !== undefined) return data.data;
  return data;
}

export { extractResult };
