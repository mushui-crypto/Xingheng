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
        className={`w-full border border-white/20 bg-black px-3.5 py-3 text-sm text-white outline-none transition placeholder:text-dim focus:border-white focus:bg-[#0d0d0d] disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
        {...props}
      />
      {error ? <span className="mt-1.5 block text-xs text-red-300">{error}</span> : null}
    </label>
  );
}
