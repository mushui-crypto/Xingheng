import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { bscTestnetLabel } from "../model/constants";

export function AccountModalForm({ children }: { children: ReactNode }) {
  return <div className="xh-account-modal-form">{children}</div>;
}

export function AccountModalValue({ label, mono = false, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <div className="xh-account-modal-field">
      <p>{label}</p>
      <div className={`xh-account-modal-value ${mono ? "is-mono" : ""}`}>{value}</div>
    </div>
  );
}

export function AccountModalInput({ label, className = "", ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="xh-account-modal-field">
      <span>{label}</span>
      <input className={`xh-account-modal-control ${className}`} {...props} />
    </label>
  );
}

export function AccountModalSelect({
  label,
  options,
  className = "",
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; options: Array<{ value: string; label: string; disabled?: boolean }> }) {
  return (
    <label className="xh-account-modal-field">
      <span>{label}</span>
      <span className="xh-account-modal-select-wrap">
        <select className={`xh-account-modal-control ${className}`} {...props}>
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

export function AccountModalFeedback({ children }: { children: ReactNode }) {
  return <p className="xh-account-modal-feedback">{children}</p>;
}

export function WalletNetworkLabel() {
  return (
    <div className="xh-wallet-network">
      <p>钱包网络</p>
      <span>{bscTestnetLabel}</span>
    </div>
  );
}

export function WalletActionButton({ disabled = false, icon, label, onClick }: { disabled?: boolean; icon?: ReactNode; label: string; onClick?: () => void }) {
  return (
    <button className="xh-wallet-action" disabled={disabled} type="button" onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}
