import { get, query, run } from "../db/index.js";
import { getReputationSnapshot } from "./reputation.js";
import { publicStatusFromState, transitionInstanceState, normalizeInstanceState, type InstanceStateTrigger } from "./state-machine.js";

export type CoreNodeProfile = "low-risk" | "high-volume" | "risky";

function numberOr(value: any, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function classifyProfile(input: { tenant?: any; reputationScore: number }): CoreNodeProfile {
  if (input.reputationScore < 70) return "risky";
  if (numberOr(input.tenant?.instance_quota || input.tenant?.max_instances, 0) >= 20) return "high-volume";
  return "low-risk";
}

function scoreNode(node: any, profile: CoreNodeProfile, reputationScore: number) {
  if (String(node.status || "ACTIVE") !== "ACTIVE") return -1;
  if (Number(node.drain_mode || 0) === 1) return -1;
  if (numberOr(node.active_instances, 0) >= numberOr(node.max_instances, 100)) return -1;
  let score = 100;
  if (node.profile && node.profile !== profile) score -= 25;
  if (numberOr(node.cpu_percent, 0) > 80) score -= 30;
  if (numberOr(node.memory_percent, 0) > 85) score -= 30;
  if (numberOr(node.error_rate, 0) > 0.05) score -= 25;
  if (reputationScore < 70 && node.profile === "low-risk") score -= 35;
  score -= (numberOr(node.active_instances, 0) / Math.max(1, numberOr(node.max_instances, 100))) * 30;
  return score;
}

export async function registerCoreNode(input: {
  id: string;
  region?: string;
  profile?: CoreNodeProfile;
  ipPoolId?: string;
  maxInstances?: number;
  cpuPercent?: number;
  memoryPercent?: number;
  errorRate?: number;
  status?: string;
}) {
  const existing = await get("SELECT id FROM core_nodes WHERE id = ?", [input.id]).catch(() => null);
  const values = [
    input.region || process.env.WOOAPI_REGION || "br-south",
    input.profile || "low-risk",
    input.ipPoolId || "default",
    input.status || "ACTIVE",
    numberOr(input.maxInstances, numberOr(process.env.CORE_NODE_MAX_INSTANCES, 150)),
    numberOr(input.cpuPercent, 0),
    numberOr(input.memoryPercent, 0),
    numberOr(input.errorRate, 0),
    input.id
  ];
  if (existing) {
    await run(
      "UPDATE core_nodes SET region = ?, profile = ?, ip_pool_id = ?, status = ?, max_instances = ?, cpu_percent = ?, memory_percent = ?, error_rate = ?, last_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      values
    );
  } else {
    await run(
      "INSERT INTO core_nodes (region, profile, ip_pool_id, status, max_instances, cpu_percent, memory_percent, error_rate, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      values
    );
  }
  return get("SELECT * FROM core_nodes WHERE id = ?", [input.id]);
}

export async function assignInstance(instanceId: number, accountId: number) {
  const inst = await get("SELECT * FROM instances WHERE id = ? AND account_id = ? AND deleted_at IS NULL", [instanceId, accountId]) as any;
  if (!inst) throw new Error("INSTANCE_NOT_FOUND");
  const tenant = await get("SELECT * FROM accounts WHERE id = ?", [accountId]).catch(() => null);
  const currentReputation = await getReputationSnapshot({ accountId, instanceId, phoneId: inst.phone_connected || inst.phone || `instance:${instanceId}` });
  const profile = classifyProfile({ tenant, reputationScore: currentReputation.effectiveScore });
  const nodes = await query("SELECT * FROM core_nodes WHERE status IN ('ACTIVE','DEGRADED') ORDER BY updated_at DESC LIMIT 200").catch(() => []) as any[];
  if (!nodes.length) {
    await registerCoreNode({ id: process.env.CORE_NODE_ID || "core-node-local", profile, ipPoolId: "local" });
  }
  const candidates = await query("SELECT * FROM core_nodes WHERE status IN ('ACTIVE','DEGRADED') ORDER BY updated_at DESC LIMIT 200") as any[];
  const ranked = candidates
    .map((node) => ({ node, score: scoreNode(node, profile, currentReputation.effectiveScore) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score);
  const selected = ranked[0]?.node;
  if (!selected) throw new Error("NO_CAPACITY_AVAILABLE");

  await run(
    "UPDATE instances SET assigned_node_id = ?, ip_pool_id = ?, risk_profile = ?, risk_score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [selected.id, selected.ip_pool_id || "default", profile, currentReputation.effectiveScore, instanceId]
  );
  await run(
    "INSERT INTO instance_assignments (account_id, instance_id, node_id, ip_pool_id, profile, reason) VALUES (?, ?, ?, ?, ?, ?)",
    [accountId, instanceId, selected.id, selected.ip_pool_id || "default", profile, "orchestrator.assign"]
  ).catch(() => null);
  await refreshCoreNodeCounts();
  return { node: selected, profile, reputation: currentReputation };
}

export async function transitionInstance(instanceId: number, accountId: number, trigger: InstanceStateTrigger, details: any = {}) {
  const inst = await get("SELECT status, connection_status FROM instances WHERE id = ? AND account_id = ?", [instanceId, accountId]) as any;
  if (!inst) throw new Error("INSTANCE_NOT_FOUND");
  const current = normalizeInstanceState(inst.connection_status || inst.status);
  const transition = transitionInstanceState(current, trigger);
  if (!transition.allowed) return transition;
  const publicStatus = publicStatusFromState(transition.next);
  await run(
    "UPDATE instances SET status = ?, connection_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ?",
    [publicStatus, publicStatus, instanceId, accountId]
  );
  await run(
    "INSERT INTO instance_state_events (account_id, instance_id, from_state, to_state, trigger, metadata_json) VALUES (?, ?, ?, ?, ?, ?)",
    [accountId, instanceId, current, transition.next, trigger, JSON.stringify(details)]
  ).catch(() => null);
  return transition;
}

export async function setCoreNodeDrainMode(nodeId: string, enabled: boolean) {
  await run(
    "UPDATE core_nodes SET drain_mode = ?, status = CASE WHEN ? = 1 THEN 'DRAINING' ELSE 'ACTIVE' END, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [enabled ? 1 : 0, enabled ? 1 : 0, nodeId]
  );
  return get("SELECT * FROM core_nodes WHERE id = ?", [nodeId]);
}

export async function refreshCoreNodeCounts() {
  const nodes = await query("SELECT id FROM core_nodes").catch(() => []) as any[];
  for (const node of nodes) {
    const count = await get("SELECT COUNT(*) AS total FROM instances WHERE assigned_node_id = ? AND deleted_at IS NULL", [node.id]).catch(() => ({ total: 0 })) as any;
    await run("UPDATE core_nodes SET active_instances = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [Number(count?.total || 0), node.id]).catch(() => null);
  }
}
