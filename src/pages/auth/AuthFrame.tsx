import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AuthVisual } from "../../components/auth/AuthVisual";

type AuthFrameProps = {
  activeTab: "login" | "register";
  children: ReactNode;
};

export function AuthFrame({ activeTab, children }: AuthFrameProps) {
  return (
    <div className="min-h-screen overflow-hidden bg-black text-white" style={{ fontFamily: "Poppins, Inter, sans-serif" }}>
      <div className="mx-auto grid min-h-dvh w-full max-w-[1920px] lg:grid-cols-[minmax(0,1fr)_minmax(520px,720px)]">
        <AuthVisual className="hidden lg:block" />

        <section className="relative flex min-h-dvh min-w-0 items-start justify-start px-4 py-8 sm:px-6 sm:py-10 lg:block lg:px-0 lg:py-0">
          <div className="absolute left-[529.48px] top-[77.28px] hidden h-px w-[118px] bg-[rgba(199,199,199,0.18)] lg:block" />
          <div className="absolute left-[623.48px] top-[51.28px] hidden h-px w-6 bg-[rgba(199,199,199,0.45)] lg:block" />
          <div className="absolute left-[623.48px] top-[51.28px] hidden h-6 w-px bg-[rgba(199,199,199,0.45)] lg:block" />
          <div className="absolute left-[633.78px] top-[1015.27px] hidden h-px w-6 bg-[rgba(199,199,199,0.45)] lg:block" />
          <div className="absolute left-[633.78px] top-[991.27px] hidden h-6 w-px bg-[rgba(199,199,199,0.45)] lg:block" />
          <div className="mx-auto w-full max-w-[548px] lg:absolute lg:left-[clamp(48px,5vw,80px)] lg:top-[clamp(96px,14vh,160px)] lg:mx-0 lg:max-w-[calc(100%_-_96px)]">
            <nav className="relative mb-6 flex h-auto min-h-[47px] max-w-full items-start gap-4 overflow-x-auto border-b border-[rgba(199,199,199,0.25)] text-[16px] uppercase sm:gap-6 sm:text-[18px]">
              <AuthTab active={activeTab === "login"} to="/login">
                Sign in
              </AuthTab>
              <AuthTab active={activeTab === "register"} to="/register">
                Create account
              </AuthTab>
            </nav>
            {children}
          </div>
        </section>
      </div>
    </div>
  );
}

function AuthTab({
  active,
  to,
  children,
}: {
  active: boolean;
  to: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={`relative flex h-[47px] shrink-0 items-center justify-start whitespace-nowrap border-b-2 border-transparent py-[10px] text-[16px] font-medium not-italic uppercase leading-normal tracking-[1.2px] transition sm:text-[18px] sm:tracking-[1.6px] ${
        active ? "text-white" : "text-[rgba(145,145,145,0.82)] hover:text-white/70"
      }`}
    >
      {children}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-x-0 bottom-[-1px] h-0.5 origin-left bg-[rgba(199,199,199,0.9)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          active ? "scale-x-100" : "scale-x-0"
        }`}
      />
    </Link>
  );
}
