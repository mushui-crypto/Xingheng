import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
};

const variantClasses = {
  primary: "border border-white bg-white text-black hover:bg-black hover:text-white active:bg-white active:text-black",
  secondary: "border border-white/25 bg-black text-white hover:border-white hover:bg-white/[0.04]",
  ghost: "border border-transparent text-muted hover:border-white/15 hover:bg-white/[0.035] hover:text-white",
  danger: "border border-red-400/60 bg-black text-red-200 hover:bg-red-500/15",
};

export function Button({ children, className = "", variant = "primary", style, ...props }: ButtonProps) {
  return (
    <button
      className={`inline-flex min-h-11 min-w-0 items-center justify-center gap-2 whitespace-nowrap px-4 py-2.5 text-sm font-semibold uppercase tracking-[0.08em] transition active:translate-y-px disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-50 ${variantClasses[variant]} ${className}`}
      style={style}
      {...props}
    >
      {children}
    </button>
  );
}
