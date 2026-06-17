import type { InputHTMLAttributes } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
};

export function Input({ label, error, className = "", ...props }: InputProps) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-slate-300">{label}</span>
      <input
        className={`w-full rounded-lg border border-line bg-[#0f1722] px-3.5 py-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-emerald-400 ${className}`}
        {...props}
      />
      {error ? <span className="mt-1.5 block text-xs text-red-300">{error}</span> : null}
    </label>
  );
}
