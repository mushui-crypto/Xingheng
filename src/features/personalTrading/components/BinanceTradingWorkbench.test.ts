import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("entry modal defaults and resets to explicit EXECUTION_PRIORITY", () => {
  const component = readFileSync(new URL("./BinanceTradingWorkbench.tsx", import.meta.url), "utf8");
  const api = readFileSync(new URL("../../../api/binancePersonalTrading.ts", import.meta.url), "utf8");

  assert.match(component, /useState<BinanceUserExecutionMode>\("EXECUTION_PRIORITY"\)/u);
  assert.match(component, /enterBinanceStrategy\(\{[\s\S]*executionMode,/u);
  assert.match(component, /setExecutionMode\("EXECUTION_PRIORITY"\)/u);
  assert.match(component, /PRICE_PRIORITY/u);
  assert.doesNotMatch(component, /localStorage/u);
  assert.match(api, /"PRICE_PRIORITY" \| "EXECUTION_PRIORITY"/u);
});

test("entry modal refreshes exposure, defaults acknowledgement off, warns about total recovery, and sends only the strict literal", () => {
  const component = readFileSync(new URL("./BinanceTradingWorkbench.tsx", import.meta.url), "utf8");
  const api = readFileSync(new URL("../../../api/binancePersonalTrading.ts", import.meta.url), "utf8");

  assert.match(component, /useState\(false\)/u);
  assert.match(component, /const refreshedStrategy = await fetchBinanceStrategy\(\)/u);
  assert.match(component, /requiresAcknowledgement && !existingExposureRiskAcknowledged/u);
  assert.match(component, /entryExposure\.rulesValid === false/u);
  assert.match(component, /交易规则无效，服务端已禁止建仓/u);
  assert.match(component, /existingExposureRiskAcknowledged \? \{[\s\S]*existingExposureRiskAcknowledgement:/u);
  assert.match(component, /新增仓位不与已有资产隔离/u);
  assert.match(component, /confirmed fill 后失败恢复可能卖出\/平掉账户全部可交易 XAUT/u);
  assert.match(component, /Spot total/u);
  assert.match(component, /Spot free/u);
  assert.match(component, /Spot locked/u);
  assert.match(component, /Perp direction/u);
  assert.match(component, /setExistingExposureRiskAcknowledged\(false\)/u);
  assert.match(api, /ALLOW_ENTRY_AND_TOTAL_XAUT_RECOVERY/u);
});
