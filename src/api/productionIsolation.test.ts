import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import type * as Fixture from "./localArbitrageFixture";
import type * as Runtime from "./runtimeEnvironment";
import type * as Instances from "./arbitrageInstances";

// Exercise the real call sites with the same compile-time DEV substitution as Vite.
async function buildFrontend(development: boolean, hostname = "localhost") {
  const result = await build({
    stdin: {
      contents: 'export * from "./localArbitrageFixture"; export * from "./runtimeEnvironment"; export * from "./arbitrageInstances";',
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "browser",
    define: { "import.meta.env": JSON.stringify({ DEV: development, PROD: !development }) },
  });
  const module = { exports: {} };
  const requests: string[] = [];
  runInNewContext(result.outputFiles[0].text, {
    module,
    window: { location: { hostname } },
    fetch: async (input: string) => {
      requests.push(input);
      return new Response(JSON.stringify([]), { status: 200 });
    },
  });
  return { api: module.exports as typeof Fixture & typeof Runtime & typeof Instances, requests };
}

test("development build on localhost can use local arbitrage fixtures", async () => {
  const { api, requests } = await buildFrontend(true);
  assert.equal(api.isLocalFixtureRuntime(), true);
  assert.equal((await api.fetchActiveArbitrageInstances())[0].userId, "demo-user");
  assert.equal((await api.fetchArbitragePositionPresentations()).length, 1);
  assert.equal(requests.length, 0);
});

test("production build on localhost never overrides active, history or presentation API", async () => {
  const { api, requests } = await buildFrontend(false);
  assert.equal(api.isLocalFixtureRuntime(), false);
  assert.equal((await api.fetchActiveArbitrageInstances()).length, 0);
  assert.equal((await api.fetchArbitragePositionPresentations()).length, 0);
  assert.equal((await api.fetchArbitrageInstanceHistory()).length, 0);
  assert.equal(requests.length, 3);
});

test("development build outside localhost does not enable fixtures", async () => {
  const { api } = await buildFrontend(true, "app.stellaxtrade.com");
  assert.equal(api.isLocalFixtureRuntime(), false);
});

test("production build accepts production identity and rejects development identity", async () => {
  const { api } = await buildFrontend(false);
  assert.equal(api.parseRuntimeEnvironmentIdentity({
    deploymentEnvironment: "production", composeProject: "xingheng",
  }).deploymentEnvironment, "production");
  assert.throws(() => api.parseRuntimeEnvironmentIdentity({
    deploymentEnvironment: "development", composeProject: "development",
  }), api.RuntimeEnvironmentValidationError);
});

test("development build accepts development identity but still rejects mixed pairs", async () => {
  const { api } = await buildFrontend(true);
  assert.equal(api.parseRuntimeEnvironmentIdentity({
    deploymentEnvironment: "development", composeProject: "development",
  }).deploymentEnvironment, "development");
  for (const payload of [
    { deploymentEnvironment: "development", composeProject: "xingheng" },
    { deploymentEnvironment: "production", composeProject: "development" },
  ]) assert.throws(() => api.parseRuntimeEnvironmentIdentity(payload), api.RuntimeEnvironmentValidationError);
});
