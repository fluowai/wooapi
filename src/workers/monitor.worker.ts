import { query, get, run } from "../db/index.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { redisConnection } from "../queues/redis.connection";
import { supportAlertsQueue } from "../queues/queues";

dotenv.config();

const dataDir = path.resolve(process.env.DATA_DIR || ".");
fs.mkdirSync(dataDir, { recursive: true });


const MONITOR_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS || 60000);
const OFFLINE_CRITICAL_MINUTES = Number(process.env.MONITOR_OFFLINE_CRITICAL_MINUTES || 5);
const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:3001";
const WOZAPI_V2_BRIDGE_URL = process.env.WOZAPI_V2_BRIDGE_URL || process.env.WOZAPI_V2_INTERNAL_BRIDGE_URL || "http://127.0.0.1:3003";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const RECONNECT_COOLDOWN_MS = Number(process.env.MONITOR_RECONNECT_COOLDOWN_MS || 300000); // 5 min cooldown
const QR_EXPIRES_MINUTES = Number(process.env.QR_EXPIRES_MINUTES || 10);
const ORPHAN_SESSION_GRACE_MINUTES = Number(process.env.ORPHAN_SESSION_GRACE_MINUTES || 30);

async function bridgeFetch(pathname: string, options: any = {}) {
  const match = String(pathname || "").match(/^\/instances\/(\d+)(?:\/|$)/);
  const instance = match ? await get("SELECT engine FROM instances WHERE id = ?", [Number(match[1])]).catch(() => null) : null;
  const engine = String(instance?.engine || "").toLowerCase();
  const baseURL = ["wozapi-2", "wozapi2", "v2", "2", "2.0"].includes(engine) ? WOZAPI_V2_BRIDGE_URL : BRIDGE_URL;
  const url = `${baseURL}${pathname}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(BRIDGE_TOKEN ? { "X-Bridge-Token": BRIDGE_TOKEN } : {}),
    ...options.headers,
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}







function isConnectedStatus(status: string) {
  return ["open", "connected"].includes(status);
}

function publicInstanceStatus(status: string | null | undefined) {
  const s = String(status || "");
  if (["open", "connected"].includes(s)) return "connected";
  if (["qr", "qr_pending"].includes(s)) return "qr_pending";
  if (["connecting", "reconnecting"].includes(s)) return "connecting";
  if (s === "close" || s === "none" || s === "disconnected") return "disconnected";
  if (s === "logged_out") return "logged_out";
  return "unknown";
}

async function checkInstanceHealth() {
  const instances = await query("SELECT id, account_id, name, status, connection_status, connected_at, disconnected_at, last_seen_at, last_qr_at, jid, engine FROM instances WHERE deleted_at IS NULL");
  const now = new Date();
  const since24h = "datetime('now','-24 hours')";

  for (const inst of instances) {
    try {
      const status = publicInstanceStatus(inst.connection_status || inst.status);
      const connected = isConnectedStatus(inst.connection_status || inst.status);

      const disconnections24h = (await get(
        `SELECT COUNT(*) AS total FROM connection_logs WHERE instance_id = ? AND event = 'connection.update' AND created_at >= ${since24h}`,
        [inst.id]
      ))?.total || 0;

      const messages24h = (await get(
        `SELECT COUNT(*) AS total FROM message_logs WHERE instance_id = ? AND created_at >= ${since24h}`,
        [inst.id]
      ))?.total || 0;

      const failures24h = (await get(
        `SELECT COUNT(*) AS total FROM message_logs WHERE instance_id = ? AND status = 'failed' AND created_at >= ${since24h}`,
        [inst.id]
      ))?.total || 0;

      const webhookFailures24h = (await get(
        `SELECT COUNT(*) AS total FROM webhook_delivery_logs WHERE instance_id = ? AND success = 0 AND created_at >= ${since24h}`,
        [inst.id]
      ))?.total || 0;

      const avgLatency = (await get(
        `SELECT AVG(duration_ms) AS avg FROM webhook_delivery_logs WHERE instance_id = ? AND success = 1 AND created_at >= ${since24h}`,
        [inst.id]
      ))?.avg || 0;

      const uptimeSeconds = connected && inst.connected_at
        ? Math.floor((now.getTime() - new Date(inst.connected_at).getTime()) / 1000)
        : 0;

      let operationalStatus = "healthy";
      let lastError: string | null = null;

      if (connected) {
        if (Number(failures24h) > 0 || Number(webhookFailures24h) > 0) {
          operationalStatus = "degraded";
        }
      } else if (status === "qr_pending" || status === "connecting") {
        operationalStatus = "unstable";
      } else if (status === "disconnected" || status === "logged_out") {
        operationalStatus = "offline";
        if (inst.disconnected_at) {
          const offlineMinutes = (now.getTime() - new Date(inst.disconnected_at).getTime()) / 60000;
          if (offlineMinutes > OFFLINE_CRITICAL_MINUTES) {
            operationalStatus = "critical";
            lastError = `Offline ha ${Math.floor(offlineMinutes)} minutos`;
          }
        }
      }

      await run(
        `UPDATE instances SET
          last_event_at = CURRENT_TIMESTAMP,
          connection_uptime_seconds = ?,
          disconnection_count_24h = ?,
          message_sent_count_24h = ?,
          message_failed_count_24h = ?,
          avg_send_latency_ms = ?,
          last_error = ?,
          operational_status = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [
          uptimeSeconds,
          Number(disconnections24h),
          Number(messages24h),
          Number(failures24h),
          Math.round(Number(avgLatency)),
          lastError,
          operationalStatus,
          inst.id
        ]
      );

      if (!connected && inst.disconnected_at) {
        const offlineMinutes = (now.getTime() - new Date(inst.disconnected_at).getTime()) / 60000;
        if (offlineMinutes > OFFLINE_CRITICAL_MINUTES) {
          const existingAlert = await get(
            "SELECT id FROM support_alerts WHERE instance_id = ? AND type = 'instance_offline_too_long' AND status = 'open'",
            [inst.id]
          );
          if (!existingAlert) {
            supportAlertsQueue.add("instance-offline", {
              accountId: inst.account_id,
              instanceId: inst.id,
              severity: "critical",
              type: "instance_offline_too_long",
              title: `Instancia offline prolongada`,
              description: `A instancia ${inst.name} esta offline ha ${Math.floor(offlineMinutes)} minutos.`
            }, { attempts: 1 }).catch(() => null);
          }
        }
      }

      if (status === "qr_pending" && inst.last_qr_at) {
        const qrAgeMinutes = (now.getTime() - new Date(inst.last_qr_at).getTime()) / 60000;
        if (qrAgeMinutes > QR_EXPIRES_MINUTES) {
          const existingAlert = await get(
            "SELECT id FROM support_alerts WHERE instance_id = ? AND type = 'qr_expired' AND status = 'open'",
            [inst.id]
          );
          if (!existingAlert) {
            supportAlertsQueue.add("qr-expired", {
              accountId: inst.account_id,
              instanceId: inst.id,
              severity: "warning",
              type: "qr_expired",
              title: "QR Code expirado",
              description: `A instancia ${inst.name} esta aguardando QR ha ${Math.floor(qrAgeMinutes)} minutos. Gere um novo QR.`
            }, { attempts: 1 }).catch(() => null);
          }
          await run(
            "UPDATE instances SET status = ?, connection_status = ?, qr = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND connection_status IN ('qr_pending','qr','connecting')",
            ["qr_expired", "qr_expired", inst.id]
          );
          await bridgeFetch(`/instances/${inst.id}/logout`, { method: "POST" }).catch(() => null);
        }
      }

      const updatedAt = inst.last_seen_at || inst.connected_at || inst.disconnected_at;
      if (!inst.jid && ["connecting", "qr_pending"].includes(status) && updatedAt) {
        const orphanAgeMinutes = (now.getTime() - new Date(updatedAt).getTime()) / 60000;
        if (orphanAgeMinutes > ORPHAN_SESSION_GRACE_MINUTES) {
          await bridgeFetch(`/instances/${inst.id}/logout`, { method: "POST" }).catch(() => null);
          await run(
            "UPDATE instances SET status = ?, connection_status = ?, qr = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            ["disconnected", "disconnected", inst.id]
          );
        }
      }

      if (!connected && inst.jid && !["qr_pending", "connecting", "qr_expired"].includes(status)) {
        const lastReconnect = await get(
          "SELECT created_at FROM connection_logs WHERE instance_id = ? AND event = 'auto_reconnect' ORDER BY created_at DESC LIMIT 1",
          [inst.id]
        ) as any;
        const lastReconnectTime = lastReconnect ? new Date(lastReconnect.created_at).getTime() : 0;
        const timeSinceLastReconnect = now.getTime() - lastReconnectTime;

        if (timeSinceLastReconnect > RECONNECT_COOLDOWN_MS) {
          console.log(`[WOOAPI_MONITOR] Auto-reconnecting instance ${inst.id} (${inst.name})`);
          try {
            await run(
              "INSERT INTO connection_logs (account_id, instance_id, event, status, details_json) VALUES (?, ?, 'auto_reconnect', 'attempting', ?)",
              [inst.account_id, inst.id, JSON.stringify({ trigger: "monitor_offline" })]
            );
            await run(
              "UPDATE instances SET status = ?, connection_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
              ["connecting", "reconnecting", inst.id]
            );
            await bridgeFetch(`/instances/${inst.id}/connect`, {
              method: "POST",
              body: JSON.stringify({ account_id: inst.account_id, jid: inst.jid || "" })
            });
            console.log(`[WOOAPI_MONITOR] Reconnect triggered for instance ${inst.id}`);
          } catch (error) {
            console.error(`[WOOAPI_MONITOR] Reconnect failed for instance ${inst.id}:`, error);
          }
        }
      }
    } catch (error) {
      console.error(`[WOOAPI_MONITOR] Error checking instance ${inst.id}:`, error);
    }
  }

  const pendingJobs = (await get("SELECT COUNT(*) AS total FROM webhook_events WHERE status IN ('pending', 'retrying')"))?.total || 0;
  if (Number(pendingJobs) > 1000) {
    const existingAlert = await get("SELECT id FROM support_alerts WHERE type = 'queue_backlog_high' AND status = 'open'");
    if (!existingAlert) {
      supportAlertsQueue.add("queue-backlog", {
        severity: "critical",
        type: "queue_backlog_high",
        title: "Fila com backlog alto",
        description: `${pendingJobs} jobs pendentes/retry nas filas.`
      }, { attempts: 1 }).catch(() => null);
    }
  }
}

async function runMonitor() {
  console.log(`[WOOAPI_MONITOR] Running health check at ${new Date().toISOString()}`);
  try {
    await checkInstanceHealth();
  } catch (error) {
    console.error("[WOOAPI_MONITOR] Error:", error);
  }
}

runMonitor().then(() => {
  setInterval(runMonitor, MONITOR_INTERVAL_MS);
  console.log(`[WOOAPI_MONITOR] Started, interval: ${MONITOR_INTERVAL_MS}ms`);
});

async function shutdown() {
  // db.close();
}

process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));
