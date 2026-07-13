import type { InputHTMLAttributes, ReactNode } from "react";

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: ReactNode;
};

export function Checkbox({ className = "", disabled, label, ...props }: CheckboxProps) {
  return (
    <label className={`xh-checkbox ${disabled ? "is-disabled" : ""} ${className}`.trim()}>
      <input disabled={disabled} type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
}
