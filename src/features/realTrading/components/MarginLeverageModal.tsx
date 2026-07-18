import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import type { RealTradingMarginMode } from "../../../api/realTrading";
import { clampLeverage, marginModeLabel, type MarginLeverageSelection } from "../model/marginLeverage";

export function MarginLeverageModal({
  connected,
  onClose,
  onConfirm,
  open,
  selection,
  submitting,
}: {
  connected: boolean;
  onClose: () => void;
  onConfirm: (selection: Pick<MarginLeverageSelection, "leverage" | "marginMode">) => Promise<void> | void;
  open: boolean;
  selection: MarginLeverageSelection;
  submitting: boolean;
}) {
  const [draftMode, setDraftMode] = useState<RealTradingMarginMode>(selection.marginMode);
  const [draftLeverage, setDraftLeverage] = useState(selection.leverage);
  const [leverageInput, setLeverageInput] = useState(String(selection.leverage));
  const isolatedOnly = !selection.supportedMarginModes.includes("cross");
  const supportedMarginModesKey = selection.supportedMarginModes.join("|");
  const progress = selection.maxLeverage <= 1
    ? 100
    : ((draftLeverage - 1) / (selection.maxLeverage - 1)) * 100;

  useEffect(() => {
    if (!open) return;
    const nextLeverage = clampLeverage(selection.leverage, selection.maxLeverage);
    setDraftMode(selection.supportedMarginModes.includes(selection.marginMode) ? selection.marginMode : selection.supportedMarginModes[0]);
    setDraftLeverage(nextLeverage);
    setLeverageInput(String(nextLeverage));
  }, [open, selection.leverage, selection.marginMode, selection.maxLeverage, supportedMarginModesKey]);

  function updateLeverage(value: number) {
    const nextLeverage = clampLeverage(value, selection.maxLeverage);
    setDraftLeverage(nextLeverage);
    setLeverageInput(String(nextLeverage));
  }

  function updateLeverageInput(value: string) {
    setLeverageInput(value);
    const numericValue = Number(value);
    if (value.trim() && Number.isFinite(numericValue)) {
      setDraftLeverage(clampLeverage(numericValue, selection.maxLeverage));
    }
  }

  function normalizeLeverageInput() {
    const nextLeverage = clampLeverage(Number(leverageInput), selection.maxLeverage);
    setDraftLeverage(nextLeverage);
    setLeverageInput(String(nextLeverage));
    return nextLeverage;
  }

  function confirm() {
    const nextLeverage = normalizeLeverageInput();
    void onConfirm({ leverage: nextLeverage, marginMode: draftMode });
  }

  return (
    <Modal
      closeDisabled={submitting}
      open={open}
      title="保证金与杠杆"
      onClose={onClose}
      shellClassName="xh-margin-leverage-modal"
    >
      <div className="xh-margin-mode-section">
        <span className="xh-margin-leverage-label">保证金模式</span>
        <div aria-label="保证金模式" className="xh-margin-mode-options" role="group">
          {(["cross", "isolated"] as const).map((mode) => {
            const disabled = !selection.supportedMarginModes.includes(mode);
            return (
              <button
                aria-pressed={draftMode === mode}
                className={draftMode === mode ? "is-active" : ""}
                disabled={disabled || submitting}
                key={mode}
                onClick={() => setDraftMode(mode)}
                type="button"
              >
                {marginModeLabel(mode)}
              </button>
            );
          })}
        </div>
        {isolatedOnly ? <p className="xh-margin-mode-note">当前品种仅支持逐仓模式。</p> : null}
      </div>

      <div className="xh-margin-leverage-section">
        <div className="xh-margin-leverage-heading">
          <span className="xh-margin-leverage-label">杠杆</span>
          <span>1x–{selection.maxLeverage}x</span>
        </div>
        <div className="xh-margin-leverage-control">
          <label className="xh-margin-leverage-range">
            <span className="sr-only">杠杆滑杆</span>
            <span
              aria-hidden="true"
              className="xh-margin-leverage-track"
              style={{ "--leverage-progress": `${progress}%` } as CSSProperties}
            />
            <input
              disabled={submitting}
              max={selection.maxLeverage}
              min={1}
              onChange={(event) => updateLeverage(Number(event.currentTarget.value))}
              step={1}
              type="range"
              value={draftLeverage}
            />
          </label>
          <label className="xh-margin-leverage-input">
            <span className="sr-only">杠杆数值</span>
            <input
              disabled={submitting}
              inputMode="numeric"
              max={selection.maxLeverage}
              min={1}
              onBlur={normalizeLeverageInput}
              onChange={(event) => updateLeverageInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  normalizeLeverageInput();
                }
              }}
              step={1}
              type="number"
              value={leverageInput}
            />
            <b>x</b>
          </label>
        </div>
      </div>

      {!connected ? <p className="xh-margin-leverage-state">请先连接主账户钱包。</p> : null}
      <div className="xh-margin-leverage-actions">
        <Button disabled={submitting} onClick={onClose} type="button" variant="secondary">取消</Button>
        <Button disabled={!connected || submitting} onClick={confirm} type="button">
          {submitting ? "提交中" : "确认"}
        </Button>
      </div>
    </Modal>
  );
}
