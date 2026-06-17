type BadgeProps = {
  children: string;
  tone?: "success" | "neutral" | "danger";
};

const tones = {
  success: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  neutral: "border-slate-500/30 bg-slate-500/10 text-slate-200",
  danger: "border-red-400/30 bg-red-400/10 text-red-200",
};

export function Badge({ children, tone = "neutral" }: BadgeProps) {
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}
