import { BarChart3, ListChecks, ListTree, LogOut, UsersRound } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAdminAuthStore } from "../../store/adminAuthStore";

type AdminLayoutProps = {
  children: ReactNode;
};

export function AdminLayout({ children }: AdminLayoutProps) {
  const navigate = useNavigate();
  const logout = useAdminAuthStore((state) => state.logout);
  const syncSession = useAdminAuthStore((state) => state.syncSession);

  useEffect(() => {
    void syncSession().then((valid) => {
      if (!valid) {
        navigate("/admin/login", { replace: true });
      }
    });
  }, [navigate, syncSession]);

  const handleLogout = () => {
    logout();
    navigate("/admin/login", { replace: true });
  };

  return (
    <div className="min-h-screen bg-shell text-white">
      <header className="sticky top-0 z-30 border-b border-white/15 bg-black/92 backdrop-blur">
        <div className="flex w-full flex-col gap-3 px-4 py-3 md:px-8 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <img
                alt="星衡 logo"
                className="h-9 w-9 border border-white/20 object-contain"
                src="/assets/xingheng-logo@2x.png"
              />
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.26em]">星衡</p>
                <p className="text-[11px] uppercase tracking-[0.16em] text-muted">Admin control</p>
              </div>
            </div>
            <button
              className="inline-flex items-center gap-2 border border-white/30 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white transition hover:bg-white hover:text-black lg:hidden"
              onClick={handleLogout}
            >
              <LogOut size={15} />
              退出
            </button>
          </div>
          <nav className="no-scrollbar flex gap-2 overflow-x-auto pb-1 lg:justify-center lg:pb-0">
            <TopLink to="/admin/dashboard" icon={<BarChart3 size={16} />} label="数据概览" />
            <TopLink to="/admin/users" icon={<UsersRound size={16} />} label="用户管理" />
            <TopLink to="/admin/symbols" icon={<ListTree size={16} />} label="品种管理" />
            <TopLink to="/admin/trading" icon={<ListChecks size={16} />} label="交易查询" />
          </nav>
          <div className="hidden items-center gap-4 lg:flex">
            <p className="text-xs uppercase tracking-[0.16em] text-muted">
              ROLE <span className="text-white">管理员</span>
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
