import { useCallback, useEffect, useRef, useState } from "react";
import { formatPrice } from "../../../utils/price";

export type TradingToastTone = "error" | "info" | "success" | "warning";

export type TradingToastState = {
  id: number;
  message: string;
  tone: TradingToastTone;
};

const toastLabels: Record<TradingToastTone, string> = {
  error: "错误",
  info: "提示",
  success: "成功",
  warning: "提醒",
};

export function useTradingToast(autoDismissMs = 4_500) {
  const [toast, setToast] = useState<TradingToastState | null>(null);
  const sequenceRef = useRef(0);
  const lastToastRef = useRef<{ key: string; shownAt: number } | null>(null);

  const dismissToast = useCallback(() => setToast(null), []);
  const showToast = useCallback((message: string, tone: TradingToastTone = "info") => {
    const normalizedMessage = message.trim();
    if (!normalizedMessage) return;
    const now = Date.now();
    const key = `${tone}:${normalizedMessage}`;
    if (lastToastRef.current?.key === key && now - lastToastRef.current.shownAt < 1_200) return;
    lastToastRef.current = { key, shownAt: now };
    sequenceRef.current += 1;
    setToast({ id: sequenceRef.current, message: normalizedMessage, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => {
      setToast((current) => current?.id === toast.id ? null : current);
    }, autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [autoDismissMs, toast]);

  return { dismissToast, showToast, toast };
}

export function Toast(props: { message: string } | { onDismiss: () => void; toast: TradingToastState | null }) {
  if ("message" in props) {
    return <div className={`xh-toast ${props.message ? "is-visible" : ""}`} aria-live="polite" aria-atomic="true">{props.message}</div>;
  }
  const { onDismiss, toast } = props;
  if (!toast) return null;
  return (
    <div
      aria-atomic="true"
      aria-live={toast.tone === "error" ? "assertive" : "polite"}
      className={`xh-toast is-visible is-${toast.tone}`}
      role={toast.tone === "error" ? "alert" : "status"}
    >
      <div className="xh-toast-copy">
        <strong>{toastLabels[toast.tone]}</strong>
        <span>{toast.message}</span>
      </div>
      <button aria-label="关闭提示" onClick={onDismiss} type="button">关闭</button>
    </div>
  );
}

export function Quote({ label, value, digits }: { label: string; value?: number; digits: number }) {
  return (
    <div className="border border-line bg-black p-3">
      <p className="text-xs uppercase text-muted">{label}</p>
      <p className="mt-2 text-lg font-semibold">{formatPrice(value, digits)}</p>
    </div>
  );
}
