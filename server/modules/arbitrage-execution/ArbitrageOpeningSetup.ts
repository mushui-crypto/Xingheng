import { createHash } from "node:crypto";
import type { ExecutionQuantityInput } from "../cex/ExecutionQuantityPlanner";
import type { ArbitrageExecutionMode } from "./ArbitrageExecutionDraft";

export type ArbitrageOpeningSetup = Readonly<{
  opportunityId: string;
  horizonDays: 90 | 365;
  quantityInput: ExecutionQuantityInput;
  executionMode: ArbitrageExecutionMode;
}>;

export function openingSetupSourcePlanId(setup: ArbitrageOpeningSetup) {
  return `execution-confirmation:${createHash("sha256").update(JSON.stringify(setup)).digest("hex")}`;
}
