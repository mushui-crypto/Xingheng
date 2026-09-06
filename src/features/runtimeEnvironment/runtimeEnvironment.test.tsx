import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  fetchRuntimeEnvironmentIdentity,
  parseRuntimeEnvironmentIdentity,
  RuntimeEnvironmentValidationError,
} from "../../api/runtimeEnvironment";
import {
  RuntimeEnvironmentStatusBarView,
  SensitiveEnvironmentGateView,
  hasRuntimeEnvironmentBar,
} from "./RuntimeEnvironmentUi";
import {
  beginRuntimeEnvironmentCheck,
  createRuntimeEnvironmentRequestGuard,
  failRuntimeEnvironmentCheck,
  initialRuntimeEnvironmentState,
  runtimeEnvironmentAllowsSensitiveOperations,
  type RuntimeEnvironmentState,
} from "./runtimeEnvironmentState";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const productionIdentity = {
  deploymentEnvironment: "production" as const,
  composeProject: "xingheng" as const,
};

test("health identity accepts exact production and local development pairs", () => {
  assert.deepEqual(parseRuntimeEnvironmentIdentity(productionIdentity), productionIdentity);
  assert.deepEqual(
    parseRuntimeEnvironmentIdentity({ deploymentEnvironment: "development", composeProject: "development" }),
    { deploymentEnvironment: "development", composeProject: "development" },
  );
});

test("health identity fails closed for missing, unknown and mismatched fields", () => {
  const invalidPayloads = [
    null,
    {},
    { deploymentEnvironment: "production" },
    { composeProject: "xingheng" },
    { deploymentEnvironment: "production", composeProject: "other-project" },
    { deploymentEnvironment: "staging", composeProject: "xingheng" },
    { deploymentEnvironment: "PRODUCTION", composeProject: "xingheng" },
  ];

  for (const payload of invalidPayloads) {
    assert.throws(
      () => parseRuntimeEnvironmentIdentity(payload),
      RuntimeEnvironmentValidationError,
    );
  }
});

test("runtime environment API reads no-store health identity without hostname inference", async () => {
  const originalFetch = globalThis.fetch;
  let requestedInput: RequestInfo | URL | undefined;
  let requestedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestedInput = input;
    requestedInit = init;
    return new Response(JSON.stringify(productionIdentity), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  };

  try {
    assert.deepEqual(await fetchRuntimeEnvironmentIdentity(), productionIdentity);
    assert.equal(requestedInput, "/api/health");
    assert.equal(requestedInit?.cache, "no-store");
    assert.equal(requestedInit?.credentials, "include");
    assert.equal(new Headers(requestedInit?.headers).get("Accept"), "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("first failure settles, retry verifies the scope and stale responses cannot write back", async () => {
  const guard = createRuntimeEnvironmentRequestGuard();
  let state = beginRuntimeEnvironmentCheck(initialRuntimeEnvironmentState);
  const first = guard.begin("guest:no-admin");

  state = failRuntimeEnvironmentCheck(state, "环境信息获取失败");
  assert.equal(state.status, "error");
  assert.equal(hasRuntimeEnvironmentBar(state), true);

  const retry = guard.begin("guest:no-admin");
  assert.equal(guard.isCurrent(first), false);
  state = beginRuntimeEnvironmentCheck(state);
  assert.equal(state.status, "checking");

  await Promise.resolve();
  if (guard.isCurrent(retry)) {
    state = { status: "verified", identity: productionIdentity, message: null };
  }
  assert.equal(state.status, "verified");
  assert.deepEqual(state.identity, productionIdentity);

  const previousSession = guard.begin("user-a:no-admin");
  const nextSession = guard.begin("user-b:no-admin");
  assert.equal(guard.isCurrent(previousSession), false);
  assert.equal(guard.isCurrent(nextSession), true);
});

test("rechecking clears a verified identity without treating it as operation-ready", () => {
  const verified: RuntimeEnvironmentState = {
    status: "verified",
    identity: productionIdentity,
    message: null,
  };
  const checking = beginRuntimeEnvironmentCheck(verified);
  assert.equal(checking.status, "checking");
  assert.equal(checking.identity, null);
  assert.equal(runtimeEnvironmentAllowsSensitiveOperations(checking), false);
  assert.equal(runtimeEnvironmentAllowsSensitiveOperations(verified), true);

  const html = renderToStaticMarkup(
    <RuntimeEnvironmentStatusBarView onRetry={() => undefined} state={checking} />,
  );
  assert.equal(html, "");

  const failed = failRuntimeEnvironmentCheck(checking, "环境信息获取失败");
  const failedHtml = renderToStaticMarkup(
    <RuntimeEnvironmentStatusBarView onRetry={() => undefined} state={failed} />,
  );
  assert.match(failedHtml, /环境信息校验失败/);
  assert.equal(runtimeEnvironmentAllowsSensitiveOperations(failed), false);
});

test("verified production renders no environment status bar", () => {
  const productionHtml = renderToStaticMarkup(
    <RuntimeEnvironmentStatusBarView
      onRetry={() => undefined}
      state={{ status: "verified", identity: productionIdentity, message: null }}
    />,
  );
  assert.equal(productionHtml, "");
  assert.equal(hasRuntimeEnvironmentBar({
    status: "verified",
    identity: productionIdentity,
    message: null,
  }), false);
});

test("error and checking gates block sensitive content and expose retry only after failure", () => {
  const checkingHtml = renderToStaticMarkup(
    <SensitiveEnvironmentGateView
      onRetry={() => undefined}
      state={{ status: "checking", identity: null, message: null }}
    />,
  );
  assert.match(checkingHtml, /正在校验运行环境/);
  assert.doesNotMatch(checkingHtml, /重新获取/);

  const errorHtml = renderToStaticMarkup(
    <SensitiveEnvironmentGateView
      onRetry={() => undefined}
      state={{ status: "error", identity: null, message: "错配" }}
    />,
  );
  assert.match(errorHtml, /环境信息校验失败/);
  assert.match(errorHtml, /账户、交易和自动化操作已暂停/);
  assert.match(errorHtml, /重新获取/);
});
