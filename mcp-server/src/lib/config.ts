export function getConfig(): { bridgeUrl: string; bridgeToken: string; apiUrl: string } {
  return {
    bridgeUrl: process.env.BRIDGE_URL || "http://127.0.0.1:3001",
    bridgeToken: process.env.BRIDGE_TOKEN || "dev-bridge-token",
    apiUrl: process.env.API_URL || "http://127.0.0.1:3000",
  };
}

export function parseConfig(env: Record<string, string | undefined>): { accountId: number; instanceId: number } {
  return {
    accountId: Number(env.WOOAPI_ACCOUNT_ID || env.account_id || 0),
    instanceId: Number(env.WOOAPI_INSTANCE_ID || env.instance_id || 0),
  };
}
