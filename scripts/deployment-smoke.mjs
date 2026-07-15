import WebSocket from "ws";

const baseUrl = (process.env.SMOKE_BASE_URL ?? process.argv[2] ?? "").replace(/\/+$/, "");
if (!baseUrl) throw new Error("SMOKE_BASE_URL or URL argument is required");

const healthResponse = await fetch(`${baseUrl}/api/health`);
if (!healthResponse.ok) throw new Error(`health returned ${healthResponse.status}`);
const health = await healthResponse.json();
if (health.ok !== true || health.source !== "hyperliquid") throw new Error("unexpected health response");

const spaResponse = await fetch(`${baseUrl}/__deployment_smoke_route__`);
if (!spaResponse.ok || !(spaResponse.headers.get("content-type") ?? "").includes("text/html")) {
  throw new Error("SPA fallback check failed");
}
for (const route of ["/app/demo", "/app/trade"]) {
  const response = await fetch(`${baseUrl}${route}`);
  if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/html")) {
    throw new Error(`${route} check failed`);
  }
}

const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws`;
await new Promise((resolve, reject) => {
  const socket = new WebSocket(wsUrl);
  const timer = setTimeout(() => {
    socket.terminate();
    reject(new Error("WebSocket connection timed out"));
  }, 10_000);
  socket.once("open", () => {
    clearTimeout(timer);
    socket.close();
    resolve();
  });
  socket.once("error", reject);
});

console.log(`deployment smoke passed: ${baseUrl}`);
