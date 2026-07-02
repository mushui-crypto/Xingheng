type BadgeProps = {
  children: string;
  tone?: "success" | "neutral" | "danger";
};

const tones = {
  success: "border-white/40 bg-white/10 text-white",
  neutral: "border-white/20 bg-panel2 text-slate-200",
  danger: "border-red-400/40 bg-black text-red-200",
};

export function Badge({ children, tone = "neutral" }: BadgeProps) {
  return (
    <span className={`inline-flex border px-2.5 py-1 text-xs font-medium uppercase tracking-[0.08em] ${tones[tone]}`}>
      {children}
    </span>
  );
}
