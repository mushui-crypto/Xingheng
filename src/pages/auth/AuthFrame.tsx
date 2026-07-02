import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { StarBorder } from "../../components/ui/StarBorder";

type AuthFrameProps = {
  activeTab: "login" | "register";
  children: ReactNode;
};

export function AuthFrame({ activeTab, children }: AuthFrameProps) {
  return (
    <div className="min-h-screen overflow-hidden bg-black text-white" style={{ fontFamily: "Poppins, Inter, sans-serif" }}>
      <div className="min-h-screen lg:grid lg:h-[1080px] lg:min-h-0 lg:w-[1920px] lg:grid-cols-[1200px_720px]">
        <section className="relative hidden h-[1080px] w-[1200px] overflow-hidden lg:block">
          <div className="absolute left-0 top-0 h-[1080px] w-[1200px] overflow-hidden">
            <StarBorder className="left-0 top-[-44px] z-0 h-[1158px] w-[1070.74px]" color="rgba(255,255,255,1)" shape="ellipse" speed="6s" thickness={1} />
            <StarBorder className="left-[80px] top-[80px] z-[1] h-[920px] w-[1040px]" color="rgba(255,255,255,1)" shape="rounded" speed="9s" thickness={1} />
            <img
              alt=""
              aria-hidden="true"
              className="pointer-events-none absolute left-[1197px] top-[60px] z-20 h-[960px] w-[3px] max-w-none object-fill"
              src="/assets/xingheng-axis@2x.png"
            />
            <img
              alt=""
              aria-hidden="true"
              className="pointer-events-none absolute left-[428px] top-[179px] h-[722.5px] w-[343.83px] max-w-none object-fill opacity-90"
              src="/assets/xingheng-constellation@2x.png"
            />
            <img
              alt="星衡 logo"
              className="pointer-events-none absolute left-[204px] top-[464px] z-10 h-[152px] w-[791.5px] max-w-none object-fill"
              src="/assets/xingheng-lockup@2x.png"
            />
          </div>
        </section>

        <section className="relative flex min-h-screen items-start justify-start px-6 py-10 lg:block lg:h-[1080px] lg:w-[720px] lg:min-h-0 lg:px-0 lg:py-0">
          <div className="absolute left-[529.48px] top-[77.28px] hidden h-px w-[118px] bg-[rgba(199,199,199,0.18)] lg:block" />
          <div className="absolute left-[623.48px] top-[51.28px] hidden h-px w-6 bg-[rgba(199,199,199,0.45)] lg:block" />
          <div className="absolute left-[623.48px] top-[51.28px] hidden h-6 w-px bg-[rgba(199,199,199,0.45)] lg:block" />
          <div className="absolute left-[633.78px] top-[1015.27px] hidden h-px w-6 bg-[rgba(199,199,199,0.45)] lg:block" />
          <div className="absolute left-[633.78px] top-[991.27px] hidden h-6 w-px bg-[rgba(199,199,199,0.45)] lg:block" />
          <div className="mx-auto w-full max-w-[548px] lg:absolute lg:left-[80px] lg:top-[160px] lg:mx-0">
            <nav className="relative mb-6 flex h-[47px] items-start gap-6 border-b border-[rgba(199,199,199,0.25)] text-[18px] uppercase">
              <AuthTab active={activeTab === "login"} to="/login" widthClass="w-[99px]">
                Sign in
              </AuthTab>
              <AuthTab active={activeTab === "register"} to="/register" widthClass="w-[204px]">
                Create account
              </AuthTab>
              <span
                aria-hidden="true"
                className={`absolute bottom-0 left-0 h-0.5 bg-[rgba(199,199,199,0.9)] transition-[transform,width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                  activeTab === "login" ? "w-[99px] translate-x-0" : "w-[204px] translate-x-[123px]"
                }`}
              />
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
  widthClass,
}: {
  active: boolean;
  to: string;
  children: ReactNode;
  widthClass: string;
}) {
  return (
    <Link
      to={to}
      className={`flex h-[47px] shrink-0 items-center justify-start whitespace-nowrap py-[10px] text-[18px] font-medium not-italic uppercase leading-normal tracking-[1.6px] transition ${widthClass} ${
        active ? "text-white" : "text-[rgba(145,145,145,0.82)] hover:text-white/70"
      }`}
    >
      {children}
    </Link>
  );
}
