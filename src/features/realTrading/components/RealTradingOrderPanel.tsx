import { AlertTriangle, KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Eip1193Provider } from "ethers";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";
import { Select } from "../../../components/ui/Select";
import { HyperliquidSessionSigner, normalizeSdkError } from "../lib/hyperliquidSdk";

type ActionState = "idle" | "initializing" | "authorizing" | "authorized" | "submitting";

export function RealTradingOrderPanel({
  assetId,
  connected,
  markPrice,
  maxLeverage,
  onSubmitted,
  priceDecimals = 2,
  provider,
  symbol,
  walletAddress,
}: {
  assetId?: number;
  connected: boolean;
  markPrice?: number | null;
  maxLeverage?: number;
  onSubmitted: () => void;
  priceDecimals?: number;
  provider?: Eip1193Provider;
  symbol: string;
  walletAddress: string;
}) {
  const signerRef = useRef<HyperliquidSessionSigner | null>(null);
  const [state, setState] = useState<ActionState>("idle");
  const [message, setMessage] = useState("");
  const [side, setSide] = useState("buy");
  const [orderType, setOrderType] = useState("limit");
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [leverage, setLeverage] = useState("5");
  const [cancelOid, setCancelOid] = useState("");
  const authorized = state === "authorized" || state === "submitting";
  const busy = state === "initializing" || state === "authorizing" || state === "submitting";
  const canAuthorize = connected && Boolean(provider) && typeof assetId === "number" && !busy;
  const canSubmit = authorized && !busy && typeof assetId === "number";

  useEffect(() => {
    signerRef.current = null;
    setState("idle");
    setMessage(connected ? "钱包地址已变化，需要重新初始化会话签名器。" : "");
  }, [connected, walletAddress]);

  useEffect(() => {
    if (orderType === "market" && typeof markPrice === "number") {
      const protectionPrice = markPrice * (side === "buy" ? 1.01 : 0.99);
      setPrice(protectionPrice.toFixed(priceDecimals));
    }
  }, [markPrice, orderType, priceDecimals, side]);

  async function authorizeSession() {
    if (!provider || !walletAddress) return;
    setMessage("");
    try {
      setState("initializing");
      const signer = await HyperliquidSessionSigner.create(provider, walletAddress);
      signerRef.current = signer;
      setState("authorizing");
      await signer.approveAgent();
      setState("authorized");
      setMessage(`会话 API wallet 已授权：${signer.agentAddress.slice(0, 6)}...${signer.agentAddress.slice(-4)}`);
    } catch (error) {
      signerRef.current = null;
      setState("idle");
      setMessage(normalizeSdkError(error));
    }
  }

  async function runAction(action: () => Promise<unknown>, success: string) {
    setMessage("");
    setState("submitting");
    try {
      await action();
      setState("authorized");
      setMessage(success);
      onSubmitted();
    } catch (error) {
      setState("authorized");
      setMessage(normalizeSdkError(error));
    }
  }

  async function submitOrder() {
    const signer = signerRef.current;
    if (!signer || typeof assetId !== "number") return;
    if (!price || !size || Number(price) <= 0 || Number(size) <= 0) {
      setMessage("请输入有效的价格和数量。");
      return;
    }
    await runAction(
      () => signer.placeOrder({ asset: assetId, isBuy: side === "buy", price, size, reduceOnly, market: orderType === "market" }),
      reduceOnly ? "reduce-only 平仓请求已发送。" : "真实订单请求已发送。",
    );
  }

  async function submitCancel() {
    const signer = signerRef.current;
    const oid = Number(cancelOid);
    if (!signer || typeof assetId !== "number") return;
    if (!Number.isSafeInteger(oid) || oid <= 0) {
      setMessage("请输入有效的订单 OID。");
      return;
    }
    await runAction(() => signer.cancelOrder(assetId, oid), "撤单请求已发送。");
  }

  async function submitLeverage() {
    const signer = signerRef.current;
    const value = Number(leverage);
    if (!signer || typeof assetId !== "number") return;
    if (!Number.isInteger(value) || value < 1 || value > (maxLeverage ?? 50)) {
      setMessage(`杠杆必须为 1-${maxLeverage ?? 50} 的整数。`);
      return;
    }
    await runAction(() => signer.updateLeverage(assetId, value), "杠杆更新请求已发送。");
  }

  return (
    <Card>
      <div className="xh-trade-panel-header">
        <h2>真实下单区</h2>
        <span>{authorized ? "会话已授权" : "本地签名"}</span>
      </div>
      <div className="mt-4 flex gap-2 border border-amber-400/30 bg-amber-400/10 p-3 text-sm leading-6 text-amber-100">
        <AlertTriangle className="mt-1 shrink-0" size={16} />
        <p>仅限 Hyperliquid Testnet。会话 API wallet 随页面刷新销毁，不写入浏览器存储，也不会把私钥发送给后端。</p>
      </div>

      <div className="mt-4 border-b border-line pb-4">
        <Button className="w-full" disabled={!canAuthorize || authorized} onClick={() => void authorizeSession()} variant="secondary">
          <KeyRound size={16} /> {state === "initializing" ? "初始化中" : state === "authorizing" ? "等待钱包授权" : authorized ? "会话已授权" : "初始化并授权会话"}
        </Button>
        <p className="mt-2 text-xs leading-5 text-muted">主账户签署一次 approveAgent；后续订单由仅存于当前页面内存的会话 signer 签署。</p>
      </div>

      <fieldset className="mt-4 space-y-3" disabled={!authorized || busy}>
        <div className="grid grid-cols-2 gap-3">
          <Select label="方向" options={[{ value: "buy", label: "买入 / 做多" }, { value: "sell", label: "卖出 / 做空" }]} value={side} onChange={(event) => setSide(event.target.value)} />
          <Select label="订单类型" options={[{ value: "limit", label: "限价单" }, { value: "market", label: "市价 IOC" }]} value={orderType} onChange={(event) => setOrderType(event.target.value)} />
        </div>
        <Input
          disabled={orderType === "market"}
          label={orderType === "market" ? "IOC 保护价格（Mark ±1%）" : "价格"}
          inputMode="decimal"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
        />
        <Input label="数量" inputMode="decimal" value={size} onChange={(event) => setSize(event.target.value)} />
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} type="checkbox" />
          Reduce-only 平仓
        </label>
        <Button className="w-full" disabled={!canSubmit} onClick={() => void submitOrder()} variant={side === "buy" ? "primary" : "danger"}>
          {state === "submitting" ? "签名并发送中" : reduceOnly ? "签名并平仓" : `签名并${side === "buy" ? "买入" : "卖出"}`}
        </Button>

        <div className="grid grid-cols-[1fr_auto] gap-2 border-t border-line pt-4">
          <Input label="订单 OID" inputMode="numeric" value={cancelOid} onChange={(event) => setCancelOid(event.target.value)} />
          <Button className="self-end" disabled={!canSubmit} onClick={() => void submitCancel()} variant="secondary">撤单</Button>
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Input label="全仓杠杆" inputMode="numeric" max={maxLeverage ?? 50} min={1} value={leverage} onChange={(event) => setLeverage(event.target.value)} />
          <Button className="self-end" disabled={!canSubmit} onClick={() => void submitLeverage()} variant="secondary">更新杠杆</Button>
        </div>
      </fieldset>

      <div className="mt-4 space-y-2 text-sm">
        <PanelMetric label="品种" value={symbol} />
        <PanelMetric label="网络" value="Hyperliquid Testnet" />
        <PanelMetric label="权限" value={authorized ? "会话 agent 已授权" : connected ? "主账户已连接，agent 未授权" : "未连接"} />
      </div>
      {message ? <p className={`mt-4 border p-3 text-sm ${authorized ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100" : "border-amber-400/30 bg-amber-400/10 text-amber-100"}`} role="status">{message}</p> : null}
    </Card>
  );
}

function PanelMetric({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3 border-b border-line pb-2"><span className="text-muted">{label}</span><strong className="text-right font-mono">{value}</strong></div>;
}
