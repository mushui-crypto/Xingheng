import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import type {
  AccountOverview,
  FundingAccount,
  RealTradingAccount,
  RecentFundingActivity,
  SimulationAccountView,
} from "../../../api/walletApi";
import { Card } from "../../../components/ui/Card";
import { formatDateTime } from "../../../utils/validators";
import {
  formatNumber,
  formatOverviewStatus,
  formatSignedMoney,
  formatTimestamp,
  formatUserStatus,
  getOverviewStatusClass,
  getSignedToneClass,
  mapRecentFundingActivity,
} from "../lib/accountUtils";
import type {
  AccountSection,
  OverviewFundingRow,
  QuickAction,
} from "../model/types";
import { useUserStore } from "../../../store/userStore";
import { EmptyState, SectionHeader } from "./AccountDisplayPrimitives";
import {
  FundingInfo,
  OverviewActionButton,
  OverviewInfo,
} from "./AccountFeaturePrimitives";

export function OverviewSection({
  asset,
  accountOverview,
  recentFundingActivities,
  wallet,
  funding,
  realTradingAccount,
  simulationAccount,
  onActionChange,
  onSectionChange,
  user,
}: {
  asset: string;
  accountOverview: AccountOverview | null;
  recentFundingActivities: RecentFundingActivity[];
  wallet: FundingAccount | null;
  funding: FundingAccount | null;
  realTradingAccount: RealTradingAccount | null;
  simulationAccount: SimulationAccountView | null;
  onActionChange: (action: QuickAction | null) => void;
  onSectionChange: (section: AccountSection) => void;
  user: ReturnType<typeof useUserStore.getState>["currentUser"];
}) {
  const estimatedTotalAsset = accountOverview?.totalEquity ?? (wallet?.available ?? 0) + (funding?.balance ?? 0) + (realTradingAccount?.balance ?? 0);
  const simulationAsset = simulationAccount?.equity ?? 0;
  const simulationPnl = simulationAccount?.floatingPnl ?? simulationAccount?.unrealizedPnl ?? 0;
  const simulationTradeHref = simulationAccount?.id ? `/app/trading?symbol=BTCUSDT&simulationAccountId=${encodeURIComponent(simulationAccount.id)}` : "/app/trading?symbol=BTCUSDT";
  const recentTransactions = recentFundingActivities.map(mapRecentFundingActivity);

  return (
    <div className="xh-overview-stack">
      <Card className="xh-overview-panel">
        <SectionHeader title="账户总览" />
        <dl className="xh-overview-info-grid">
          <OverviewInfo label="用户 ID" value={user?.id || "-"} />
          <OverviewInfo label="邮箱" value={user?.email || "-"} />
          <OverviewInfo label="账号状态" value={formatUserStatus(user?.status)} />
          <OverviewInfo label="注册时间" value={user?.createdAt ? formatDateTime(user.createdAt) : "-"} />
        </dl>
      </Card>

      <AssetSummaryPanel
        title="预估总资产"
        asset={asset}
        value={estimatedTotalAsset}
        pnl={accountOverview?.accountTodayPnl ?? 0}
        actions={
          <>
            <OverviewActionButton label="充值" onClick={() => onActionChange("deposit")} />
            <OverviewActionButton label="提现" onClick={() => onActionChange("withdraw")} />
            <OverviewActionButton label="划转" onClick={() => onActionChange("transfer")} />
            <OverviewActionButton label="内部转账" onClick={() => onActionChange("internal-transfer")} />
          </>
        }
        infos={[]}
      />

      <AssetSummaryPanel
        title="模拟账户资产"
        asset={simulationAccount?.asset ?? asset}
        value={simulationAsset}
        changeLabel="浮动盈亏"
        pnl={simulationPnl}
        actions={
          <>
            <Link className="xh-overview-action" to={simulationTradeHref}>
              模拟交易
            </Link>
            <button className="xh-overview-action" type="button" onClick={() => onSectionChange("simulation")}>
              切换模拟账户
            </button>
          </>
        }
        infos={[]}
      />

      <Card className="xh-overview-panel overflow-hidden">
        <SectionHeader title="近期资金记录" />
        <OverviewFundingTable rows={recentTransactions} />
      </Card>
    </div>
  );
}

type AssetSummaryInfo = {
  label: string;
  value: string;
};

export function AssetSummaryPanel({
  actions,
  asset,
  changeLabel = "今日盈亏",
  className = "",
  infos,
  pnl,
  pnlText,
  title,
  value,
}: {
  actions?: ReactNode;
  asset: string;
  changeLabel?: string;
  className?: string;
  infos: AssetSummaryInfo[];
  pnl?: number;
  pnlText?: string;
  title: string;
  value: number;
}) {
  return (
    <section className={`xh-asset-summary-panel ${infos.length === 0 ? "is-compact" : ""} ${className}`}>
      <div className="xh-asset-summary-top">
        <div className="xh-asset-summary-main">
          <h2>{title}</h2>
          <div className="xh-asset-summary-value">
            <CountUpNumber className="xh-asset-summary-number" value={value} formatter={formatNumber} />
            <span className="xh-asset-summary-unit">{asset}</span>
          </div>
          <p className="xh-asset-summary-pnl">
            <span>{changeLabel}</span>
            <span className={getSignedToneClass(pnl ?? 0)}>
              {pnlText ? pnlText : (
                <CountUpNumber value={pnl ?? 0} formatter={(nextValue) => formatSignedMoney(nextValue, asset)} />
              )}
            </span>
          </p>
        </div>
        {actions ? <div className="xh-asset-summary-actions">{actions}</div> : null}
      </div>

      {infos.length > 0 ? (
        <div className="xh-asset-summary-info-grid">
          {infos.map((info) => (
            <FundingInfo key={info.label} label={info.label} value={info.value} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CountUpNumber({
  className,
  duration = 900,
  formatter,
  value,
}: {
  className?: string;
  duration?: number;
  formatter: (value: number) => string;
  value: number | null | undefined;
}) {
  const elementRef = useRef<HTMLSpanElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const hasAnimatedRef = useRef(false);
  const latestValueRef = useRef(value);
  const [displayValue, setDisplayValue] = useState<number | null>(typeof value === "number" ? 0 : null);

  useEffect(() => {
    latestValueRef.current = value;

    if (typeof value !== "number") {
      setDisplayValue(null);
      return;
    }

    if (!hasAnimatedRef.current && value === 0) {
      setDisplayValue(0);
      return;
    }

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReducedMotion || hasAnimatedRef.current) {
      hasAnimatedRef.current = true;
      setDisplayValue(value);
      return;
    }

    let observer: IntersectionObserver | null = null;

    const cancelFrame = () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };

    const animateCountUp = () => {
      if (hasAnimatedRef.current) {
        return;
      }

      hasAnimatedRef.current = true;
      cancelFrame();

      const targetValue = typeof latestValueRef.current === "number" ? latestValueRef.current : 0;
      const startTime = window.performance.now();

      const tick = (time: number) => {
        const progress = Math.min((time - startTime) / duration, 1);
        const easedProgress = 1 - Math.pow(1 - progress, 3);

        setDisplayValue(targetValue * easedProgress);

        if (progress < 1) {
          frameRef.current = window.requestAnimationFrame(tick);
        } else {
          frameRef.current = null;
          setDisplayValue(targetValue);
        }
      };

      frameRef.current = window.requestAnimationFrame(tick);
    };

    const node = elementRef.current;

    if (!node || typeof IntersectionObserver === "undefined") {
      animateCountUp();
      return () => {
        cancelFrame();
      };
    }

    observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          observer?.disconnect();
          animateCountUp();
        }
      },
      { threshold: 0.35 },
    );

    observer.observe(node);

    return () => {
      observer?.disconnect();
      cancelFrame();
    };
  }, [duration, value]);

  return (
    <span ref={elementRef} className={className}>
      {typeof displayValue === "number" ? formatter(displayValue) : "-"}
    </span>
  );
}

export function OverviewFundingTable({ rows }: { rows: OverviewFundingRow[] }) {
  return (
    <div className="xh-overview-table-wrap">
      <table className="xh-overview-table">
        <thead>
          <tr>
            <th>交易类型</th>
            <th>金额</th>
            <th>资产</th>
            <th>时间</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5}>
                <EmptyState title="暂无充提交易" />
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                <td>{row.type}</td>
                <td className="xh-overview-table-number">
                  <CountUpNumber value={row.amount} formatter={formatNumber} />
                </td>
                <td className="xh-overview-table-asset">{row.asset}</td>
                <td className="xh-overview-table-time">{formatTimestamp(row.time)}</td>
                <td className={`xh-overview-status ${getOverviewStatusClass(row.status)}`}>{formatOverviewStatus(row.status)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
