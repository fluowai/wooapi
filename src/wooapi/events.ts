import crypto from "crypto";

export const WOOAPI_EVENT_NAMES = [
  "message.received",
  "message.sent",
  "message.delivered",
  "message.read",
  "message.failed",
  "message.deleted",
  "instance.qr",
  "instance.connected",
  "instance.disconnected",
  "instance.reconnecting",
  "instance.logged_out",
  "instance.connection_lost",
  "instance.health_checked",
  "media.received",
  "media.uploaded",
  "media.failed",
  "group.message.received",
  "group.participant.added",
  "group.participant.removed",
  "webhook.sent",
  "webhook.failed",
  "webhook.retrying",
  "webhook.disabled",
  "system.degraded",
  "system.outage",
  "system.recovered"
] as const;

const blockedKeys = new Set([
  "engine",
  "library",
  "internal_engine",
  "internalEngine",
  "provider_engine",
  "providerEngine",
  "bridge_token",
  "bridgeToken",
  "stack",
  "trace"
]);

const blockedText = /(whatsmeow|baileys|go\.mau\.fi|waSocket|MessageSource)/ig;

function safeId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

export function sanitizeWooApiPayload(value: any): any {
  if (Array.isArray(value)) return value.map((item) => sanitizeWooApiPayload(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !blockedKeys.has(key))
        .map(([key, item]) => [key, sanitizeWooApiPayload(item)])
    );
  }
  if (typeof value === "string") return value.replace(blockedText, "WooAPI Core");
  return value;
}

export function createWooApiEvent(input: {
  event: string;
  tenantId: string | number;
  instanceId: string | number;
  data?: any;
  eventId?: string;
  timestamp?: string;
}) {
  return {
    event_id: input.eventId || safeId("evt"),
    event: input.event,
    tenant_id: String(input.tenantId),
    instance_id: String(input.instanceId),
    timestamp: input.timestamp || new Date().toISOString(),
    source: "wooapi",
    data: sanitizeWooApiPayload(input.data || {})
  };
}
