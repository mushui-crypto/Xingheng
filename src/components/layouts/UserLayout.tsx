import { CandlestickChart, Home, LineChart, LogOut, UserRound } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { USER_AUTH_FAILED_EVENT } from "../../api/session";
import { useAuthStore } from "../../store/authStore";
import { useUserStore } from "../../store/userStore";

type UserLayoutProps = {
  children: ReactNode;
};

export function UserLayout({ children }: UserLayoutProps) {
  const navigate = useNavigate();
  const syncSession = useAuthStore((state) => state.syncSession);
  const logout = useAuthStore((state) => state.logout);
  const expireSession = useAuthStore((state) => state.expireSession);
  const currentUser = useUserStore((state) => state.currentUser);

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
      <header className="sticky top-0 z-30 border-b border-white/15 bg-black/92 backdrop-blur">
        <div className="mx-auto flex max-w-[1480px] flex-col gap-3 px-4 py-3 md:px-8 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center justify-between gap-4">
            <Brand />
            <button
              className="inline-flex items-center gap-2 border border-white/30 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white transition hover:bg-white hover:text-black lg:hidden"
              onClick={handleLogout}
            >
              <LogOut size={15} />
              退出
            </button>
          </div>
          <nav className="no-scrollbar flex gap-2 overflow-x-auto pb-1 lg:justify-center lg:pb-0">
            <TopLink to="/app/dashboard" icon={<Home size={16} />} label="首页" />
            <TopLink to="/app/markets" icon={<LineChart size={16} />} label="行情" />
            <TopLink to="/app/trading" icon={<CandlestickChart size={16} />} label="交易终端" />
            <TopLink to="/app/account" icon={<UserRound size={16} />} label="资金账户" />
          </nav>
          <div className="hidden items-center gap-4 lg:flex">
            <p className="max-w-[260px] truncate text-xs uppercase tracking-[0.16em] text-muted">
              USER <span className="text-white">{currentUser?.email}</span>
            </p>
            <button
              className="inline-flex items-center gap-2 border border-white/30 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white transition hover:bg-white hover:text-black"
              onClick={handleLogout}
            >
              <LogOut size={15} />
              退出
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1480px] px-4 py-5 md:px-8 md:py-8">{children}</main>
    </div>
  );

  function Brand() {
    return (
      <div className="flex items-center gap-3">
        <img
          alt="星衡 logo"
          className="h-9 w-9 border border-white/20 object-contain"
          src="/assets/xingheng-logo@2x.png"
        />
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.26em]">星衡</p>
          <p className="text-[11px] uppercase tracking-[0.16em] text-muted">Simulation console</p>
        </div>
      </div>
    );
  }
}

function TopLink({ to, icon, label }: { to: string; icon: ReactNode; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex shrink-0 items-center gap-2 border px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition md:px-4 ${
          isActive ? "border-white bg-white text-black" : "border-white/15 text-muted hover:border-white/50 hover:text-white"
        }`
      }
    >
      {icon}
      {label}
    </NavLink>
  );
}
