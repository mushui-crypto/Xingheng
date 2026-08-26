import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import express from "express";
import { registerArbitrageRecoveryRoutes } from "./arbitrageRecoveryRoutes";

test("recovery routes expose owner-scoped summary, anomaly filters, and confirmed repair commands", async (t) => {
  const calls: Array<{ method: string; userId: string; input?: unknown }> = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    if (request.headers["x-user-id"]) request.user = { id: String(request.headers["x-user-id"]) } as never;
    next();
  });
  registerArbitrageRecoveryRoutes(app, {
    readSummary(userId) {
      calls.push({ method: "summary", userId });
      return { unresolvedExecutions: [], recoverableCount: 0 } as never;
    },
    readAnomalies(userId, input) {
      calls.push({ method: "anomalies", userId, input });
      return [];
    },
    async repairLegacyPartialConfirmed(userId, input) {
      calls.push({ method: "legacy", userId, input });
      return { providerMutationCount: 0 } as never;
    },
    async backfillSpotAttribution(userId, input) {
      calls.push({ method: "spot", userId, input });
      return { providerMutationCount: 0 } as never;
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server unavailable");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "x-user-id": "user-a", "content-type": "application/json" };

  assert.equal((await fetch(`${base}/api/arbitrage-recovery/summary`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/arbitrage-recovery/anomalies?classification=RECOVERABLE`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/arbitrage-recovery/legacy-execution`, {
    method: "POST", headers, body: JSON.stringify({ recoveryId: "r1", confirmed: true }),
  })).status, 200);
  assert.equal((await fetch(`${base}/api/arbitrage-recovery/spot-attribution`, {
    method: "POST", headers, body: JSON.stringify({ recoveryId: "r2", confirmed: true }),
  })).status, 200);
  assert.equal((await fetch(`${base}/api/arbitrage-recovery/summary`)).status, 400);
  assert.deepEqual(calls.map(({ method, userId }) => ({ method, userId })), [
    { method: "summary", userId: "user-a" },
    { method: "anomalies", userId: "user-a" },
    { method: "legacy", userId: "user-a" },
    { method: "spot", userId: "user-a" },
  ]);
});

test("recovery prefix is protected by the existing authenticated-user middleware", () => {
  const source = readFileSync(new URL("../auth/authRoutes.ts", import.meta.url), "utf8");
  assert.match(source, /"\/api\/arbitrage-recovery"/u);
});
