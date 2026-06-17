import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useConfigStore } from "../../store/configStore";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
};

const variantClasses = {
  primary: "text-[#07110f] hover:brightness-110",
  secondary: "border border-line bg-[#16202c] text-white hover:border-slate-500",
  ghost: "text-muted hover:bg-white/5 hover:text-white",
  danger: "border border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20",
};

export function Button({ children, className = "", variant = "primary", style, ...props }: ButtonProps) {
  const themeColor = useConfigStore((state) => state.config.themeColor);
  const primaryStyle = variant === "primary" ? { backgroundColor: themeColor, ...style } : style;

  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${variantClasses[variant]} ${className}`}
      style={primaryStyle}
      {...props}
    >
      {children}
    </button>
  );
}
