import type { ArbitrageOpportunity } from "../model/types";
import { formatApr, formatBps, formatRatio, formatUsd } from "./formatters";

export type OpportunityFactor = {
  label: string;
  value: string;
  tone: "positive" | "neutral" | "negative";
};

type FactorInput = Pick<
  ArbitrageOpportunity,
  | "capacityUsd"
  | "confidence"
  | "currentGrossApr"
  | "disqualifiers"
  | "entryBasisBps"
  | "longLeg"
  | "netApr"
  | "opportunityDriver"
  | "persistenceRatio"
  | "recommendation"
  | "shortLeg"
  | "warnings"
>;

export function buildOpportunityFactors(opportunity: FactorInput): OpportunityFactor[] {
  return [
    {
      label: "收益",
      value: `等效净 APR ${formatApr(opportunity.netApr, true)}`,
      tone: opportunity.netApr > 0 ? "positive" : "negative",
    },
    {
      label: "持续性",
      value: `历史有利天数 ${formatRatio(opportunity.persistenceRatio)}`,
      tone: opportunity.persistenceRatio >= 0.7 ? "positive" : opportunity.persistenceRatio >= 0.5 ? "neutral" : "negative",
    },
    {
      label: "执行置信",
      value: confidenceText(opportunity.confidence),
      tone: opportunity.confidence === "high" ? "positive" : opportunity.confidence === "medium" ? "neutral" : "negative",
    },
    liquidityFactor(opportunity),
    driverFactor(opportunity),
    safetyFactor(opportunity),
  ];
}

function liquidityFactor(opportunity: FactorInput): OpportunityFactor {
  if (opportunity.longLeg.ask === null || opportunity.shortLeg.bid === null) {
    return { label: "流动性 / 报价", value: "关键买卖报价缺失", tone: "negative" };
  }
  if (opportunity.capacityUsd === null) {
    return { label: "流动性 / 报价", value: "报价完整，容量待更新", tone: "neutral" };
  }
  return {
    label: "流动性 / 报价",
    value: `参考容量 ${formatUsd(opportunity.capacityUsd)}`,
    tone: opportunity.capacityUsd >= 10_000 ? "positive" : "negative",
  };
}

function driverFactor(opportunity: FactorInput): OpportunityFactor {
  if (opportunity.opportunityDriver === "basis") {
    return {
      label: "基差",
      value: `当前入场基差 ${formatBps(opportunity.entryBasisBps, true)}`,
      tone: opportunity.entryBasisBps === null ? "neutral" : opportunity.entryBasisBps >= 0 ? "positive" : "negative",
    };
  }
  if (opportunity.opportunityDriver === "funding") {
    return {
      label: "资金费率",
      value: `当前费率差 ${formatApr(opportunity.currentGrossApr, true)}`,
      tone: opportunity.currentGrossApr > 0 ? "positive" : opportunity.currentGrossApr < 0 ? "negative" : "neutral",
    };
  }
  return {
    label: "基差 / 资金费率",
    value: `费率差 ${formatApr(opportunity.currentGrossApr, true)} · 基差 ${formatBps(opportunity.entryBasisBps, true)}`,
    tone: opportunity.currentGrossApr > 0 && (opportunity.entryBasisBps ?? 0) >= 0
      ? "positive"
      : opportunity.currentGrossApr < 0 && (opportunity.entryBasisBps ?? 0) < 0 ? "negative" : "neutral",
  };
}

function safetyFactor(opportunity: FactorInput): OpportunityFactor {
  if (opportunity.recommendation === "blocked" || opportunity.disqualifiers.length > 0) {
    return { label: "数据 / 执行安全", value: opportunity.disqualifiers[0] ?? "当前无法安全执行", tone: "negative" };
  }
  if (opportunity.warnings.length > 0) {
    return { label: "数据 / 执行安全", value: opportunity.warnings[0], tone: "neutral" };
  }
  return { label: "数据 / 执行安全", value: "当前未发现安全阻断", tone: "positive" };
}

function confidenceText(confidence: FactorInput["confidence"]) {
  return confidence === "high" ? "行情与执行数据置信度高" : confidence === "medium" ? "行情与执行数据置信度中等" : "行情或执行数据置信度低";
}
