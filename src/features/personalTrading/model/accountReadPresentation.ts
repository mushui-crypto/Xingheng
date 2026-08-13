import type {
  AccountReadAccountType,
  AccountReadFailureKind,
  AccountReadPermissionStatus,
  AccountReadSnapshot,
} from "../../../api/accountRead";

export function permissionLabel(value: AccountReadPermissionStatus) {
  if (value === "ENABLED") return "已启用";
  if (value === "DISABLED") return "未启用";
  return "无法确认";
}

export function accountTypeLabel(value: AccountReadAccountType) {
  if (value === "spot") return "现货";
  if (value === "derivatives") return "衍生品";
  if (value === "unified") return "统一账户";
  return "未知账户类型";
}

export function accountModeLabel(snapshot: AccountReadSnapshot) {
  if (snapshot.accountMode) {
    const segments = snapshot.accountMode.toLowerCase().split(":");
    const labels = segments.map((segment) => accountModeSegmentLabels[segment]).filter(Boolean);
    if (labels.length === segments.length) return labels.join(" · ");
  }
  return snapshot.accountTypes.map(accountTypeLabel).join(" / ") || "无法确认";
}

const accountModeSegmentLabels: Record<string, string> = {
  spot: "现货",
  futures: "衍生品",
  single_asset_one_way: "单资产 · 单向持仓",
  single_asset_hedge: "单资产 · 双向持仓",
  multi_assets_one_way: "多资产 · 单向持仓",
  multi_assets_hedge: "多资产 · 双向持仓",
  multi_currency_margin: "多币种保证金",
  portfolio_margin: "组合保证金",
  classic: "经典账户",
  unified_1: "统一账户 1.0",
  unified_1_pro: "统一账户 1.0 专业版",
  unified_2: "统一账户 2.0",
  unified_2_pro: "统一账户 2.0 专业版",
  unified: "统一账户",
  hybrid: "混合统一账户",
  regular_margin: "常规保证金",
  isolated_margin: "逐仓保证金",
  advanced: "高级",
  multi_assets: "多资产",
  unknown: "无法确认",
  unknown_margin: "保证金模式无法确认",
};

export function accountFailureLabel(kind: AccountReadFailureKind) {
  if (kind === "missing_credential") return "尚未配置账户凭证";
  if (kind === "validation_failed") return "账户凭证验证失败";
  if (kind === "provider_failed") return "交易所账户读取失败";
  return "账户读取暂时不可用";
}

export function nullableAmount(value: number | null) {
  return value === null ? "暂无可靠数据" : formatNumber(value);
}

export function estimatedValue(value: number | null) {
  return value === null ? "暂无估值" : `${formatNumber(value)} USDT`;
}

export function estimatedTotalValue(snapshot: AccountReadSnapshot) {
  if (snapshot.estimatedTotalValueUsdt === null) return "暂无估值";
  const suffix = snapshot.valuationCoverage === "PARTIAL" ? "（部分资产）" : "";
  return `${formatNumber(snapshot.estimatedTotalValueUsdt)} USDT${suffix}`;
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 8 }).format(value);
}

export function formatSyncTime(value: number) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
