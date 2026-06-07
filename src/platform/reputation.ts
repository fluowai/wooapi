import { get, query, run } from "../db/index.js";

export type ReputationScope = "phone" | "tenant" | "node_ip";

export type ReputationSnapshot = {
  phoneScore: number;
  tenantScore: number;
  nodeIpScore: number;
  effectiveScore: number;
  level: "HEALTHY" | "ATTENTION" | "RISK" | "BLOCKED";
  speedMultiplier: number;
  allowCampaigns: boolean;
  requireCooldown: boolean;
  reasons: string[];
};

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function actionForScore(score: number) {
  if (score >= 90) return { level: "HEALTHY" as const, speedMultiplier: 1, allowCampaigns: true, requireCooldown: false };
  if (score >= 70) return { level: "ATTENTION" as const, speedMultiplier: 0.7, allowCampaigns: true, requireCooldown: false };
  if (score >= 40) return { level: "RISK" as const, speedMultiplier: 0.35, allowCampaigns: false, requireCooldown: true };
  return { level: "BLOCKED" as const, speedMultiplier: 0, allowCampaigns: false, requireCooldown: true };
}

async function scoreFromStored(scope: ReputationScope, subjectId: string) {
  const row = await get(
    "SELECT score FROM reputation_scores WHERE scope = ? AND subject_id = ? ORDER BY updated_at DESC LIMIT 1",
    [scope, subjectId]
  ).catch(() => null);
  return row?.score == null ? null : Number(row.score);
}

async function upsertScore(scope: ReputationScope, subjectId: string, score: number, reasons: string[]) {
  const existing = await get("SELECT id FROM reputation_scores WHERE scope = ? AND subject_id = ?", [scope, subjectId]).catch(() => null);
  const payload = JSON.stringify({ reasons, calculated_at: new Date().toISOString() });
  if (existing) {
    await run(
      "UPDATE reputation_scores SET score = ?, metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [score, payload, existing.id]
    ).catch(() => null);
    return;
  }
  await run(
    "INSERT INTO reputation_scores (scope, subject_id, score, metadata_json) VALUES (?, ?, ?, ?)",
    [scope, subjectId, score, payload]
  ).catch(() => null);
}

async function calculatePhoneScore(instanceId: number) {
  const reasons: string[] = [];
  const metrics = await get(`
    SELECT
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      COUNT(*) AS total
    FROM message_logs
    WHERE instance_id = ? AND created_at >= datetime('now','-24 hours')
  `, [instanceId]).catch(() => ({ failed: 0, total: 0 })) as any;
  const inst = await get("SELECT created_at, disconnection_count_24h, message_failed_count_24h FROM instances WHERE id = ?", [instanceId]).catch(() => null) as any;
  const total = Number(metrics?.total || 0);
  const failed = Number(metrics?.failed || inst?.message_failed_count_24h || 0);
  let score = 100;
  if (total > 0) {
    const failureRate = failed / total;
    score -= failureRate * 45;
    if (failureRate > 0.1) reasons.push("failure_rate_high");
  }
  const disconnections = Number(inst?.disconnection_count_24h || 0);
  if (disconnections > 2) {
    score -= Math.min(disconnections * 6, 24);
    reasons.push("connection_churn");
  }
  if (inst?.created_at) {
    const ageHours = (Date.now() - new Date(inst.created_at).getTime()) / 3600000;
    if (ageHours < 24 && total > 20) {
      score -= 20;
      reasons.push("new_instance_volume");
    }
  }
  return { score: clampScore(score), reasons };
}

async function calculateTenantScore(accountId: number) {
  const reasons: string[] = [];
  const metrics = await get(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM message_logs
    WHERE account_id = ? AND created_at >= datetime('now','-24 hours')
  `, [accountId]).catch(() => ({ total: 0, failed: 0 })) as any;
  const alerts = await get(
    "SELECT COUNT(*) AS total FROM support_alerts WHERE account_id = ? AND status = 'open'",
    [accountId]
  ).catch(() => ({ total: 0 })) as any;
  const total = Number(metrics?.total || 0);
  const failed = Number(metrics?.failed || 0);
  let score = 100;
  if (total > 0) {
    const failureRate = failed / total;
    score -= failureRate * 35;
    if (failureRate > 0.08) reasons.push("tenant_failure_rate");
  }
  if (Number(alerts?.total || 0) > 0) {
    score -= Math.min(Number(alerts.total) * 5, 25);
    reasons.push("open_alerts");
  }
  return { score: clampScore(score), reasons };
}

async function calculateNodeIpScore(nodeId?: string | null, ipPoolId?: string | null) {
  const subject = nodeId || ipPoolId || "default";
  const reasons: string[] = [];
  const node = await get("SELECT status, cpu_percent, memory_percent, error_rate FROM core_nodes WHERE id = ?", [subject]).catch(() => null) as any;
  let score = 100;
  if (node) {
    if (!["ACTIVE", "DEGRADED"].includes(String(node.status || "ACTIVE"))) {
      score -= 35;
      reasons.push("node_not_active");
    }
    if (Number(node.cpu_percent || 0) > 80) {
      score -= 15;
      reasons.push("node_cpu_high");
    }
    if (Number(node.memory_percent || 0) > 85) {
      score -= 15;
      reasons.push("node_memory_high");
    }
    if (Number(node.error_rate || 0) > 0.05) {
      score -= 25;
      reasons.push("node_error_rate");
    }
  }
  return { score: clampScore(score), reasons, subject };
}

export async function getReputationSnapshot(input: {
  accountId: number;
  instanceId: number;
  phoneId?: string;
  nodeId?: string | null;
  ipPoolId?: string | null;
}): Promise<ReputationSnapshot> {
  const phoneSubject = input.phoneId || `instance:${input.instanceId}`;
  const tenantSubject = `tenant:${input.accountId}`;
  const phoneStored = await scoreFromStored("phone", phoneSubject);
  const tenantStored = await scoreFromStored("tenant", tenantSubject);
  const nodeIp = await calculateNodeIpScore(input.nodeId, input.ipPoolId);
  const phone = phoneStored == null ? await calculatePhoneScore(input.instanceId) : { score: phoneStored, reasons: [] };
  const tenant = tenantStored == null ? await calculateTenantScore(input.accountId) : { score: tenantStored, reasons: [] };
  const effectiveScore = clampScore(Math.min(phone.score, tenant.score, nodeIp.score));
  const action = actionForScore(effectiveScore);
  const reasons = [...phone.reasons, ...tenant.reasons, ...nodeIp.reasons];

  await upsertScore("phone", phoneSubject, phone.score, phone.reasons);
  await upsertScore("tenant", tenantSubject, tenant.score, tenant.reasons);
  await upsertScore("node_ip", nodeIp.subject, nodeIp.score, nodeIp.reasons);

  return {
    phoneScore: clampScore(phone.score),
    tenantScore: clampScore(tenant.score),
    nodeIpScore: clampScore(nodeIp.score),
    effectiveScore,
    ...action,
    reasons
  };
}

export async function listReputation(scope?: ReputationScope) {
  if (scope) {
    return query("SELECT * FROM reputation_scores WHERE scope = ? ORDER BY score ASC, updated_at DESC LIMIT 200", [scope]);
  }
  return query("SELECT * FROM reputation_scores ORDER BY score ASC, updated_at DESC LIMIT 200");
}
