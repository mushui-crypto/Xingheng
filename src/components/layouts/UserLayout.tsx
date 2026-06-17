import { CandlestickChart, Home, LineChart, LogOut, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuthStore } from "../../store/authStore";
import { useConfigStore } from "../../store/configStore";
import { useUserStore } from "../../store/userStore";

type UserLayoutProps = {
  children: ReactNode;
};

export function UserLayout({ children }: UserLayoutProps) {
  const navigate = useNavigate();
  const { config } = useConfigStore();
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const logout = useAuthStore((state) => state.logout);
  const currentUser = useUserStore((state) => state.getById(currentUserId));

  const handleLogout = () => {
    logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="min-h-screen bg-shell text-white">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-line bg-[#0d141d] p-5 md:block">
        <Brand />
        <nav className="mt-8 space-y-2">
          <SideLink to="/app/dashboard" icon={<Home size={18} />} label="首页" />
          <SideLink to="/app/markets" icon={<LineChart size={18} />} label="行情" />
          <SideLink to="/app/trading" icon={<CandlestickChart size={18} />} label="交易终端" />
          <SideLink to="/app/account" icon={<UserRound size={18} />} label="我的账户" />
          <button
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-muted transition hover:bg-white/5 hover:text-white"
            onClick={handleLogout}
          >
            <LogOut size={18} />
            退出登录
          </button>
        </nav>
      </aside>
      <div className="md:pl-64">
        <header className="sticky top-0 z-10 border-b border-line bg-shell/90 px-5 py-4 backdrop-blur">
          <div className="flex items-center justify-between">
            <div className="md:hidden">
              <Brand compact />
            </div>
            <p className="ml-auto text-sm text-muted">
              当前用户 <span className="text-white">{currentUser?.email}</span>
            </p>
          </div>
        </header>
        <main className="p-5 md:p-8">{children}</main>
      </div>
    </div>
  );

  function Brand({ compact = false }: { compact?: boolean }) {
    return (
      <div className="flex items-center gap-3">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-black text-[#07110f]"
          style={{ backgroundColor: config.themeColor }}
        >
          {config.logoText}
        </div>
        {!compact ? (
          <div>
            <p className="font-semibold tracking-wide">{config.platformName}</p>
            <p className="text-xs text-muted">模拟交易控制台</p>
          </div>
        ) : null}
      </div>
    );
  }
}

function SideLink({ to, icon, label }: { to: string; icon: ReactNode; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${
          isActive ? "bg-white/10 text-white" : "text-muted hover:bg-white/5 hover:text-white"
        }`
      }
    >
      {icon}
      {label}
    </NavLink>
  );
}
