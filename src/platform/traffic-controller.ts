import { get, run } from "../db/index.js";
import { getReputationSnapshot } from "./reputation.js";
import { normalizeInstanceState } from "./state-machine.js";

export type TrafficDecision =
  | { decision: "ALLOW"; reason: "OK"; delayMs: 0; reputation: Awaited<ReturnType<typeof getReputationSnapshot>> }
  | { decision: "DELAY"; reason: string; delayMs: number; reputation?: Awaited<ReturnType<typeof getReputationSnapshot>> }
  | { decision: "REJECT_TEMPORARY" | "REJECT_PERMANENT" | "PAUSE_INSTANCE"; reason: string; delayMs: 0; reputation?: Awaited<ReturnType<typeof getReputationSnapshot>> };

type Limit = {
  windowSeconds: number;
  max: number;
};

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function jitter(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min));
}

function limitFor(key: string, base: number, multiplier: number): Limit {
  const max = Math.max(1, Math.floor(base * multiplier));
  return { windowSeconds: 60, max };
}

async function consumeBucket(bucketKey: string, limit: Limit) {
  const existing = await get("SELECT id, count, reset_at FROM traffic_buckets WHERE bucket_key = ?", [bucketKey]).catch(() => null) as any;
  const now = Date.now();
  const resetAt = existing?.reset_at ? new Date(existing.reset_at).getTime() : 0;
  if (!existing || resetAt <= now) {
    const nextReset = new Date(now + limit.windowSeconds * 1000).toISOString();
    if (existing) {
      await run("UPDATE traffic_buckets SET count = 1, reset_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [nextReset, existing.id]).catch(() => null);
    } else {
      await run("INSERT INTO traffic_buckets (bucket_key, count, reset_at) VALUES (?, ?, ?)", [bucketKey, 1, nextReset]).catch(() => null);
    }
    return { allowed: true, retryAfterMs: 0 };
  }
  const count = Number(existing.count || 0);
  if (count >= limit.max) {
    return { allowed: false, retryAfterMs: Math.max(1000, resetAt - now) };
  }
  await run("UPDATE traffic_buckets SET count = count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [existing.id]).catch(() => null);
  return { allowed: true, retryAfterMs: 0 };
}

async function logDecision(input: any, output: Omit<TrafficDecision, "reputation"> & { score?: number }) {
  await run(
    "INSERT INTO traffic_decisions (account_id, instance_id, node_id, decision, reason, delay_ms, score, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      input.accountId,
      input.instanceId,
      input.nodeId || null,
      output.decision,
      output.reason,
      output.delayMs || 0,
      output.score ?? null,
      JSON.stringify({ messageType: input.messageType, campaignId: input.campaignId || null })
    ]
  ).catch(() => null);
}

export async function canSendMessage(input: {
  accountId: number;
  instanceId: number;
  phoneId?: string;
  jid?: string;
  nodeId?: string | null;
  ipPoolId?: string | null;
  messageType?: string;
  campaignId?: number | null;
  priority?: number;
}): Promise<TrafficDecision> {
  const inst = await get(
    "SELECT id, account_id, status, connection_status, assigned_node_id, ip_pool_id FROM instances WHERE id = ? AND account_id = ? AND deleted_at IS NULL",
    [input.instanceId, input.accountId]
  ).catch(() => null) as any;

  if (!inst) {
    const output = { decision: "REJECT_PERMANENT" as const, reason: "INSTANCE_NOT_FOUND", delayMs: 0 as const };
    await logDecision(input, output);
    return output;
  }

  const state = normalizeInstanceState(inst.connection_status || inst.status);
  if (state !== "ACTIVE") {
    const output = { decision: "DELAY" as const, reason: `INSTANCE_${state}`, delayMs: jitter(30000, 90000) };
    await logDecision(input, output);
    return output;
  }

  const reputation = await getReputationSnapshot({
    accountId: input.accountId,
    instanceId: input.instanceId,
    phoneId: input.phoneId || input.jid || `instance:${input.instanceId}`,
    nodeId: input.nodeId || inst.assigned_node_id,
    ipPoolId: input.ipPoolId || inst.ip_pool_id
  });

  if (reputation.effectiveScore < 40) {
    await run(
      "UPDATE instances SET status = ?, connection_status = ?, risk_score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      ["blocked", "blocked", reputation.effectiveScore, input.instanceId]
    ).catch(() => null);
    const output = { decision: "PAUSE_INSTANCE" as const, reason: "REPUTATION_BLOCKED", delayMs: 0 as const, reputation };
    await logDecision(input, { ...output, score: reputation.effectiveScore });
    return output;
  }

  if (input.campaignId && !reputation.allowCampaigns) {
    const output = { decision: "REJECT_TEMPORARY" as const, reason: "CAMPAIGN_RISK_PAUSED", delayMs: 0 as const, reputation };
    await logDecision(input, { ...output, score: reputation.effectiveScore });
    return output;
  }

  const multiplier = reputation.speedMultiplier;
  const checks = await Promise.all([
    consumeBucket("global:messages", limitFor("global", envNumber("TRAFFIC_GLOBAL_PER_MINUTE", 600), multiplier)),
    consumeBucket(`tenant:${input.accountId}:messages`, limitFor("tenant", envNumber("TRAFFIC_TENANT_PER_MINUTE", 120), multiplier)),
    consumeBucket(`instance:${input.instanceId}:messages`, limitFor("instance", envNumber("TRAFFIC_INSTANCE_PER_MINUTE", 20), multiplier)),
    consumeBucket(`phone:${input.phoneId || input.jid || input.instanceId}:messages`, limitFor("phone", envNumber("TRAFFIC_PHONE_PER_MINUTE", 12), multiplier)),
    consumeBucket(`node:${input.nodeId || inst.assigned_node_id || "default"}:messages`, limitFor("node", envNumber("TRAFFIC_NODE_PER_MINUTE", 300), multiplier))
  ]);

  const blocked = checks.filter((check) => !check.allowed);
  if (blocked.length) {
    const retryAfter = Math.max(...blocked.map((check) => check.retryAfterMs));
    const output = { decision: "DELAY" as const, reason: "RATE_LIMIT", delayMs: retryAfter + jitter(500, 5000), reputation };
    await logDecision(input, { ...output, score: reputation.effectiveScore });
    return output;
  }

  const pacing = Math.max(0, Math.floor(jitter(700, 3500) / Math.max(multiplier, 0.2)));
  if (pacing > 2500 && Number(input.priority || 2) > 1) {
    const output = { decision: "DELAY" as const, reason: "PACED_SEND", delayMs: pacing, reputation };
    await logDecision(input, { ...output, score: reputation.effectiveScore });
    return output;
  }

  const output = { decision: "ALLOW" as const, reason: "OK" as const, delayMs: 0 as const, reputation };
  await logDecision(input, { ...output, score: reputation.effectiveScore });
  return output;
}
