import { ArrowRight, Eye, EyeOff } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";

export type AuthFeedbackTone = "success" | "error";
export type AuthFeedbackState = {
  tone: AuthFeedbackTone;
  text: string;
};

const authInputClass =
  "xh-auth-input h-14 w-full rounded border border-[#2e2e2e] bg-[rgba(14,14,14,0.96)] px-4 text-base text-white outline-none transition placeholder:text-[#919191] focus:border-white/45 sm:h-[68px] sm:px-6";
const authPasswordInputClass = `${authInputClass} pr-14`;

export function AuthHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-8">
      <h1 className="text-[clamp(1.75rem,7vw,2rem)] font-medium leading-tight tracking-[0.2px]">{title}</h1>
      <p className="mt-2 text-[15px] leading-6 text-[#919191]">{subtitle}</p>
    </div>
  );
}

export function AuthInput({
  label,
  placeholder,
  type = "text",
  autoComplete,
  value,
  onChange,
  minLength,
}: {
  label: string;
  placeholder: string;
  type?: string;
  autoComplete?: string;
  value: string;
  onChange: (value: string) => void;
  minLength?: number;
}) {
  return (
    <label className="block">
      <span className="mb-3 block text-sm font-medium uppercase tracking-[1.4px] text-white">{label}</span>
      <input
        className={authInputClass}
        placeholder={placeholder}
        type={type}
        autoComplete={autoComplete}
        value={value}
        minLength={minLength}
        onChange={(event) => onChange(event.target.value)}
        required
      />
    </label>
  );
}

export function AuthCodeInput({
  label,
  placeholder,
  value,
  onChange,
  buttonText,
  buttonDisabled,
  onSend,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  buttonText: string;
  buttonDisabled: boolean;
  onSend: () => void;
}) {
  return (
    <label className="block">
      <span className="mb-3 block text-sm font-medium uppercase tracking-[1.4px] text-white">{label}</span>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          className={authInputClass}
          placeholder={placeholder}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={value}
          maxLength={6}
          onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
          required
        />
        <button
          className="min-h-11 rounded border border-white/30 px-4 py-3 text-sm font-medium uppercase tracking-[1px] text-white transition hover:border-white disabled:cursor-not-allowed disabled:opacity-50 sm:h-[68px] sm:min-w-[132px] sm:py-0"
          type="button"
          disabled={buttonDisabled}
          onClick={onSend}
        >
          {buttonText}
        </button>
      </div>
    </label>
  );
}

export function AuthPasswordInput({
  label,
  placeholder,
  autoComplete,
  value,
  onChange,
  minLength,
  visible,
  onToggleVisible,
}: {
  label: string;
  placeholder: string;
  autoComplete?: string;
  value: string;
  onChange: (value: string) => void;
  minLength?: number;
  visible: boolean;
  onToggleVisible: () => void;
}) {
  return (
    <label className="block">
      <span className="mb-3 block text-sm font-medium uppercase tracking-[1.4px] text-white">{label}</span>
      <div className="relative">
        <input
          className={authPasswordInputClass}
          placeholder={placeholder}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          minLength={minLength}
          onChange={(event) => onChange(event.target.value)}
          required
        />
        <button
          className="absolute right-5 top-1/2 -translate-y-1/2 text-white/75 transition hover:text-white"
          type="button"
          onClick={onToggleVisible}
          aria-label={visible ? "Hide password" : "Show password"}
        >
          {visible ? <Eye size={19} /> : <EyeOff size={19} />}
        </button>
      </div>
    </label>
  );
}

export function AuthFeedback({ feedback }: { feedback: AuthFeedbackState }) {
  const toneClass =
    feedback.tone === "success"
      ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-100"
      : "border-red-400/35 bg-red-500/10 text-red-200";
  return (
    <p className={`border p-3 text-sm ${toneClass}`} role="status" aria-live="polite">
      {feedback.text}
    </p>
  );
}

export function AuthInlineNote({ children }: { children: ReactNode }) {
  return <div className="border border-white/10 bg-white/[0.03] p-3 text-sm leading-6 text-[#b8b8b8]">{children}</div>;
}

export function AuthSubmitButton({ children, disabled = false }: { children: string; disabled?: boolean }) {
  return (
    <button
      className="relative flex min-h-14 w-full items-center justify-center rounded-[3px] border border-white bg-black px-6 py-4 text-[16px] font-medium tracking-[1.4px] text-white transition hover:bg-white hover:text-black disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-black disabled:hover:text-white sm:min-h-[72px] sm:text-[17px] sm:tracking-[2px]"
      type="submit"
      disabled={disabled}
    >
      {children}
      <ArrowRight className="absolute right-6" size={22} />
    </button>
  );
}

export function useCooldownTimer(cooldown: number, setCooldown: (value: number) => void) {
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown(Math.max(0, cooldown - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown, setCooldown]);
}
