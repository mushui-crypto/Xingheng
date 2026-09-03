import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { requireArbitrageInstanceList, type ArbitrageCloseSafety, type ArbitrageInstance, type ArbitragePositionPresentation, type InstanceHedgeDelta } from "../../../api/arbitrageInstances";
import {
  ArbitrageInstanceContent,
  ArbitrageInstanceSections,
  POSITION_COUNTDOWN_REFRESH_INTERVAL_MS,
  POSITION_PRESENTATION_REFRESH_INTERVAL_MS,
  loadVerifications,
  maskAccountId,
  hedgeExitSummary,
  canonicalBaseAsset,
  estimatedFundingTone,
  firstLevelManagedQuantity,
  InstanceDeltaPanel,
  instanceExitAvailability,
  exitCapabilityReadsComplete,
  loadExitCapabilities,
  canAbandonUnstartedArbitrage,
  canResumeOpeningWorkflow,
  legActionAvailability,
  managementReleaseCandidates,
  managementEndMethodLabel,
  ManagementHistory,
  LegacyUnresolvedSealHistory,
  ManagementReleaseActions,
  reconcileArbitrageHedge,
  statusLabel,
  terminalSnapshotExitCapabilities,
  positionFundingCountdownValue,
  updatePositionPresentations,
  updateInstanceSections,
  unresolvedClosingReference,
  verificationStatusLabel,
  type VerificationState,
} from "./ArbitrageInstanceOverview";
import { exitStopMessage, persistedExitProgress, remainingActiveManaged, submitExitOnce } from "./ArbitrageHedgeExitDialog";
import { compareUnsignedDecimals } from "./ArbitrageLegCloseDialog";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function presentation(arbitrageId: string): ArbitragePositionPresentation {
  return {
    arbitrageId,
    market: {
      fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingTime: Date.now() + 3_600_000,
      nextEstimatedFundingFee: "0", nextEstimatedFundingFeeAsset: "USDT",
      spreadQuotePerBase: 6, spreadBps: 60, quotedAt: 1_800_000_000_000,
      marketDataAsOf: 1_800_000_000_000, completeness: "COMPLETE",
    },
    revenue: {
      cumulativeFundingIncome: null, incurredFees: null, estimatedExitFees: null,
      currentArbitrageNetProfit: null, completeness: "INCOMPLETE",
    },
  };
}

test("current and history sections render every lifecycle status in Chinese", () => {
  const active = requireArbitrageInstanceList([
    arbitrageInstance("OPENING"),
    arbitrageInstance("HOLDING"),
    arbitrageInstance("RESIDUAL"),
    arbitrageInstance("CLOSING"),
  ]);
  const history = requireArbitrageInstanceList([
    arbitrageInstance("CLOSED"),
    arbitrageInstance("FAILED"),
  ]);
  const activeHtml = renderToStaticMarkup(
    <ArbitrageInstanceSections active={active} history={history} onPageChange={() => undefined} page={1} />,
  );
  const historyHtml = renderToStaticMarkup(
    <ArbitrageInstanceSections active={active} history={history} onPageChange={() => undefined} page={1} selectedSection="history" />,
  );
  const html = `${activeHtml}${historyHtml}`;

  for (const label of ["建仓中", "持有中", "需检查", "退出中", "管理已结束"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /当前套利/);
  assert.match(html, /历史记录/);
  assert.match(html, /合约多头 · LONG/);
  assert.match(html, /合约空头 · SHORT/);
  assert.doesNotMatch(html, /PERPETUAL_PERPETUAL|OPENING|HOLDING|RESIDUAL|CLOSING|CLOSED|FAILED/u);
  assert.doesNotMatch(html, /okx:private-account-1234|binance:private-account-5678/u);
  assert.doesNotMatch(html, /APR|APY/u);
  assert.equal((activeHtml.match(/继续开仓/gu) ?? []).length, 0);
  assert.doesNotMatch(activeHtml, /href="\/app\/arbitrage|resumeArbitrageId=/u);
  assert.doesNotMatch(historyHtml, /继续开仓/u);
});

test("arbitrage position card follows the three-level decision hierarchy without inventing PnL", () => {
  const [perpetual] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const spotLong: ArbitrageInstance = {
    ...perpetual!,
    arbitrageId: "arbitrage-spot-long-ui",
    strategyType: "SPOT_PERPETUAL",
    legs: [
      { ...perpetual!.legs[0], instrumentId: "DOGE-USDT-SPOT" },
      { ...perpetual!.legs[1], instrumentId: "DOGE-USDT-PERP" },
    ],
    pnl: { asset: "USDT", cumulativeFundingPnl: "1.2", realizedTradingPnl: "99", feesCosts: "0.3", cumulativeNetPnl: null, updatedAt: null },
  };
  const html = renderToStaticMarkup(<ArbitrageInstanceSections
    active={[spotLong]}
    history={[]}
    onPageChange={() => undefined}
    page={1}
    presentations={[presentation(spotLong.arbitrageId)]}
    verifications={{ [spotLong.arbitrageId]: matchedVerification(spotLong, "60.531381", "60") }}
  />);
  const defaultLayer = html.slice(html.indexOf("资金费率套利"), html.indexOf("hidden=\"\""));
  const source = readFileSync(new URL("./ArbitrageInstanceOverview.tsx", import.meta.url), "utf8");

  assert.match(html, /DOGE \/ USDT/u);
  assert.match(defaultLayer, /资金费率套利[\s\S]*OKX 现货 → Binance 永续/u);
  assert.match(defaultLayer, /当前资金费率[\s\S]*下次预计资金费[\s\S]*距下次结算[\s\S]*跨所退出价差[\s\S]*管理数量[\s\S]*当前退出状态/u);
  assert.match(defaultLayer, /\+0\.0100%[\s\S]*\/ 8h[\s\S]*0[\s\S]*USDT[\s\S]*6\.000000[\s\S]*60\.00 bps/u);
  assert.match(html, /数据完整/u);
  assert.doesNotMatch(defaultLayer, /净 Delta|可安全退出数量|safeClosable/u);
  assert.match(html, /现货多头[\s\S]*交易所实际数量[\s\S]*60.531381/u);
  assert.match(html, /合约空头 · SHORT[\s\S]*交易所实际仓位/u);
  assert.doesNotMatch(html, /Provider Reality/u);
  assert.match(html, /仓位健康[\s\S]*净 Delta[\s\S]*来源[\s\S]*可交易[\s\S]*影响退出[\s\S]*最后同步时间/u);
  assert.match(html, /收益明细[\s\S]*暂无可靠收益数据/u);
  assert.doesNotMatch(html, /Spot PnL|Perp PnL|单腿浮盈亏|基差收益损失/u);
  assert.match(source, /sm:grid-cols-2 lg:grid-cols-4/u);
  assert.match(source, /const \[expanded, setExpanded\] = useState\(false\)/u);
  assert.match(source, /aria-expanded=\{expanded\}[\s\S]*setExpanded/u);
  assert.match(source, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/u);
  assert.doesNotMatch(source, /cumulativeFundingPnl[\s\S]{0,200}feesCosts[\s\S]{0,200}[+\-]/u);
});

test("incomplete presentation stays null and never falls back to instance PnL", () => {
  const [active] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const html = renderToStaticMarkup(<ArbitrageInstanceSections
    active={[active!]}
    history={[]}
    onPageChange={() => undefined}
    page={1}
    presentations={[{ ...presentation(active!.arbitrageId), market: {
      ...presentation(active!.arbitrageId).market, fundingRate: null, fundingIntervalHours: null,
      nextFundingTime: null, nextEstimatedFundingFee: null, nextEstimatedFundingFeeAsset: null,
      spreadQuotePerBase: null, spreadBps: null, quotedAt: null, marketDataAsOf: null, completeness: "INCOMPLETE",
    } }]}
  />);
  assert.match(html, /行情数据更新中[\s\S]*数据更新中/u);
  assert.doesNotMatch(html, />12\.5 USDT<|>3\.25 USDT</u);
});

test("first-level metrics use one canonical hedge quantity and stronger typography", () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const managed = firstLevelManagedQuantity(instance!, matchedVerification(instance!, "97.902", "97"), {});
  const source = readFileSync(new URL("./ArbitrageInstanceOverview.tsx", import.meta.url), "utf8");

  assert.deepEqual(managed, { value: "97", unit: "XAUT" });
  assert.match(source, /compact \? "text-\[15px\]" : "text-xl"/u);
  assert.match(source, /text-\[13px\] leading-5/u);
  assert.match(source, /tabular-nums/u);
  assert.doesNotMatch(source.slice(source.indexOf("function firstLevelManagedQuantity"), source.indexOf("function currentExitPresentation")), /join\(" \/ "\)/u);
});

test("funding fee color follows the signed estimated amount and fails neutral when stale", () => {
  const base = presentation("arb-color");
  const withFee = (value: string | null, completeness: "COMPLETE" | "INCOMPLETE" = "COMPLETE") => ({
    ...base,
    market: { ...base.market, nextEstimatedFundingFee: value, completeness },
  });

  assert.equal(estimatedFundingTone(withFee("1.25")), "success");
  assert.equal(estimatedFundingTone(withFee("-1.25")), "risk");
  assert.equal(estimatedFundingTone(withFee("0")), "neutral");
  assert.equal(estimatedFundingTone(withFee(null)), "neutral");
  assert.equal(estimatedFundingTone(withFee("1.25", "INCOMPLETE")), "neutral");
});

test("countdown changes locally each second and never becomes negative", () => {
  const base = presentation("arb-countdown");
  const nextFundingTime = 1_800_000_010_000;
  const value = { ...base, market: { ...base.market, nextFundingTime } };

  assert.equal(POSITION_COUNTDOWN_REFRESH_INTERVAL_MS, 1_000);
  assert.deepEqual(positionFundingCountdownValue(value, nextFundingTime - 2_000), { value: "00:00:02", detail: null });
  assert.deepEqual(positionFundingCountdownValue(value, nextFundingTime - 1_000), { value: "00:00:01", detail: null });
  assert.deepEqual(positionFundingCountdownValue(value, nextFundingTime), { value: "--", detail: "等待下一周期数据" });
});

test("one page-level presentation refresh replaces all live market fields without provider polling", () => {
  const before = presentation("arb-live");
  const after = {
    ...before,
    market: {
      ...before.market,
      fundingRate: 0.0002,
      nextEstimatedFundingFee: "1.5",
      spreadQuotePerBase: 7,
      spreadBps: 70,
    },
  };
  const updated = updatePositionPresentations({ status: "success", active: [], history: [], presentations: [before] }, [after]);
  assert.equal(POSITION_PRESENTATION_REFRESH_INTERVAL_MS, 20_000);
  assert.equal(updated.status, "success");
  if (updated.status === "success") assert.deepEqual(updated.presentations?.[0]?.market, after.market);

  const source = readFileSync(new URL("./ArbitrageInstanceOverview.tsx", import.meta.url), "utf8");
  const polling = source.slice(source.indexOf("useEffect(() => {\n    if (selectedSection"), source.indexOf("const applyInstanceUpdate"));
  assert.match(polling, /fetchArbitragePositionPresentations/u);
  assert.doesNotMatch(polling, /fetchArbitragePositionVerification|fetchArbitrageCloseSafety|fetchInstanceHedgeDelta|Provider|WebSocket|EventSource/u);
});

test("revenue collapses when unreliable and restores a four-column grid for reliable values", () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const emptyHtml = renderToStaticMarkup(<ArbitrageInstanceSections
    active={[instance!]}
    history={[]}
    onPageChange={() => undefined}
    page={1}
    presentations={[presentation(instance!.arbitrageId)]}
  />);
  const populated = {
    ...presentation(instance!.arbitrageId),
    revenue: {
      cumulativeFundingIncome: "0",
      incurredFees: null,
      estimatedExitFees: "0.25",
      currentArbitrageNetProfit: "1.5",
      completeness: "COMPLETE" as const,
    },
  };
  const populatedHtml = renderToStaticMarkup(<ArbitrageInstanceSections
    active={[instance!]}
    history={[]}
    onPageChange={() => undefined}
    page={1}
    presentations={[populated]}
  />);

  assert.match(emptyHtml, /收益明细[\s\S]*暂无可靠收益数据/u);
  assert.doesNotMatch(emptyHtml, /累计资金费收入/u);
  assert.match(populatedHtml, /累计资金费收入[\s\S]*>0<[\s\S]*预计退出手续费[\s\S]*0\.25/u);
  assert.match(populatedHtml, /lg:grid-cols-4/u);
});

test("leg exit copy only describes exit capability and primary actions stay outside the expand button", () => {
  const source = readFileSync(new URL("./ArbitrageInstanceOverview.tsx", import.meta.url), "utf8");
  const legPanel = source.slice(source.indexOf("function PositionLegPanel"), source.indexOf("function PositionHealthPanel"));
  const card = source.slice(source.indexOf("function InstanceCard"), source.indexOf("function PrimaryMetric"));
  for (const label of ["可安全退出", "可部分安全退出", "需同步确认", "当前不可安全退出"]) {
    assert.match(legPanel, new RegExp(label, "u"));
  }
  assert.doesNotMatch(legPanel, /存在可交易偏差|存在不可交易残余|对冲偏差/u);
  assert.match(card, /<\/button>[\s\S]*<HedgeExitActions[\s\S]*<dl/u);
  assert.match(source, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/u);
});

test("only OPENING instances expose the resume action", () => {
  const active = requireArbitrageInstanceList([
    arbitrageInstance("HOLDING"),
    arbitrageInstance("RESIDUAL"),
    arbitrageInstance("CLOSING"),
  ]);
  const html = renderToStaticMarkup(<ArbitrageInstanceSections active={active} history={[]} onPageChange={() => undefined} page={1} />);
  assert.doesNotMatch(html, /继续开仓|resumeArbitrageId/u);
});

test("only an empty unstarted OPENING instance exposes the instance-level abandon action", () => {
  const empty = emptyUnstartedInstance();
  const html = renderToStaticMarkup(<ArbitrageInstanceSections
    active={[empty]}
    history={[]}
    onInstanceRefresh={async () => empty}
    onPageChange={() => undefined}
    page={1}
  />);

  assert.equal(canAbandonUnstartedArbitrage(empty), true);
  assert.match(html, /放弃套利/u);
  assert.match(html, /继续开仓/u);
  assert.doesNotMatch(html, /退出套利/u);
});

test("UNKNOWN and any execution fact hide unstarted abandonment", () => {
  const empty = emptyUnstartedInstance();
  const unknown: ArbitrageInstance = {
    ...empty,
    arbitrageId: "arbitrage-unknown",
    executionReferences: [{
      arbitrageId: "arbitrage-unknown",
      legId: empty.legs[0].legId,
      phase: "OPENING",
      quantityEffect: "INCREASE",
      executionIntentId: "intent-unknown",
      executionRecordId: "record-unknown",
      requestedQuantity: "1",
      confirmedQuantity: "0",
      status: "UNKNOWN",
      createdAt: 1_800_000_000_100,
      updatedAt: 1_800_000_000_200,
    }],
  };
  const html = renderToStaticMarkup(<ArbitrageInstanceSections
    active={[unknown]}
    history={[]}
    onInstanceRefresh={async () => unknown}
    onPageChange={() => undefined}
    page={1}
  />);

  assert.equal(canAbandonUnstartedArbitrage(unknown), false);
  assert.doesNotMatch(html, /放弃套利/u);
});

test("abandon confirmation copy is explicit, no-mutation, and duplicate-submit guarded", () => {
  const source = readFileSync(new URL("./ArbitrageUnstartedAbandonDialog.tsx", import.meta.url), "utf8");
  assert.match(source, /该套利尚未开始真实交易。确认后将终止此实例，不会提交任何交易订单/u);
  assert.match(source, /不会生成成交、仓位或 Provider 事实/u);
  assert.match(source, /确认放弃套利/u);
  assert.match(source, /submitting\.current/u);
  assert.doesNotMatch(source, /placeOrder|closeLeg|startHedge|releaseArbitrageLegManagement/u);
});

test("an abandoned empty instance moves to history as unstarted and terminated", () => {
  const empty = emptyUnstartedInstance();
  const failed = { ...empty, status: "FAILED" as const, updatedAt: empty.updatedAt + 1 };
  const updated = updateInstanceSections({ status: "success", active: [empty], history: [] }, failed);
  const html = renderToStaticMarkup(<ArbitrageInstanceSections
    active={updated.active}
    history={updated.history}
    onPageChange={() => undefined}
    page={1}
    selectedSection="history"
  />);

  assert.deepEqual(updated.active, []);
  assert.equal(updated.history[0]?.status, "FAILED");
  assert.match(html, /未开始 \/ 已终止/u);
  assert.doesNotMatch(html, /继续开仓|放弃套利/u);
});

test("a RESIDUAL instance with execution facts never enters editable unstarted resume", () => {
  const [base] = requireArbitrageInstanceList([arbitrageInstance("RESIDUAL")]);
  const partial = { ...base!, executionReferences: [{
    arbitrageId: base!.arbitrageId, legId: base!.legs[0].legId, phase: "OPENING" as const,
    quantityEffect: "INCREASE" as const, executionIntentId: "partial-first", executionRecordId: "partial-record",
    requestedQuantity: "100", confirmedQuantity: "40", status: "FAILED" as const, createdAt: 1, updatedAt: 2,
  }] };
  assert.equal(canResumeOpeningWorkflow(partial), false);
});

test("active legs render matched, mismatch, unknown and null quantities without mixing legs", () => {
  const [active] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const html = renderToStaticMarkup(
    <ArbitrageInstanceSections
      active={[active!]}
      history={[]}
      onPageChange={() => undefined}
      page={1}
      verifications={{
        [active!.arbitrageId]: {
          status: "success",
          verification: {
            arbitrageId: active!.arbitrageId,
            checkedAt: 1_800_000_004_000,
            legs: [
              { arbitrageId: active!.arbitrageId, legId: "short-leg", expectedManagedQuantity: "2", actualQuantity: null, verificationStatus: "UNKNOWN", checkedAt: 1_800_000_004_000 },
              { arbitrageId: active!.arbitrageId, legId: "long-leg", expectedManagedQuantity: "1", actualQuantity: "0.8", verificationStatus: "MISMATCH", checkedAt: 1_800_000_004_000 },
            ],
          },
        },
      }}
    />,
  );
  assert.match(html, /合约多头 · LONG[\s\S]*管理数量[\s\S]*1[\s\S]*交易所实际仓位[\s\S]*0.8[\s\S]*无法完整支持系统管理数量/u);
  assert.match(html, /合约空头 · SHORT[\s\S]*管理数量[\s\S]*2[\s\S]*交易所实际仓位[\s\S]*暂无可靠数据[\s\S]*当前真实仓位暂无法可靠确认/u);
  assert.doesNotMatch(html, />0<\/dd>[\s\S]*当前真实仓位暂无法可靠确认/u);
});

test("Binance, OKX, Bybit and Bitget hide mutation entries until close safety is authoritative", () => {
  const venues = ["binance", "okx", "bybit", "bitget"] as const;
  const active = venues.map((venue) => {
    const [parsed] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
    return { ...parsed!, arbitrageId: `arbitrage-${venue}`, legs: parsed!.legs.map((leg) => ({ ...leg, venue })) as ArbitrageInstance["legs"] };
  });
  const verifications = Object.fromEntries(active.map((instance) => [instance.arbitrageId, matchedVerification(instance, "1", "1")]));
  const html = renderToStaticMarkup(<ArbitrageInstanceSections
    active={active}
    history={[]}
    onExitHedge={() => undefined}
    onPageChange={() => undefined}
    onReconcileHedge={() => undefined}
    page={1}
    verifications={verifications}
  />);

  assert.equal((html.match(/>完整退出</gu) ?? []).length, 0);
  assert.equal((html.match(/>正在刷新…</gu) ?? []).length, 4);
  assert.doesNotMatch(html, /退出该腿|重新核验退出/u);
});

test("the browser submits one instance command and renders persisted two-leg progress", () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const source = readFileSync(new URL("./ArbitrageHedgeExitDialog.tsx", import.meta.url), "utf8");
  assert.deepEqual(persistedExitProgress(instance!), ["○ 空头永续腿等待退出", "○ 多头永续腿等待退出"]);
  assert.match(source, /exitArbitrageInstance/u);
  assert.match(source, /正在退出对冲/u);
  assert.match(source, /已退出/u);
  assert.match(source, /确认中/u);
  assert.match(source, /系统将关闭所有可交易数量/u);
  assert.match(source, /小额残余不会记为交易成交/u);
  assert.match(source, /交易处理中，正在等待交易所确认并同步最新仓位/u);
  assert.match(source, /closeDisabled=\{busy\}/u);
  assert.doesNotMatch(source, /closeArbitrageExecutionLeg|\.closeLeg\(|legId:|quantity:|UnifiedRealTradingTest|Provider/u);
  const polling = source.slice(source.indexOf("setInterval"), source.indexOf("const submit"));
  assert.match(polling, /fetchArbitrageInstanceById/u);
  assert.doesNotMatch(polling, /exitArbitrageInstance|closeArbitrageExecutionLeg|placeOrder/u);
  assert.match(source, /controller\.abort\(\);[\s\S]*clearInterval\(timer\)/u);
  const overview = readFileSync(new URL("./ArbitrageInstanceOverview.tsx", import.meta.url), "utf8");
  const legActions = overview.slice(overview.indexOf("function LegCloseActions"), overview.indexOf("export function legActionAvailability"));
  const instanceActions = overview.slice(overview.indexOf("function HedgeExitActions"), overview.indexOf("export function hedgeExitSummary"));
  assert.doesNotMatch(legActions, /完整退出/u);
  assert.match(instanceActions, /完整退出/u);
});

test("Exit keeps its dialog locked until terminal authoritative refresh completes", () => {
  const source = readFileSync(new URL("./ArbitrageHedgeExitDialog.tsx", import.meta.url), "utf8");
  const submit = source.slice(source.indexOf("const submit = async"), source.indexOf("const busy"));
  assert.match(submit, /catch[\s\S]*finally[\s\S]*terminalRefreshCoordinator\.current\.refresh/u);
  assert.match(submit, /terminalRefreshCoordinator\.current\.refresh[\s\S]*setStatus\(terminalStatus\)/u);
  assert.match(source, /closeDisabled=\{busy\}/u);
  assert.match(source, /状态刷新失败/u);
  assert.match(source, /系统不会自动重发交易命令/u);
  assert.doesNotMatch(submit, /catch[\s\S]*exitArbitrageInstance\(/u);
});

test("Exit uses a synchronous command guard so a double click cannot submit twice", async () => {
  const guard = { current: false };
  let requestCount = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const submit = async () => {
    requestCount += 1;
    await pending;
  };
  const first = submitExitOnce(guard, submit);
  const duplicate = submitExitOnce(guard, submit);
  assert.equal(requestCount, 1);
  assert.equal(await duplicate, false);
  release();
  assert.equal(await first, true);
  assert.equal(requestCount, 1);
});

test("exit partial progress preserves and displays remaining Active Managed", () => {
  const [current] = requireArbitrageInstanceList([arbitrageInstance("CLOSING")]);
  const partial = { ...current!, legs: [
    { ...current!.legs[0], confirmedOpenedQuantity: "100", confirmedClosedQuantity: "70" },
    { ...current!.legs[1], confirmedOpenedQuantity: "100", confirmedClosedQuantity: "100" },
  ] as ArbitrageInstance["legs"] };
  assert.equal(remainingActiveManaged(partial), "30");
});

test("exit stop copy exposes controlled phase and reason without leaking raw Provider text", () => {
  assert.equal(exitStopMessage({
    failedLegId: "short-leg",
    phase: "PERPETUAL_CLOSE",
    reason: "POSITION_VERIFICATION_UNAVAILABLE",
    completedLegIds: ["long-leg"],
    currentManagedExposure: [{ legId: "long-leg", quantity: "0" }, { legId: "short-leg", quantity: "10" }],
  }), "退出流程已停止于永续腿退出：当前交易所真实仓位暂时无法可靠确认。");

  const rawProviderText = "provider stack: api-key=secret";
  const message = exitStopMessage({
    failedLegId: "short-leg",
    phase: "PERPETUAL_CONFIRMATION",
    reason: rawProviderText,
    completedLegIds: [],
    currentManagedExposure: [{ legId: "short-leg", quantity: "10" }],
  });
  assert.equal(message, "退出流程已停止于永续腿成交确认：当前安全条件未满足。");
  assert.doesNotMatch(message, /provider|api-key|secret/iu);

  assert.equal(exitStopMessage({
    failedLegId: "short-leg",
    phase: "PERPETUAL_PRE_MUTATION",
    reason: "POSITION_MODE_UNAVAILABLE",
    mutationDisposition: "NOT_DISPATCHED",
    diagnosticCategory: "POSITION_MODE_UNAVAILABLE",
    failureStage: "PRE_MUTATION",
    completedLegIds: ["long-leg"],
    currentManagedExposure: [{ legId: "long-leg", quantity: "0" }, { legId: "short-leg", quantity: "10" }],
  }), "退出流程已停止于永续腿订单提交前准备：交易所持仓模式暂时无法可靠确认，订单尚未提交。");

  assert.equal(exitStopMessage({
    failedLegId: "short-leg",
    phase: "PERPETUAL_PRE_MUTATION",
    reason: "PRE_MUTATION_LOCAL_FAILURE",
    mutationDisposition: "NOT_DISPATCHED",
    diagnosticCategory: "EXECUTION_RECORD_PERSIST_FAILED",
    failureStage: "PRE_MUTATION_EXECUTION_RECORD_PERSIST",
    completedLegIds: ["long-leg"],
    currentManagedExposure: [{ legId: "long-leg", quantity: "0" }, { legId: "short-leg", quantity: "95" }],
  }), "退出流程已停止于永续腿订单提交前准备：订单提交前的本地准备未能完成，本次订单尚未提交。");
});

test("arbitrage records do not expose order cancellation controls", () => {
  const [parsed] = requireArbitrageInstanceList([arbitrageInstance("OPENING")]);
  const active = {
    ...parsed!,
    executionReferences: [{
      arbitrageId: parsed!.arbitrageId,
      legId: "long-leg",
      phase: "OPENING" as const,
      quantityEffect: "INCREASE" as const,
      executionIntentId: "intent-active",
      executionRecordId: "record-active",
      requestedQuantity: "1",
      confirmedQuantity: "0.25",
      status: "PENDING_CONFIRMATION" as const,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_100,
    }, {
      arbitrageId: parsed!.arbitrageId,
      legId: "short-leg",
      phase: "OPENING" as const,
      quantityEffect: "INCREASE" as const,
      executionIntentId: "intent-terminal",
      executionRecordId: "record-terminal",
      requestedQuantity: "1",
      confirmedQuantity: "1",
      status: "CONFIRMED" as const,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_100,
    }],
  };
  const current = renderToStaticMarkup(<ArbitrageInstanceSections
    active={[active]}
    history={[]}
    onPageChange={() => undefined}
    page={1}
  />);
  const history = renderToStaticMarkup(<ArbitrageInstanceSections
    active={[]}
    history={[{ ...active, status: "FAILED" as const }]}
    onPageChange={() => undefined}
    page={1}
    selectedSection="history"
  />);
  assert.doesNotMatch(current, /撤销订单/u);
  assert.doesNotMatch(history, /撤销订单/u);
});

test("reopening restores two-leg exit progress from persisted execution references", () => {
  const venues = ["binance", "okx", "bybit", "bitget"] as const;
  const active = venues.map((venue, index) => {
    const [parsed] = requireArbitrageInstanceList([arbitrageInstance("CLOSING")]);
    const legs: ArbitrageInstance["legs"] = [
      { ...parsed!.legs[0], venue },
      parsed!.legs[1],
    ];
    const instance: ArbitrageInstance = {
      ...parsed!,
      arbitrageId: `arbitrage-recovery-${venue}`,
      legs,
      executionReferences: [{
        arbitrageId: `arbitrage-recovery-${venue}`,
        legId: "long-leg",
        phase: "CLOSING" as const,
        quantityEffect: "DECREASE" as const,
        executionIntentId: `close-${venue}`,
        executionRecordId: `record-long-${venue}`,
        requestedQuantity: "0.9",
        confirmedQuantity: "0.9",
        status: "CONFIRMED" as const,
        createdAt: 1_800_000_000_000,
        updatedAt: 1_800_000_000_100,
      }, {
        arbitrageId: `arbitrage-recovery-${venue}`,
        legId: "short-leg",
        phase: "CLOSING" as const,
        quantityEffect: "DECREASE" as const,
        executionIntentId: `close-short-${venue}`,
        executionRecordId: index === 0 ? null : `record-short-${venue}`,
        requestedQuantity: "1",
        confirmedQuantity: "0",
        status: (["CLAIMED", "LINKED", "PENDING_CONFIRMATION", "UNKNOWN"] as const)[index]!,
        createdAt: 1_800_000_000_000,
        updatedAt: 1_800_000_000_200,
      }],
    };
    assert.equal(unresolvedClosingReference(instance, "short-leg")?.executionIntentId, `close-short-${venue}`);
    return instance;
  });
  const html = renderToStaticMarkup(<ArbitrageInstanceSections
    active={active}
    history={[]}
    onExitHedge={() => undefined}
    onPageChange={() => undefined}
    onReconcileHedge={() => undefined}
    page={1}
  />);

  assert.equal((html.match(/✓ 多头永续腿已退出/gu) ?? []).length, 4);
  assert.equal((html.match(/○ 空头永续腿确认中/gu) ?? []).length, 4);
  assert.equal((html.match(/>正在刷新…</gu) ?? []).length, 4);
  assert.doesNotMatch(html, /退出该腿|重新核验退出/u);
});

test("active managed lifecycle wins over flat Account Reality", () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("CLOSING")]);
  const flatReality = {
    status: "success" as const,
    verification: {
      arbitrageId: instance!.arbitrageId,
      checkedAt: 1_800_000_004_000,
      legs: instance!.legs.map((leg) => ({
        arbitrageId: instance!.arbitrageId,
        legId: leg.legId,
        expectedManagedQuantity: "1",
        actualQuantity: "0",
        verificationStatus: "MISMATCH" as const,
        checkedAt: 1_800_000_004_000,
      })) as [{
        arbitrageId: string; legId: string; expectedManagedQuantity: string; actualQuantity: string;
        verificationStatus: "MISMATCH"; checkedAt: number;
      }, {
        arbitrageId: string; legId: string; expectedManagedQuantity: string; actualQuantity: string;
        verificationStatus: "MISMATCH"; checkedAt: number;
      }],
    },
  };
  const active = hedgeExitSummary(instance!, flatReality);
  const normal = hedgeExitSummary(instance!, matchedVerification(instance!, "1", "1"));
  const unknown = hedgeExitSummary(instance!, {
    status: "success",
    verification: {
      ...matchedVerification(instance!, "0", "0").verification,
      legs: [
        { ...matchedVerification(instance!, "0", "0").verification.legs[0], actualQuantity: null, verificationStatus: "UNKNOWN" },
        matchedVerification(instance!, "0", "0").verification.legs[1],
      ],
    },
  });

  assert.equal(active.kind, "remaining");
  assert.equal(active.label, "当前真实仓位已无法完整支持系统管理数量");
  assert.equal(active.details.every((detail) => detail.endsWith("交易所真实数量 0")), true);
  assert.doesNotMatch(`${active.label} ${active.details.join(" ")}`, /对冲已结束|剩余/u);
  assert.equal(normal.label, "实例仍在管理");
  assert.equal(unknown.label, "当前真实仓位暂无法可靠确认");
  const html = renderToStaticMarkup(<ArbitrageInstanceSections
    active={[instance!]}
    history={[]}
    onExitHedge={() => undefined}
    onPageChange={() => undefined}
    onReconcileHedge={() => undefined}
    page={1}
    verifications={{ [instance!.arbitrageId]: flatReality }}
  />);
  assert.match(html, />正在刷新…</u);
  assert.doesNotMatch(html, />完整退出|>安全部分退出|>停止管理/u);
  assert.doesNotMatch(html, /对冲已结束/u);
  const overviewSource = readFileSync(new URL("./ArbitrageInstanceOverview.tsx", import.meta.url), "utf8");
  assert.match(overviewSource, /fetchArbitragePositionVerification/u);
  assert.match(overviewSource, /reconcileArbitrageInstance/u);
  assert.doesNotMatch(overviewSource, /reconcileArbitrageExecutionLeg/u);
  assert.doesNotMatch(overviewSource, /onReconcileLeg|重新核验退出/u);
});

test("persisted CLOSED status wins over accepted residual and unrelated account dust", () => {
  const [parsed] = requireArbitrageInstanceList([arbitrageInstance("CLOSED")]);
  const instance = { ...parsed!, maxResidualBaseQuantity: "0.006" };
  const state = matchedVerification(instance, "0.011", "0");

  const summary = hedgeExitSummary(instance, state);
  const html = renderToStaticMarkup(<ArbitrageInstanceSections
    active={[instance]}
    history={[]}
    onExitHedge={() => undefined}
    onPageChange={() => undefined}
    onReconcileHedge={() => undefined}
    page={1}
    verifications={{ [instance.arbitrageId]: state }}
  />);

  assert.equal(summary.kind, "ended");
  assert.equal(summary.label, "实例管理已结束");
  assert.match(html, /管理已结束/u);
  assert.doesNotMatch(html, />退出对冲<|>重新核验</u);
});

test("refresh recovery keeps the not-yet-started second leg visible in exit progress", () => {
  const [parsed] = requireArbitrageInstanceList([arbitrageInstance("CLOSING")]);
  const instance: ArbitrageInstance = {
    ...parsed!,
    executionReferences: [{
      arbitrageId: parsed!.arbitrageId,
      legId: "short-leg",
      phase: "CLOSING",
      quantityEffect: "DECREASE",
      executionIntentId: "close-short",
      executionRecordId: "record-short",
      requestedQuantity: "1",
      confirmedQuantity: "1",
      status: "CONFIRMED",
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_100,
    }],
  };

  assert.deepEqual(hedgeExitSummary(instance, matchedVerification(instance, "1", "0")).progress, [
    "○ 多头永续腿等待退出",
    "✓ 空头永续腿已退出",
  ]);
});

test("one reconciliation action restores persisted references and verifies both positions once", async () => {
  const [parsed] = requireArbitrageInstanceList([arbitrageInstance("CLOSING")]);
  const references = parsed!.legs.map((leg, index) => ({
    arbitrageId: parsed!.arbitrageId,
    legId: leg.legId,
    phase: "CLOSING" as const,
    quantityEffect: "DECREASE" as const,
    executionIntentId: `close-${leg.legId}`,
    executionRecordId: `record-${leg.legId}`,
    requestedQuantity: "1",
    confirmedQuantity: "0",
    status: (index === 0 ? "PENDING_CONFIRMATION" : "UNKNOWN") as "PENDING_CONFIRMATION" | "UNKNOWN",
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_100,
  }));
  const current: ArbitrageInstance = { ...parsed!, executionReferences: references };
  const calls: string[] = [];
  const result = await reconcileArbitrageHedge(
    current,
    async (arbitrageId) => {
      calls.push(arbitrageId);
      return { instance: current, verification: matchedVerification(current, "0", "0").verification };
    },
  );

  assert.deepEqual(calls, [current.arbitrageId]);
  assert.equal(result.verification.legs.every((leg) => leg.actualQuantity === "0"), true);
});

test("history renders confirmed quantities without live verification fields", () => {
  const [history] = requireArbitrageInstanceList([arbitrageInstance("CLOSED")]);
  const html = renderToStaticMarkup(<ArbitrageInstanceSections active={[]} history={[history!]} onPageChange={() => undefined} page={1} selectedSection="history" />);
  assert.match(html, /已确认开仓数量/);
  assert.match(html, /正常确认退出数量/);
  assert.match(html, /管理结束时间/u);
  assert.doesNotMatch(html, /关闭时间|交易所真实数量|仓位一致|暂无法确认/u);
});

test("verification status labels are factual Chinese descriptions", () => {
  assert.deepEqual([
    verificationStatusLabel("MATCHED"),
    verificationStatusLabel("MISMATCH"),
    verificationStatusLabel("UNKNOWN"),
  ], [
    "当前仓位关系正常",
    "当前真实仓位已无法完整支持系统管理数量",
    "当前真实仓位暂无法可靠确认",
  ]);
});

test("a terminal update immediately moves an instance from active to history", () => {
  const [active] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const [closed] = requireArbitrageInstanceList([arbitrageInstance("CLOSED")]);
  const next = updateInstanceSections({ status: "success", active: [active!], history: [] }, {
    ...closed!,
    arbitrageId: active!.arbitrageId,
  });

  assert.deepEqual(next.active, []);
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0]?.status, "CLOSED");
  const html = renderToStaticMarkup(<ArbitrageInstanceSections
    active={next.active}
    history={next.history}
    onPageChange={() => undefined}
    page={1}
    selectedSection="history"
  />);
  assert.match(html, /实例管理已结束/u);
  assert.match(html, /管理结束时间/u);
});

test("leg close dialog uses the same verification and lifecycle wording", () => {
  const source = readFileSync(new URL("./ArbitrageLegCloseDialog.tsx", import.meta.url), "utf8");
  assert.match(source, /交易所真实数量/u);
  assert.match(source, /当前仓位关系正常/u);
  assert.match(source, /当前真实仓位已无法完整支持系统管理数量/u);
  assert.match(source, /当前真实仓位暂无法可靠确认/u);
  assert.match(source, /实例管理已结束/u);
  assert.doesNotMatch(source, /仓位一致|当前真实数量|CLOSED: "已关闭"/u);
});

test("verification requests only active ids and isolates a single failure", async () => {
  const active = requireArbitrageInstanceList([arbitrageInstance("OPENING"), arbitrageInstance("HOLDING")]);
  const requested: string[] = [];
  const states: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    if (String(input).includes("opening")) return new Response("unavailable", { status: 503 });
    return Response.json(verificationPayload("arbitrage-holding"));
  };
  try {
    await loadVerifications(active, new AbortController().signal, (id, state) => states.push(`${id}:${state.status}`));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requested.sort(), [
    "/api/arbitrage-instances/arbitrage-holding/verification",
    "/api/arbitrage-instances/arbitrage-opening/verification",
  ]);
  assert.deepEqual(states.sort(), ["arbitrage-holding:success", "arbitrage-opening:error"]);
});

test("exit capability refresh retries transient CloseSafety failures and returns one complete snapshot", async () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const calls = new Map<string, number>();
  const result = await loadExitCapabilities(instance!, new AbortController().signal, {
    verification: async () => matchedVerification(instance!, "1", "1").verification,
    delta: async () => hedgeDelta(instance!, "KNOWN", "KNOWN"),
    closeSafety: async (_arbitrageId, legId) => {
      const count = (calls.get(legId) ?? 0) + 1;
      calls.set(legId, count);
      if (count === 1) throw new Error("temporary read failure");
      return closeSafety({ fullManagedCloseAvailable: true, safeClosableQuantity: "1", releaseEligible: false });
    },
    wait: async () => undefined,
  });

  assert.equal(result.verification.status, "success");
  assert.equal(result.delta.status, "success");
  assert.equal(Object.values(result.closeSafeties).every((state) => state.status === "success"), true);
  assert.deepEqual(Object.fromEntries(calls), { "long-leg": 2, "short-leg": 2 });
  assert.equal(instanceExitAvailability(
    instance!,
    result.verification,
    Object.fromEntries(Object.entries(result.closeSafeties).map(([legId, state]) => [
      legId,
      state.status === "success" ? state.value : undefined,
    ])),
  ), true);
});

test("exit capability refresh bounds persistent CloseSafety failures and stays fail closed", async () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  let calls = 0;
  const result = await loadExitCapabilities(instance!, new AbortController().signal, {
    verification: async () => matchedVerification(instance!, "1", "1").verification,
    delta: async () => hedgeDelta(instance!, "KNOWN", "KNOWN"),
    closeSafety: async () => {
      calls += 1;
      throw new Error("still unavailable");
    },
    wait: async () => undefined,
  });

  assert.equal(calls, instance!.legs.length * 3);
  assert.equal(Object.values(result.closeSafeties).every((state) => state.status === "error"), true);
  assert.equal(instanceExitAvailability(instance!, result.verification, {}), false);
});

test("exit capability refresh retries semantic Provider Reality UNKNOWN before exposing full exit", async () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const calls = new Map<string, number>();
  const result = await loadExitCapabilities(instance!, new AbortController().signal, {
    verification: async () => matchedVerification(instance!, "1", "1").verification,
    delta: async () => hedgeDelta(instance!, "KNOWN", "KNOWN"),
    closeSafety: async (_arbitrageId, legId) => {
      const count = (calls.get(legId) ?? 0) + 1;
      calls.set(legId, count);
      if (count === 1) return closeSafety({
        realityReliable: false,
        reason: "PROVIDER_REALITY_UNAVAILABLE",
        safeClosableQuantity: "0",
        releaseEligible: false,
      });
      return closeSafety({ fullManagedCloseAvailable: true, safeClosableQuantity: "1", releaseEligible: false });
    },
    wait: async () => undefined,
  });

  assert.deepEqual(Object.fromEntries(calls), { "long-leg": 2, "short-leg": 2 });
  const values = Object.fromEntries(Object.entries(result.closeSafeties).map(([legId, state]) => [
    legId,
    state.status === "success" ? state.value : undefined,
  ]));
  assert.equal(instanceExitAvailability(instance!, result.verification, values), true);
});

test("exit capability UI refreshes lifecycle and reconcile changes without exposing fallback actions while incomplete", () => {
  const source = readFileSync(new URL("./ArbitrageInstanceOverview.tsx", import.meta.url), "utf8");
  const effect = source.slice(source.indexOf("useEffect(() => {", source.indexOf("function InstanceCard")), source.indexOf("const safetyValues", source.indexOf("function InstanceCard")));
  assert.match(effect, /refreshExitCapabilities/u);
  assert.match(effect, /instance\.status/u);
  assert.match(effect, /instance\.updatedAt/u);
  assert.match(source, /await onReconcileHedge\(instance\)[\s\S]*await refreshExitCapabilities\(\)/u);
  assert.match(source, /exitCapabilitiesComplete[\s\S]*LegCloseActions/u);
  assert.match(source, /exitCapabilitiesComplete[\s\S]*managementReleaseCandidates/u);
  assert.match(source, /刷新退出状态/u);
});

test("Start terminal snapshot atomically supplies HOLDING instance facts and full Exit capability", () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const verification = matchedVerification(instance!, "1", "1").verification;
  const safety = closeSafety({
    activeManagedQuantity: "1",
    safeClosableQuantity: "1",
    fullManagedCloseAvailable: true,
    releaseEligible: false,
  });
  const capabilities = terminalSnapshotExitCapabilities({
    instance: instance!,
    workflow: null,
    verification,
    closeSafeties: { "long-leg": safety, "short-leg": safety },
    delta: hedgeDelta(instance!, "KNOWN", "KNOWN"),
    complete: true,
  });

  assert.equal(exitCapabilityReadsComplete(instance!, capabilities), true);
  assert.equal(capabilities.verification.status, "success");
  assert.equal(capabilities.delta.status, "success");
  assert.equal(Object.values(capabilities.closeSafeties).every((state) => state.status === "success"), true);
  assert.equal(instanceExitAvailability(
    instance!,
    capabilities.verification,
    Object.fromEntries(Object.entries(capabilities.closeSafeties).map(([legId, state]) => [
      legId,
      state.status === "success" ? state.value : undefined,
    ])),
  ), true);
});

test("Start terminal snapshot handoff invalidates stale capability reads and avoids an immediate duplicate refresh", () => {
  const source = readFileSync(new URL("./ArbitrageInstanceOverview.tsx", import.meta.url), "utf8");
  const card = source.slice(source.indexOf("function InstanceCard"), source.indexOf("function StatusBadge"));
  assert.match(card, /onTerminalSnapshot/u);
  assert.match(card, /refreshController\.current\?\.abort\(\)/u);
  assert.match(card, /refreshGeneration\.current \+= 1/u);
  assert.match(card, /setCapabilities\(terminalSnapshotExitCapabilities\(snapshot\)\)/u);
  assert.match(card, /onInstanceUpdated\?\.\(snapshot\.instance\)/u);
  assert.match(card, /appliedTerminalSnapshotKey\.current === terminalSnapshotKey\(instance\)[\s\S]*return/u);
  assert.match(source, /状态刷新失败，请重新刷新。系统不会自动重发交易命令/u);
});

test("empty and failed states use stable Chinese product messages", () => {
  const empty = renderToStaticMarkup(
    <ArbitrageInstanceSections active={[]} history={[]} onPageChange={() => undefined} page={1} />,
  );
  const emptyHistory = renderToStaticMarkup(
    <ArbitrageInstanceSections active={[]} history={[]} onPageChange={() => undefined} page={1} selectedSection="history" />,
  );
  const failed = renderToStaticMarkup(
    <ArbitrageInstanceContent onPageChange={() => undefined} page={1} state={{ status: "error" }} />,
  );

  assert.match(empty, /暂无当前套利组合/);
  assert.match(emptyHistory, /暂无历史套利记录/);
  assert.match(failed, /套利组合加载失败，请稍后重试/);
  assert.doesNotMatch(failed, /500|Internal Server|arbitrage_instance_query_failed/u);
});

test("status and account presentation do not expose internal enums or full account ids", () => {
  assert.deepEqual([
    statusLabel("OPENING"),
    statusLabel("HOLDING"),
    statusLabel("RESIDUAL"),
    statusLabel("CLOSING"),
    statusLabel("CLOSED"),
    statusLabel("FAILED"),
  ], ["建仓中", "持有中", "存在残余", "退出中", "实例管理已结束", "失败"]);
  assert.equal(maskAccountId("binance:private-account-5678"), "bina…5678");
  assert.equal(maskAccountId("short"), "••••");
});

test("my arbitrage page keeps the account area and adds the query-backed combination area", () => {
  const source = readFileSync(new URL("../../../pages/app/PersonalTradingPage.tsx", import.meta.url), "utf8");
  assert.match(source, /<AccountReadOverview/u);
  assert.match(source, /<ArbitrageInstanceOverview \/>/u);
  assert.match(source, /px-4 py-5 md:px-8 md:py-7/u);
  assert.doesNotMatch(source, /Position|OrderHistory|FundingRate|BinanceTradingWorkbench/u);
});

test("authoritative close safety controls full close, partial close, release, and UNKNOWN fail-closed", () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const matched = matchedVerification(instance!, "1", "1");
  const mismatch: VerificationState = {
    ...matched,
    verification: {
      ...matched.verification,
      legs: [
        { ...matched.verification.legs[0], verificationStatus: "MISMATCH" },
        { ...matched.verification.legs[1], verificationStatus: "MISMATCH" },
      ],
    },
  };
  const full = closeSafety({ fullManagedCloseAvailable: true, safeClosableQuantity: "1", releaseEligible: false });
  const partial = closeSafety({ safeClosableQuantity: "0.25", releaseEligible: true });
  const dust = closeSafety({ safeClosableQuantity: "0.94", reason: "QUANTITY_STEP_DUST", releaseEligible: true });
  const unavailable = closeSafety({ safeClosableQuantity: "0", releaseEligible: true });
  const unknown = closeSafety({ realityReliable: false, reason: "PROVIDER_REALITY_UNAVAILABLE", safeClosableQuantity: "0", releaseEligible: false });

  assert.equal(instanceExitAvailability(instance!, matched, { "long-leg": full, "short-leg": full }), true);
  assert.equal(instanceExitAvailability(instance!, matched, { "long-leg": partial, "short-leg": full }), false);
  assert.equal(instanceExitAvailability(instance!, matched, { "long-leg": dust, "short-leg": full }), true);
  assert.deepEqual(legActionAvailability("MISMATCH", partial), { partialClose: true, release: true });
  assert.deepEqual(legActionAvailability("MISMATCH", partial, true), { partialClose: false, release: true });
  assert.deepEqual(legActionAvailability("MISMATCH", unavailable), { partialClose: false, release: true });
  assert.deepEqual(legActionAvailability("UNKNOWN", unknown), { partialClose: false, release: false });
  assert.deepEqual(
    managementReleaseCandidates(instance!, mismatch, { "long-leg": partial, "short-leg": full }).map((leg) => leg.legId),
    ["long-leg"],
  );
  assert.deepEqual(
    managementReleaseCandidates(instance!, {
      ...matched,
      verification: {
        ...matched.verification,
        legs: [matched.verification.legs[0], {
          ...matched.verification.legs[1], verificationStatus: "UNKNOWN",
        }],
      },
    }, { "long-leg": partial, "short-leg": unknown }),
    [],
  );
  const hiddenRelease = renderToStaticMarkup(<ManagementReleaseActions
    candidates={[instance!.legs[0]]}
    instanceFullExitAvailable
    onRelease={() => undefined}
  />);
  const exceptionalRelease = renderToStaticMarkup(<ManagementReleaseActions
    candidates={[instance!.legs[0]]}
    instanceFullExitAvailable={false}
    onRelease={() => undefined}
  />);
  assert.equal(hiddenRelease, "");
  assert.match(exceptionalRelease, /异常处置[\s\S]*XAUT-USDT-PERP[\s\S]*保留残余并结束跟踪/u);
  assert.equal(instanceExitAvailability({
    ...instance!,
    executionReferences: [{
      arbitrageId: instance!.arbitrageId,
      executionIntentId: "pending-opening",
      executionRecordId: "pending-record",
      legId: "long-leg",
      phase: "OPENING",
      quantityEffect: "INCREASE",
      requestedQuantity: "1",
      confirmedQuantity: "0",
      status: "UNKNOWN",
      createdAt: 1_800_000_000_021,
      updatedAt: 1_800_000_000_022,
    }],
  }, matched, { "long-leg": full, "short-leg": full }), false);
  assert.equal(instanceExitAvailability(instance!, mismatch, { "long-leg": full, "short-leg": full }), true);
  assert.equal(instanceExitAvailability(instance!, {
    ...matched,
    verification: { ...matched.verification, legs: [{ ...matched.verification.legs[0], verificationStatus: "UNKNOWN" }, matched.verification.legs[1]] },
  }, { "long-leg": full, "short-leg": full }), false);
});

test("partial close quantity comparison remains exact for decimal strings", () => {
  assert.equal(compareUnsignedDecimals("0.200000000000000001", "0.2"), 1);
  assert.equal(compareUnsignedDecimals("100000000000000000000", "99999999999999999999.9"), 1);
  assert.equal(compareUnsignedDecimals("0.100", "0.1"), 0);
  const source = readFileSync(new URL("./ArbitrageLegCloseDialog.tsx", import.meta.url), "utf8");
  assert.match(source, /safeClosableQuantity/u);
  assert.doesNotMatch(source, /parseFloat|Number\(/u);
});

test("management history distinguishes normal close, release, and mixed management endings", () => {
  const [closed] = requireArbitrageInstanceList([arbitrageInstance("CLOSED")]);
  const release = managementReleasePayload(closed!.arbitrageId, "long-leg", "0.4");
  const released = { ...closed!, managementReleases: [release], executionReferences: [] };
  const mixed = {
    ...released,
    executionReferences: [{
      arbitrageId: closed!.arbitrageId, legId: "long-leg", phase: "CLOSING" as const, quantityEffect: "DECREASE" as const,
      executionIntentId: "close-1", executionRecordId: "record-1", requestedQuantity: "0.6", confirmedQuantity: "0.6",
      status: "CONFIRMED" as const, createdAt: 1_800_000_002_000, updatedAt: 1_800_000_002_100,
    }],
  };
  const releasedHtml = renderToStaticMarkup(<ManagementHistory instance={released} />);
  const mixedHtml = renderToStaticMarkup(<ArbitrageInstanceSections active={[]} history={[mixed]} onPageChange={() => undefined} page={1} selectedSection="history" />);

  assert.equal(managementEndMethodLabel("NORMAL_CLOSE"), "正常退出完成");
  assert.equal(managementEndMethodLabel("MANAGEMENT_RELEASE"), "保留残余并结束跟踪");
  assert.equal(managementEndMethodLabel("MIXED"), "部分正常退出 + 保留残余结束跟踪");
  assert.match(releasedHtml, /已保留残余数量[\s\S]*0.4[\s\S]*历史快照/u);
  assert.match(releasedHtml, /不代表 Xingheng 已执行平仓/u);
  assert.doesNotMatch(releasedHtml, /已清仓|全部仓位已平仓/u);
  assert.match(mixedHtml, /部分正常退出 \+ 保留残余结束跟踪/u);
  assert.match(mixedHtml, /正常确认退出数量/u);
  assert.match(mixedHtml, /已保留残余数量/u);
});

test("sealed legacy UNKNOWN remains visible as UNKNOWN while lifecycle UI is terminal", () => {
  const [closed] = requireArbitrageInstanceList([arbitrageInstance("CLOSED")]);
  const sealed: ArbitrageInstance = {
    ...closed!,
    executionReferences: [{
      arbitrageId: closed!.arbitrageId, legId: "long-leg", phase: "OPENING", quantityEffect: "INCREASE",
      executionIntentId: "legacy-intent", executionRecordId: "legacy-record", requestedQuantity: "114.383757",
      confirmedQuantity: "0", status: "UNKNOWN", createdAt: 1, updatedAt: 2,
    }],
    legacyUnresolvedExecutionSeals: [{
      commandId: "seal-command", operationType: "SEAL_LEGACY_UNRESOLVED_EXECUTION", requestedByUserId: "user-a",
      arbitrageId: closed!.arbitrageId, legId: "long-leg", executionIntentId: "legacy-intent",
      executionRecordId: "legacy-record", venue: "okx", accountId: "account-a", instrumentId: "DOGE-USDT-SPOT",
      originalStatus: "UNKNOWN", sealStatus: "LEGACY_UNRESOLVED_MANUALLY_SEALED",
      reason: "LEGACY_RECOVERY_IDENTITY_GAP", businessPayloadFingerprint: "fingerprint", sealedAt: 3,
    }],
  };
  const history = renderToStaticMarkup(<ArbitrageInstanceSections
    active={[]} history={[sealed]} onPageChange={() => undefined} page={1} selectedSection="history"
  />);
  const audit = renderToStaticMarkup(<LegacyUnresolvedSealHistory instance={sealed} />);
  assert.equal(managementEndMethodLabel("LEGACY_UNRESOLVED_SEAL"), "历史异常已封存");
  assert.match(history, /实例管理已结束[\s\S]*历史异常已封存/u);
  assert.match(audit, /交易状态[\s\S]*历史 UNKNOWN[\s\S]*处理状态[\s\S]*历史异常已封存/u);
  assert.doesNotMatch(history, /继续开仓|确认开始真实对冲/u);
});

test("instance Delta UI keeps opening and active evidence independent and never turns residual into an order instruction", () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("HOLDING")]);
  const known = hedgeDelta(instance!, "KNOWN", "KNOWN");
  const activeUnknown = hedgeDelta(instance!, "KNOWN", "UNKNOWN");
  const knownHtml = renderToStaticMarkup(<InstanceDeltaPanel instance={instance!} state={{ status: "success", value: known }} />);
  const unknownHtml = renderToStaticMarkup(<InstanceDeltaPanel instance={instance!} state={{ status: "success", value: activeUnknown }} />);

  assert.equal(canonicalBaseAsset(instance!), "XAUT");
  assert.match(knownHtml, /本实例 Hedge Delta[\s\S]*本实例开仓 Delta[\s\S]*0.01 XAUT[\s\S]*当前管理 Delta[\s\S]*-0.02 XAUT/u);
  assert.match(knownHtml, /实际开仓残差[\s\S]*0.03 XAUT/u);
  assert.doesNotMatch(knownHtml, /还需下单|待补数量|一键/u);
  assert.match(unknownHtml, /本实例开仓 Delta[\s\S]*0.01 XAUT[\s\S]*当前管理 Delta[\s\S]*暂无法可靠计算/u);
  assert.doesNotMatch(unknownHtml, /当前管理 Delta[\s\S]*>0(?:\.0+)?</u);
});

test("second-leg workflow is informational and residual release has an explicit no-mutation confirmation", () => {
  const [instance] = requireArbitrageInstanceList([arbitrageInstance("OPENING")]);
  const delta = { ...hedgeDelta(instance!, "KNOWN", "KNOWN"), openingWorkflow: {
    secondLegRequired: true, secondLegExecutionEligible: null, requiredSecondLegSignedExposure: "-1",
  } };
  const html = renderToStaticMarkup(<InstanceDeltaPanel instance={instance!} state={{ status: "success", value: delta }} />);
  const releaseSource = readFileSync(new URL("./ArbitrageManagementReleaseDialog.tsx", import.meta.url), "utf8");
  assert.match(html, /第二腿尚待执行[\s\S]*理论所需对冲暴露/u);
  assert.doesNotMatch(html, /执行第二腿|补单/u);
  assert.match(releaseSource, /不会向交易所提交平仓订单/u);
  assert.match(releaseSource, /历史 execution 记录不会修改/u);
  assert.match(releaseSource, /确认保留残余并结束跟踪/u);
  assert.match(releaseSource, /releaseEligible/u);
  assert.doesNotMatch(releaseSource, /releasedQuantity.*input|quantity.*input/u);
  const overviewSource = readFileSync(new URL("./ArbitrageInstanceOverview.tsx", import.meta.url), "utf8");
  const legActions = overviewSource.slice(overviewSource.indexOf("function LegCloseActions"), overviewSource.indexOf("export function legActionAvailability"));
  const releaseActions = overviewSource.slice(overviewSource.indexOf("function ManagementReleaseActions"), overviewSource.indexOf("export function instanceExitAvailability"));
  assert.doesNotMatch(legActions, /保留残余并结束跟踪|停止管理/u);
  assert.match(releaseActions, /异常处置[\s\S]*保留残余并结束跟踪/u);
});

function arbitrageInstance(status: string) {
  const terminal = status === "CLOSED" || status === "FAILED";
  return {
    arbitrageId: `arbitrage-${status.toLowerCase()}`,
    userId: "user-a",
    strategyType: "PERPETUAL_PERPETUAL",
    sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0.001",
    status,
    createdAt: 1_800_000_000_000,
    openedAt: status === "OPENING" || status === "FAILED" ? null : 1_800_000_001_000,
    updatedAt: 1_800_000_002_000,
    closedAt: terminal ? 1_800_000_003_000 : null,
    legs: [
      {
        legId: "long-leg",
        role: "LONG",
        venue: "okx",
        accountId: "okx:private-account-1234",
        instrumentId: "XAUT-USDT-PERP",
        plannedQuantity: "1",
        confirmedOpenedQuantity: "1",
        confirmedClosedQuantity: terminal ? "1" : "0",
      },
      {
        legId: "short-leg",
        role: "SHORT",
        venue: "binance",
        accountId: "binance:private-account-5678",
        instrumentId: "XAUT-USDT-PERP",
        plannedQuantity: "1",
        confirmedOpenedQuantity: "1",
        confirmedClosedQuantity: terminal ? "1" : "0",
      },
    ],
    executionReferences: [],
    pnl: {
      asset: null,
      cumulativeFundingPnl: null,
      realizedTradingPnl: null,
      feesCosts: null,
      cumulativeNetPnl: null,
      updatedAt: null,
    },
  };
}

function emptyUnstartedInstance(): ArbitrageInstance {
  const [base] = requireArbitrageInstanceList([arbitrageInstance("OPENING")]);
  return {
    ...base!,
    arbitrageId: "arbitrage-empty-unstarted",
    legs: base!.legs.map((leg) => ({
      ...leg,
      confirmedOpenedQuantity: "0",
      confirmedClosedQuantity: "0",
    })) as ArbitrageInstance["legs"],
    executionReferences: [],
    managementReleases: [],
  };
}

function verificationPayload(arbitrageId: string) {
  return {
    arbitrageId,
    checkedAt: 1_800_000_004_000,
    legs: [
      { arbitrageId, legId: "long-leg", expectedManagedQuantity: "1", actualQuantity: "1", verificationStatus: "MATCHED", checkedAt: 1_800_000_004_000 },
      { arbitrageId, legId: "short-leg", expectedManagedQuantity: "1", actualQuantity: "1", verificationStatus: "MATCHED", checkedAt: 1_800_000_004_000 },
    ],
  };
}

function matchedVerification(instance: ArbitrageInstance, longQuantity: string, shortQuantity: string) {
  return {
    status: "success" as const,
    verification: {
      arbitrageId: instance.arbitrageId,
      checkedAt: 1_800_000_004_000,
      legs: [
        { arbitrageId: instance.arbitrageId, legId: instance.legs[0].legId, expectedManagedQuantity: longQuantity, actualQuantity: longQuantity, verificationStatus: "MATCHED" as const, checkedAt: 1_800_000_004_000 },
        { arbitrageId: instance.arbitrageId, legId: instance.legs[1].legId, expectedManagedQuantity: shortQuantity, actualQuantity: shortQuantity, verificationStatus: "MATCHED" as const, checkedAt: 1_800_000_004_000 },
      ] as [
        { arbitrageId: string; legId: string; expectedManagedQuantity: string; actualQuantity: string; verificationStatus: "MATCHED"; checkedAt: number },
        { arbitrageId: string; legId: string; expectedManagedQuantity: string; actualQuantity: string; verificationStatus: "MATCHED"; checkedAt: number },
      ],
    },
  };
}

function closeSafety(overrides: Partial<ArbitrageCloseSafety> = {}): ArbitrageCloseSafety {
  return {
    activeManagedQuantity: "1",
    safeClosableQuantity: "0",
    fullManagedCloseAvailable: false,
    reason: "ONE_WAY_REALITY_INSUFFICIENT",
    checkedAt: 1_800_000_004_000,
    realityReliable: true,
    releaseEligible: false,
    hasUnresolvedExecution: false,
    releaseEligibilityReason: "RELEASE_ELIGIBLE",
    positionMode: "ONE_WAY",
    actualQuantity: "0.25",
    actualSignedNetQuantity: "0.25",
    actualLongQuantity: "0.25",
    actualShortQuantity: "0",
    availableQuantity: null,
    ...overrides,
  };
}

function managementReleasePayload(
  arbitrageId: string,
  legId: string,
  releasedQuantity: string,
): ArbitrageInstance["managementReleases"][number] {
  return {
    releaseId: "release-1",
    arbitrageId,
    legId,
    releasedQuantity,
    reason: "USER_CONFIRMED_STOP_MANAGEMENT",
    source: "AUTHENTICATED_API",
    requestedByUserId: "user-a",
    requestedAt: 1_800_000_002_500,
    confirmedAt: 1_800_000_003_000,
    venue: "okx",
    accountId: "okx:private-account-1234",
    instrumentId: "XAUT-USDT-PERP",
    positionMode: "ONE_WAY",
    actualQuantity: "0.4",
    actualSignedNetQuantity: "0.4",
    actualLongQuantity: "0.4",
    actualShortQuantity: "0",
    availableQuantity: null,
    realityCheckedAt: 1_800_000_002_900,
  };
}

function hedgeDelta(
  instance: ArbitrageInstance,
  openingStatus: "KNOWN" | "UNKNOWN",
  activeStatus: "KNOWN" | "UNKNOWN",
): InstanceHedgeDelta {
  const view = (status: "KNOWN" | "UNKNOWN", quantity: string) => ({
    status,
    signedDeltaBaseQuantity: status === "KNOWN" ? quantity : null,
    absoluteDeltaBaseQuantity: status === "KNOWN" ? quantity.replace("-", "") : null,
    reason: status === "UNKNOWN" ? "EXECUTION_EVIDENCE_UNRESOLVED" as const : null,
  });
  return {
    arbitrageId: instance.arbitrageId,
    status: instance.status,
    openingDelta: view(openingStatus, "0.01"),
    activeManagedDelta: view(activeStatus, "-0.02"),
    openingWorkflow: { secondLegRequired: false, secondLegExecutionEligible: null, requiredSecondLegSignedExposure: null },
    legContributions: instance.legs.map((leg) => ({
      legId: leg.legId,
      role: leg.role,
      marketType: "PERPETUAL" as const,
      signedContribution: activeStatus === "KNOWN" ? (leg.role === "LONG" ? "1" : "-1.02") : null,
      openingSignedContribution: openingStatus === "KNOWN" ? (leg.role === "LONG" ? "1" : "-0.99") : null,
      activeManagedQuantity: "1",
      source: "PERPETUAL_CONFIRMED_EXECUTION" as const,
      openingStatus,
      openingReason: openingStatus === "UNKNOWN" ? "EXECUTION_EVIDENCE_UNRESOLVED" as const : null,
      activeStatus,
      activeReason: activeStatus === "UNKNOWN" ? "EXECUTION_EVIDENCE_UNRESOLVED" as const : null,
      status: activeStatus,
      reason: activeStatus === "UNKNOWN" ? "EXECUTION_EVIDENCE_UNRESOLVED" as const : null,
    })) as InstanceHedgeDelta["legContributions"],
    plannedResidualDelta: "0.02",
    actualResidualDelta: "0.03",
    derivedAt: 1_800_000_004_000,
    deltaStatus: activeStatus,
    signedDeltaBaseQuantity: activeStatus === "KNOWN" ? "-0.02" : null,
    absoluteDeltaBaseQuantity: activeStatus === "KNOWN" ? "0.02" : null,
    currentOpeningDelta: openingStatus === "KNOWN" ? "0.01" : null,
    openingDeltaStatus: openingStatus,
    requiredSecondLegSignedExposure: null,
    deltaKnown: activeStatus === "KNOWN",
    reason: activeStatus === "UNKNOWN" ? "EXECUTION_EVIDENCE_UNRESOLVED" : null,
  };
}
