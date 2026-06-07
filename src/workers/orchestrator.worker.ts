import dotenv from "dotenv";
import os from "os";
import { query, run } from "../db/index.js";
import { assignInstance, registerCoreNode, refreshCoreNodeCounts, transitionInstance } from "../platform/orchestrator.js";
import { getReputationSnapshot } from "../platform/reputation.js";

dotenv.config();

const INTERVAL_MS = Number(process.env.ORCHESTRATOR_INTERVAL_MS || 30000);
const CORE_NODE_ID = process.env.CORE_NODE_ID || "core-node-local";

async function heartbeat() {
  const load = os.loadavg()[0] || 0;
  const cpuPercent = Math.min(100, Math.round((load / Math.max(1, os.cpus().length)) * 100));
  const total = os.totalmem();
  const free = os.freemem();
  const memoryPercent = total ? Math.round(((total - free) / total) * 100) : 0;
  await registerCoreNode({
    id: CORE_NODE_ID,
    region: process.env.WOOAPI_REGION || "br-south",
    profile: (process.env.CORE_NODE_PROFILE as any) || "low-risk",
    ipPoolId: process.env.CORE_NODE_IP_POOL || "local",
    maxInstances: Number(process.env.CORE_NODE_MAX_INSTANCES || 150),
    cpuPercent,
    memoryPercent,
    errorRate: 0,
    status: cpuPercent > 90 || memoryPercent > 92 ? "DEGRADED" : "ACTIVE"
  });
}

async function reconcileInstances() {
  const instances = await query(`
    SELECT id, account_id, assigned_node_id, status, connection_status, phone, phone_connected
    FROM instances
    WHERE deleted_at IS NULL
    ORDER BY updated_at DESC
    LIMIT 500
  `);

  for (const inst of instances as any[]) {
    if (!inst.assigned_node_id) {
      await assignInstance(Number(inst.id), Number(inst.account_id)).catch((error) => {
        console.error(`[WOOAPI_ORCHESTRATOR] assign failed for instance ${inst.id}:`, error?.message || error);
      });
    }

    const reputation = await getReputationSnapshot({
      accountId: Number(inst.account_id),
      instanceId: Number(inst.id),
      phoneId: inst.phone_connected || inst.phone || `instance:${inst.id}`,
      nodeId: inst.assigned_node_id
    }).catch(() => null);

    if (reputation) {
      await run("UPDATE instances SET risk_score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [reputation.effectiveScore, inst.id]).catch(() => null);
      if (reputation.effectiveScore < 40) {
        await transitionInstance(Number(inst.id), Number(inst.account_id), "risk_critical", { reputation }).catch(() => null);
      } else if (reputation.effectiveScore < 70 && ["connected", "open", "active"].includes(String(inst.connection_status || inst.status))) {
        await transitionInstance(Number(inst.id), Number(inst.account_id), "risk_elevated", { reputation }).catch(() => null);
      }
    }
  }

  await refreshCoreNodeCounts();
}

async function runOrchestrator() {
  console.log(`[WOOAPI_ORCHESTRATOR] reconcile at ${new Date().toISOString()}`);
  await heartbeat();
  await reconcileInstances();
}

runOrchestrator().then(() => {
  setInterval(() => {
    runOrchestrator().catch((error) => console.error("[WOOAPI_ORCHESTRATOR] error:", error?.message || error));
  }, INTERVAL_MS);
  console.log(`[WOOAPI_ORCHESTRATOR] started, interval: ${INTERVAL_MS}ms`);
});

process.once("SIGINT", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
