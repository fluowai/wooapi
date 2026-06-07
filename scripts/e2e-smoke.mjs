const baseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:3002";
const instanceToken = process.env.E2E_INSTANCE_TOKEN || "";
const instanceId = process.env.E2E_INSTANCE_ID || "";
const number = process.env.E2E_NUMBER || "";

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} -> ${response.status}: ${text}`);
  }
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const health = await request("/health");
assert(health.ok === true, "health.ok must be true");
assert(health.bridge === "available", "bridge must be available");

const openapi = await request("/openapi.json");
assert(openapi.openapi, "openapi.json must be valid");
assert(openapi.paths && Object.keys(openapi.paths).length >= 20, "openapi must expose public paths");

await request("/terms");
await request("/docs/production-readiness.md");
await request("/postman/wooapi.postman_collection.json");

if (instanceToken) {
  const status = await request("/instance/status", {
    headers: { token: instanceToken }
  });
  assert(status?.status?.connected === true, "instance must be connected");
  assert(!status?.instance?.qrcode, "connected instance must not expose qrcode");

  if (number) {
    const sent = await request("/send/text", {
      method: "POST",
      headers: { token: instanceToken, "content-type": "application/json" },
      body: JSON.stringify({ number, text: `WooAPI release smoke ${new Date().toISOString()}` })
    });
    assert(sent?.messageId || sent?.id, "send/text must return message id");
  }
}

if (instanceToken && instanceId) {
  const profile = await request(`/api/v1/instances/${instanceId}/profile`, {
    headers: { "x-api-key": instanceToken }
  });
  assert(profile?.success === true, "v1 profile must succeed");
}

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  productionReady: health.production_ready,
  productionBlockers: health.production_blockers || []
}, null, 2));
