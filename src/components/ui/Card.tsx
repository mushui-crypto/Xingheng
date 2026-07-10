import type { HTMLAttributes, ReactNode } from "react";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
};

export function Card({ children, className = "", ...props }: CardProps) {
  return (
    <div className={`min-w-0 border border-white/15 bg-panel p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] sm:p-5 ${className}`} {...props}>
      {children}
    </div>
  );
}
