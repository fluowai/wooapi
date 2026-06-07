type RedisConnectionOptions = {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db?: number;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
  enableReadyCheck: boolean;
  connectTimeout: number;
  retryStrategy: (attempts: number) => number;
};

function fromRedisUrl(rawUrl?: string): Partial<RedisConnectionOptions> {
  if (!rawUrl) return {};
  try {
    const parsed = new URL(rawUrl);
    return {
      host: parsed.hostname || "redis",
      port: Number(parsed.port || 6379),
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      db: parsed.pathname && parsed.pathname !== "/" ? Number(parsed.pathname.slice(1)) : undefined,
      tls: parsed.protocol === "rediss:" ? {} : undefined
    };
  } catch {
    return {};
  }
}

const urlOptions = fromRedisUrl(process.env.REDIS_URL);
const defaultRedisHost = process.env.NODE_ENV === "production" ? "redis" : "127.0.0.1";

export const redisConnection: RedisConnectionOptions = {
  host: urlOptions.host || process.env.REDIS_HOST || defaultRedisHost,
  port: Number(urlOptions.port || process.env.REDIS_PORT || 6379),
  username: urlOptions.username,
  password: urlOptions.password || process.env.REDIS_PASSWORD || undefined,
  db: urlOptions.db,
  tls: urlOptions.tls,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 10000),
  retryStrategy: (attempts: number) => Math.min(attempts * 1000, 30000)
};
