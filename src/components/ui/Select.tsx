import type { SelectHTMLAttributes } from "react";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> & {
  label: string;
  options: SelectOption[];
  error?: string;
  hideLabel?: boolean;
};

export function Select({ label, options, error, hideLabel = false, className = "", ...props }: SelectProps) {
  return (
    <label className="block">
      <span className={hideLabel ? "sr-only" : "mb-2 block text-sm font-medium text-slate-300"}>{label}</span>
      <span className="relative block">
        <select
          className={`w-full appearance-none border border-white/20 bg-black px-3.5 py-3 pr-12 text-sm text-white outline-none transition focus:border-white focus:bg-[#0d0d0d] disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <span aria-hidden="true" className="pointer-events-none absolute right-5 top-1/2 h-2 w-2 -translate-y-[60%] rotate-45 border-b border-r border-slate-400" />
      </span>
      {error ? <span className="mt-1.5 block text-xs text-red-300">{error}</span> : null}
    </label>
  );
}
