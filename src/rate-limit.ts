import { get } from "./db/index.js";

const buckets = new Map<string, { count: number; resetAt: number }>();

const CLEANUP_INTERVAL = 60_000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    buckets.forEach((bucket, key) => {
      if (bucket.resetAt <= now) buckets.delete(key);
    });
  }, CLEANUP_INTERVAL);
}

export function resetRateLimits(): void {
  buckets.clear();
}

function limitFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function check(label: string, keySuffix: string, limit: number, windowMs: number): boolean {
  ensureCleanup();
  const key = `${label}:${keySuffix}`;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

async function getPlanLimitsForApiKey(apiKey: string) {
  if (!apiKey) return null;
  try {
    return await get(`
      SELECT instances.id AS instance_id,
             instances.account_id,
             COALESCE(plans.api_rate_limit_per_minute, ?) AS api_rate_limit_per_minute,
             COALESCE(plans.instance_rate_limit_per_minute, ?) AS instance_rate_limit_per_minute,
             COALESCE(plans.message_rate_limit_per_minute, ?) AS message_rate_limit_per_minute
      FROM instances
      LEFT JOIN accounts ON accounts.id = instances.account_id
      LEFT JOIN plans ON plans.id = accounts.plan_id
      WHERE instances.api_key = ? AND instances.deleted_at IS NULL
      LIMIT 1
    `, [
      limitFromEnv("DEFAULT_API_RATE_LIMIT_PER_MINUTE", 60),
      limitFromEnv("DEFAULT_INSTANCE_RATE_LIMIT_PER_MINUTE", 30),
      limitFromEnv("DEFAULT_MESSAGE_RATE_LIMIT_PER_MINUTE", 20),
      apiKey
    ]);
  } catch {
    return null;
  }
}

async function getPlanLimitsForInstance(instanceId: string | number) {
  if (!instanceId) return null;
  try {
    return await get(`
      SELECT instances.id AS instance_id,
             instances.account_id,
             COALESCE(plans.api_rate_limit_per_minute, ?) AS api_rate_limit_per_minute,
             COALESCE(plans.instance_rate_limit_per_minute, ?) AS instance_rate_limit_per_minute,
             COALESCE(plans.message_rate_limit_per_minute, ?) AS message_rate_limit_per_minute
      FROM instances
      LEFT JOIN accounts ON accounts.id = instances.account_id
      LEFT JOIN plans ON plans.id = accounts.plan_id
      WHERE instances.id = ? AND instances.deleted_at IS NULL
      LIMIT 1
    `, [
      limitFromEnv("DEFAULT_API_RATE_LIMIT_PER_MINUTE", 60),
      limitFromEnv("DEFAULT_INSTANCE_RATE_LIMIT_PER_MINUTE", 30),
      limitFromEnv("DEFAULT_MESSAGE_RATE_LIMIT_PER_MINUTE", 20),
      instanceId
    ]);
  } catch {
    return null;
  }
}

export function buildRateKey(req: { ip?: string; headers?: any; query?: any }): string {
  return `${req.ip || "unknown"}:${String(req.headers?.["x-api-key"] || req.headers?.token || "")}`;
}

export function globalRateLimit(req: any, res: any, next: any) {
  const limit = limitFromEnv("DEFAULT_GLOBAL_RATE_LIMIT_PER_MINUTE", 120);
  if (!check("global", buildRateKey(req), limit, 60_000)) {
    return res.status(429).json({ error: "Too many requests. Try again shortly." });
  }
  next();
}

export function loginRateLimit(req: any, res: any, next: any) {
  const limit = limitFromEnv("DEFAULT_LOGIN_RATE_LIMIT_PER_MINUTE", 10);
  if (!check("login", req.ip || "unknown", limit, 60_000)) {
    return res.status(429).json({ error: "Too many login attempts. Try again shortly." });
  }
  next();
}

export async function apiKeyRateLimit(req: any, res: any, next: any) {
  const apiKey = String(req.headers["x-api-key"] || req.headers.token || "").trim();
  const planLimits: any = apiKey ? await getPlanLimitsForApiKey(apiKey) : null;
  const limit = Number(planLimits?.api_rate_limit_per_minute || limitFromEnv("DEFAULT_API_RATE_LIMIT_PER_MINUTE", 60));
  if (apiKey && !check("apikey", apiKey, limit, 60_000)) {
    return res.status(429).json({ error: "API key rate limit exceeded.", limit });
  }
  next();
}

export async function accountRateLimit(req: any, res: any, next: any) {
  const accountId = req.accountId || req.body?.account_id;
  const limit = limitFromEnv("DEFAULT_ACCOUNT_RATE_LIMIT_PER_MINUTE", 300);
  if (accountId && !check("account", String(accountId), limit, 60_000)) {
    return res.status(429).json({ error: "Account rate limit exceeded.", limit });
  }
  next();
}

export function criticalEndpointRateLimit(req: any, res: any, next: any) {
  const key = buildRateKey(req);
  const limit = limitFromEnv("DEFAULT_CRITICAL_RATE_LIMIT_PER_MINUTE", 30);
  if (!check("critical", key, limit, 60_000)) {
    return res.status(429).json({ error: "Critical endpoint rate limit exceeded.", limit });
  }
  next();
}

export async function perInstanceRateLimit(req: any, res: any, next: any) {
  const instanceId = req.params?.id || req.body?.instance_id;
  const planLimits: any = instanceId ? await getPlanLimitsForInstance(instanceId) : null;
  const isMessageEndpoint = /send|message|campaign|sender/i.test(String(req.path || req.originalUrl || ""));
  const limit = Number(
    isMessageEndpoint
      ? (planLimits?.message_rate_limit_per_minute || limitFromEnv("DEFAULT_MESSAGE_RATE_LIMIT_PER_MINUTE", 20))
      : (planLimits?.instance_rate_limit_per_minute || limitFromEnv("DEFAULT_INSTANCE_RATE_LIMIT_PER_MINUTE", 30))
  );
  if (instanceId && !check(isMessageEndpoint ? "instance-message" : "instance", String(instanceId), limit, 60_000)) {
    return res.status(429).json({ error: "Instance rate limit exceeded.", limit });
  }
  next();
}
