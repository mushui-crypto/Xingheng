import { useEffect, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { USER_AUTH_FAILED_EVENT } from "../../api/session";
import { useAuthStore } from "../../store/authStore";
import { useUserStore } from "../../store/userStore";

type UserLayoutProps = {
  children: ReactNode;
};

export function UserLayout({ children }: UserLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useAuthStore((state) => state.logout);
  const expireSession = useAuthStore((state) => state.expireSession);
  const currentUser = useUserStore((state) => state.currentUser);
  const isAccountPage = location.pathname.startsWith("/app/account");
  const isTradingPage =
    location.pathname.startsWith("/app/trade") ||
    location.pathname.startsWith("/app/demo") ||
    location.pathname.startsWith("/app/trading");

  useEffect(() => {
    const handleAuthFailure = () => {
      expireSession();
      navigate("/login", { replace: true });
    };
    window.addEventListener(USER_AUTH_FAILED_EVENT, handleAuthFailure);
    return () => window.removeEventListener(USER_AUTH_FAILED_EVENT, handleAuthFailure);
  }, [expireSession, navigate]);

  const handleLogout = () => {
    logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="min-h-screen min-w-0 overflow-x-hidden bg-shell text-white">
      <header className="sticky top-0 z-30 h-[60px] border-b border-[#2b2b2b] bg-black">
        <div className="flex h-full w-full min-w-0 items-center justify-between gap-3 overflow-hidden px-3 py-2.5 sm:px-4 md:gap-6 md:px-8">
          <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-6 lg:gap-10">
            <Brand />
            <nav className="no-scrollbar flex items-center gap-2 overflow-x-auto">
              <TopLink to="/app/dashboard" label="首页" />
              <TopLink to="/app/markets" label="行情" />
              <TopLink to="/app/trade" label="真实交易" />
              <TopLink to="/app/demo" label="模拟交易" />
              <TopLink to="/app/strategy" label="策略交易" />
              <TopLink to="/app/account" label="账户总览" />
            </nav>
          </div>
          <div className="hidden shrink-0 items-center gap-[18px] md:flex">
            <div className="max-w-[260px] truncate border border-[#2b2b2b] bg-black px-4 py-2.5 text-[13px] font-medium leading-none text-[#f5f5f5]">
              {currentUser ? currentUser.email.toUpperCase() : "LOADING"}
            </div>
            <button
              className="inline-flex items-center justify-center border border-[#2b2b2b] bg-black px-4 py-2.5 text-[13px] font-medium leading-none text-[#f5f5f5] transition hover:border-white/40 hover:bg-white/[0.04]"
              onClick={handleLogout}
            >
              退出
            </button>
          </div>
        </div>
      </header>
      <main className={isAccountPage || isTradingPage ? "min-w-0 w-full bg-[#080808] p-0" : "mx-auto min-w-0 max-w-[1480px] px-4 py-5 md:px-8 md:py-8"}>{children}</main>
    </div>
  );

  function Brand() {
    return (
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <img
          alt="星衡 logo"
          className="h-8 w-8 object-contain sm:h-9 sm:w-9"
          src="/assets/xingheng-logo@2x.png"
        />
        <p className="hidden whitespace-nowrap text-[15px] font-bold leading-none text-[#f5f5f5] sm:block">StellaX</p>
      </div>
    );
  }
}

function TopLink({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex min-h-11 shrink-0 items-center justify-center px-3 py-2.5 text-[13px] font-medium leading-none transition sm:px-4 ${
          isActive ? "bg-[#f5f5f5] text-black" : "bg-black text-[#f5f5f5] hover:bg-white/[0.06]"
        }`
      }
    >
      {label}
    </NavLink>
  );
}
