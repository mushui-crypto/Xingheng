import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ConnectivitySmokePolicy,
  ConnectivitySmokeReceipt,
  ConnectivitySmokeStage,
  ConnectivitySmokeStatus,
} from "../model/connectivitySmokeTypes";
import {
  PolicyDisclosure,
  ReceiptPanel,
  StatusPanel,
  UnknownExecutionPanel,
  allConfirmed,
  createConnectivitySmokeScope,
  isConnectivitySmokeScopeCurrent,
  nextConnectivitySmokeScope,
  providerStateLabel,
  stageLabel,
  statusBlocksNewRun,
} from "./ConnectivitySmokeConsole";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const budget = {
  limitUsd: 25,
  quantityXaut: 0.01,
  commonQtyStep: 0.001,
  slippageBpsPerAction: 10,
  prices: { spotOpenLimit: 2_500, futuresOpenLimit: 2_499, futuresCloseLimit: 2_501, spotCloseLimit: 2_498 },
  spotNotionalUsd: 12,
  futuresMarginUsd: 12,
  spotFeesUsd: 0.01,
  futuresFeesUsd: 0.01,
  spotSlippageReserveUsd: 0.02,
  futuresSlippageReserveUsd: 0.02,
  roundingReserveUsd: 0.01,
  totalCapitalUsd: 24.07,
};

const providerState = {
  verificationStatus: "verified" as const,
  observedAt: 1_800_000_000_000,
  residualSpotQuantityXaut: 0,
  residualFuturesQuantityXaut: 0,
  activeSpotOrderCount: 0,
  activeFuturesOrderCount: 0,
  activeTotalOrderCount: 0,
  providerFlatConfirmed: true,
  reason: "provider_flat_confirmed",
};

const orders = {
  spotOpen: {
    orderId: "safe-order-1", orderLinkId: "link-1", category: "spot" as const, side: "Buy" as const,
    status: "Filled", requestedQuantityXaut: 0.01, filledQuantityXaut: 0.01, averagePriceUsd: 2_500,
    feeUsd: 0.01, reduceOnly: false, updatedAt: 1_800_000_000_010,
  },
  futuresOpen: null,
  futuresClose: null,
  spotClose: null,
};

const status: ConnectivitySmokeStatus = {
  smokeId: "smoke-1",
  purpose: "connectivity_smoke",
  mode: "connectivity_smoke",
  venue: "binance",
  accountFingerprint: "fingerprint",
  stage: "flat",
  policyVersion: "server-version",
  policyDigest: "server-digest",
  budget,
  openedSpotQuantityXaut: 0.01,
  openedFuturesQuantityXaut: 0.01,
  orders,
  providerState,
  timeline: [{ stage: "reserved", at: 1_800_000_000_000, code: "reserved" }, { stage: "flat", at: 1_800_000_000_020, code: "stage_flat" }],
  receipt: null,
  noReopen: true,
  providerMutationCount: 4,
  errorCategory: null,
  message: "provider 已确认闭环。",
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_000_020,
};

test("three independent confirmations are required and manual intervention always blocks another run", () => {
  assert.equal(allConfirmed({
    exclusiveWindowConfirmed: true,
    manualRecoveryConfirmed: true,
    nonAtomicRiskAccepted: false,
  }), false);
  assert.equal(allConfirmed({
    exclusiveWindowConfirmed: true,
    manualRecoveryConfirmed: true,
    nonAtomicRiskAccepted: true,
  }), true);
  assert.equal(statusBlocksNewRun({ ...status, stage: "manual_intervention" }), true);
  assert.equal(statusBlocksNewRun({ ...status, stage: "flat" }), false);
});

test("account generation rejects every deferred A response after switching to B", async () => {
  let current = createConnectivitySmokeScope("account-a");
  const capturedPolicy = current;
  const capturedPreflight = current;
  const capturedExecute = current;
  const capturedLookup = current;
  const capturedStatus = current;
  const capturedReceipt = current;
  const deferred = Promise.resolve().then(() => {
    current = nextConnectivitySmokeScope(current, "account-b");
    return [
      capturedPolicy,
      capturedPreflight,
      capturedExecute,
      capturedLookup,
      capturedStatus,
      capturedReceipt,
    ].map((captured) => isConnectivitySmokeScopeCurrent(current, captured));
  });
  assert.deepEqual(await deferred, [false, false, false, false, false, false]);
  assert.equal(isConnectivitySmokeScopeCurrent(current, createConnectivitySmokeScope("account-b")), false);
  assert.equal(current.accountId, "account-b");
  assert.equal(current.generation, 1);
});

test("unknown execution UI preserves exact correlation and offers lookup without execute replay", () => {
  const html = renderToStaticMarkup(
    <UnknownExecutionPanel
      busy={false}
      onLookup={() => undefined}
      request={{
        accountId: "account-r2",
        challengeId: "challenge-r2",
        challengeToken: "must-not-render",
        idempotencyKey: "idempotency-r2",
        policyVersion: "policy-r2",
        policyDigest: "digest-r2",
      }}
    />,
  );
  assert.match(html, /受理状态未知/);
  assert.match(html, /challenge-r2/);
  assert.match(html, /继续查询本次请求/);
  assert.match(html, /请勿重复开始/);
  assert.doesNotMatch(html, /must-not-render|idempotency-r2|TOTP 验证|提交服务端实时预检/);
});

test("all server stages and provider verification states have explicit non-color labels", () => {
  const stages: ConnectivitySmokeStage[] = [
    "reserved", "spot_opening", "spot_open", "futures_opening", "hedged",
    "futures_closing", "spot_closing", "flat", "failed", "manual_intervention",
  ];
  for (const stage of stages) assert.ok(stageLabel(stage).length > 0);
  assert.equal(providerStateLabel("verified"), "已验证快照");
  assert.equal(providerStateLabel("stale"), "快照已过期");
  assert.equal(providerStateLabel("ambiguous"), "状态有歧义");
  assert.equal(providerStateLabel("unavailable"), "状态不可用");
});

test("policy disclosure uses server messages instead of client policy prose", () => {
  const policy: ConnectivitySmokePolicy = {
    mode: "connectivity_smoke",
    venue: "binance",
    accountId: "binance-account",
    executionAuthorized: false,
    message: "server-only authorization warning",
    policy: {
      version: "server-version",
      digest: "server-digest",
      maxPlannedCapitalUsd: 25,
      dedicatedBlankSubaccount: true,
      singleExecution: true,
      immediateExit: true,
      challengeTtlMs: 60_000,
      continuity: "non_atomic_incomplete",
      requiredConfirmations: ["exclusive_window", "manual_recovery", "non_atomic_risk"],
      exclusiveWindowRules: [{ code: "server-exclusive", message: "server exclusive message" }],
      manualRecoveryRequirements: [{ code: "server-manual", message: "server manual message" }],
      residualRisks: [{ code: "server-risk", message: "server risk message" }],
    },
  };
  const html = renderToStaticMarkup(<PolicyDisclosure policy={policy} />);
  assert.match(html, /server exclusive message/);
  assert.match(html, /server manual message/);
  assert.match(html, /server risk message/);
  assert.doesNotMatch(html, /server-version|server-digest/);
});

test("manual intervention renders only server residual facts and never exposes close-all", () => {
  const html = renderToStaticMarkup(
    <StatusPanel
      active={false}
      status={{
        ...status,
        stage: "manual_intervention",
        providerState: {
          ...providerState,
          verificationStatus: "ambiguous",
          residualSpotQuantityXaut: 0.003,
          residualFuturesQuantityXaut: 0.002,
          activeSpotOrderCount: 1,
          activeFuturesOrderCount: 2,
          activeTotalOrderCount: 3,
          providerFlatConfirmed: null,
          reason: "provider_ledger_mismatch",
        },
      }}
    />,
  );
  assert.match(html, /需要人工处理/);
  assert.match(html, /0.003 XAUT/);
  assert.match(html, /0.002 XAUT/);
  assert.match(html, /活动订单合计/);
  assert.match(html, /不要重复开始/);
  assert.doesNotMatch(html, /退出全部|close-all/i);
});

test("receipt separates planned budget from actual metric availability and historical disclosure", () => {
  const receipt: ConnectivitySmokeReceipt = {
    receiptId: "receipt-1",
    smokeId: status.smokeId,
    purpose: "connectivity_smoke",
    venue: "binance",
    symbol: "XAUTUSDT",
    accountFingerprint: status.accountFingerprint,
    policyVersion: status.policyVersion,
    policyDigest: status.policyDigest,
    budget,
    openedSpotQuantityXaut: 0.01,
    openedFuturesQuantityXaut: 0.01,
    finalSpotQuantityXaut: 0,
    finalFuturesQuantityXaut: 0,
    providerFlatConfirmed: true,
    completedAt: status.updatedAt,
    acceptedConfirmations: {
      exclusiveWindowConfirmed: true,
      manualRecoveryConfirmed: true,
      nonAtomicRiskAccepted: true,
    },
    disclosureAvailability: "unavailable_for_historical_digest",
    disclosure: null,
    disclosureReason: "historical_policy_digest_not_available",
    orders,
    finalProviderState: providerState,
    timeline: status.timeline,
    metrics: {
      actualFeesUsd: { availability: "available", value: 0.04, reason: null },
      actualSlippageUsd: { availability: "unavailable", value: null, reason: "authoritative_reference_prices_not_persisted" },
      actualRealizedPnlUsd: { availability: "unavailable", value: null, reason: "authoritative_pnl_inputs_not_persisted" },
    },
  };
  const html = renderToStaticMarkup(<ReceiptPanel receipt={receipt} />);
  assert.match(html, /计划资本/);
  assert.match(html, /实际手续费/);
  assert.match(html, /0.04/);
  assert.match(html, /服务端无法权威计算/);
  assert.match(html, /历史 policy 披露不可用/);
  assert.match(html, /safe-order-1/);
  assert.match(html, /不进入套利持仓、Funding 或绩效统计/);
  assert.match(html, /grid-cols-2/);
  assert.match(html, /sm:grid-cols-2/);
  assert.match(html, /xl:grid-cols-4/);
  assert.doesNotMatch(html, /min-w-\[[4-9]\d{2}px\]/);
  assert.doesNotMatch(html, /资金费率|APR|APY|累计收益/);
});
