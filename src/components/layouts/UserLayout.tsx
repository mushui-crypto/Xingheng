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
  const syncSession = useAuthStore((state) => state.syncSession);
  const logout = useAuthStore((state) => state.logout);
  const expireSession = useAuthStore((state) => state.expireSession);
  const currentUser = useUserStore((state) => state.currentUser);
  const isAccountPage = location.pathname.startsWith("/app/account");

  useEffect(() => {
    void syncSession();
  }, [syncSession]);

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
    <div className="min-h-screen bg-shell text-white">
      <header className="sticky top-0 z-30 h-[60px] border border-[#2b2b2b] bg-black">
        <div className="flex h-full w-full items-center justify-between gap-6 overflow-hidden px-4 py-2.5 md:px-8">
          <div className="flex min-w-0 items-center gap-6 lg:gap-10">
            <Brand />
            <nav className="no-scrollbar flex items-center gap-2 overflow-x-auto">
              <TopLink to="/app/dashboard" label="首页" />
              <TopLink to="/app/markets" label="行情" />
              <TopLink to="/app/trading" label="交易终端" />
              <TopLink to="/app/account" label="账户总览" />
            </nav>
          </div>
          <div className="hidden shrink-0 items-center gap-[18px] md:flex">
            <div className="max-w-[260px] truncate border border-[#2b2b2b] bg-black px-4 py-2.5 text-[13px] font-medium leading-none text-[#f5f5f5]">
              {(currentUser?.email ?? "TEST@TEST.COM").toUpperCase()}
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
      <main className={isAccountPage ? "w-full bg-[#080808] p-0" : "mx-auto max-w-[1480px] px-4 py-5 md:px-8 md:py-8"}>{children}</main>
    </div>
  );

  function Brand() {
    return (
      <div className="flex items-center gap-3">
        <img
          alt="星衡 logo"
          className="h-9 w-9 object-contain"
          src="/assets/xingheng-logo@2x.png"
        />
        <p className="whitespace-nowrap text-[15px] font-bold leading-none text-[#f5f5f5]">StellaX</p>
      </div>
    );
  }
}

function TopLink({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex shrink-0 items-center justify-center px-4 py-2.5 text-[13px] font-medium leading-none transition ${
          isActive ? "bg-[#f5f5f5] text-black" : "bg-black text-[#f5f5f5] hover:bg-white/[0.06]"
        }`
      }
    >
      {label}
    </NavLink>
  );
}
