import type { ArbitrageHorizon } from "../features/arbitrage/model/types";
import { requestJson } from "./httpClient";

export type ExecutionQuantityInput =
  | Readonly<{ mode: "NOTIONAL_USDT"; amountUsdt: string }>
  | Readonly<{ mode: "ASSET_QUANTITY"; quantity: string }>;

export type ExecutionDraftPlanning =
  | Readonly<{ status: "NOT_REQUESTED" }>
  | Readonly<{
      status: "PLANNED";
      plan: Readonly<{
        sizingPrice: string;
        plannedAssetQuantity: Readonly<{ asset: Readonly<{ symbol: string }>; quantity: string }>;
        plannedVenueQuantity?: string;
        estimatedNotionalUsdt: string;
      }>;
    }>
  | Readonly<{
      status: "UNAVAILABLE" | "ERROR";
      errorCode: string;
      minimumRequiredAssetQuantity?: string;
      minimumRequiredVenueQuantity?: string;
      minimumRequiredNotionalUsdt?: string;
      nearestLegalAssetQuantity?: string;
    }>;

export type ArbitrageExecutionDraftLeg = Readonly<{
  legId: string;
  role: "LONG" | "SHORT";
  venue: "binance" | "okx" | "bybit" | "bitget";
  instrumentId: string;
  providerSymbol: string | null;
  side: "buy" | "sell";
  marketType: "spot" | "perpetual";
  quote: Readonly<{ bid: string; ask: string; updatedAt: number }> | null;
  tradingRules: Readonly<{
    quantityStep: string;
    minQuantity: string;
    priceTick: string;
    minNotional?: string;
    contractSize?: string;
  }> | null;
  capability: Readonly<{
    status: "AVAILABLE" | "UNAVAILABLE";
    reasonCode: "AVAILABLE" | "EXECUTION_CAPABILITY_NOT_IMPLEMENTED" | "CREDENTIAL_NOT_CONFIGURED";
  }>;
  planning: ExecutionDraftPlanning;
  executionAvailable: boolean;
}>;

export type ArbitrageExecutionDraft = Readonly<{
  opportunityId: string;
  sourceIdentity: string;
  sourceSnapshotGeneratedAt: number;
  horizonDays: ArbitrageHorizon;
  strategyType: "PERPETUAL_PERPETUAL" | "SPOT_PERPETUAL";
  quantityInput?: ExecutionQuantityInput;
  legs: readonly [ArbitrageExecutionDraftLeg, ArbitrageExecutionDraftLeg];
  allLegsExecutable: boolean;
  generatedAt: number;
}>;

export function fetchArbitrageExecutionDraft(
  opportunityId: string,
  horizonDays: ArbitrageHorizon,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ opportunityId, horizonDays: String(horizonDays) });
  return requestJson<ArbitrageExecutionDraft>(
    `/api/arbitrage-execution/draft?${query.toString()}`,
    "套利执行草案加载失败。",
    { init: { signal }, userAuthFailure: true },
  );
}

export function previewArbitrageExecutionDraft(
  opportunityId: string,
  horizonDays: ArbitrageHorizon,
  quantityInput: ExecutionQuantityInput,
  signal?: AbortSignal,
) {
  return requestJson<ArbitrageExecutionDraft>(
    "/api/arbitrage-execution/draft/preview",
    "套利数量计划生成失败。",
    {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opportunityId, horizonDays, quantityInput }),
        signal,
      },
      userAuthFailure: true,
    },
  );
}
