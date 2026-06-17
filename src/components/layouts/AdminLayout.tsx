import { BarChart3, ListChecks, ListTree, LogOut, Settings, UsersRound } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAdminAuthStore } from "../../store/adminAuthStore";
import { useConfigStore } from "../../store/configStore";

type AdminLayoutProps = {
  children: ReactNode;
};

export function AdminLayout({ children }: AdminLayoutProps) {
  const navigate = useNavigate();
  const { config } = useConfigStore();
  const logout = useAdminAuthStore((state) => state.logout);

  const handleLogout = () => {
    logout();
    navigate("/admin/login", { replace: true });
  };

  return (
    <div className="min-h-screen bg-shell text-white">
      <aside className="fixed inset-y-0 left-0 hidden w-68 border-r border-line bg-[#0d141d] p-5 md:block md:w-72">
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-black text-[#07110f]"
            style={{ backgroundColor: config.themeColor }}
          >
            {config.logoText}
          </div>
          <div>
            <p className="font-semibold tracking-wide">{config.platformName}</p>
            <p className="text-xs text-muted">后台管理</p>
          </div>
        </div>
        <nav className="mt-8 space-y-2">
          <SideLink to="/admin/dashboard" icon={<BarChart3 size={18} />} label="数据概览" />
          <SideLink to="/admin/users" icon={<UsersRound size={18} />} label="用户管理" />
          <SideLink to="/admin/symbols" icon={<ListTree size={18} />} label="品种管理" />
          <SideLink to="/admin/trading" icon={<ListChecks size={18} />} label="交易查询" />
          <SideLink to="/admin/settings" icon={<Settings size={18} />} label="系统配置" />
          <button
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-muted transition hover:bg-white/5 hover:text-white"
            onClick={handleLogout}
          >
            <LogOut size={18} />
            退出登录
          </button>
        </nav>
      </aside>
      <div className="md:pl-72">
        <header className="sticky top-0 z-10 border-b border-line bg-shell/90 px-5 py-4 backdrop-blur">
          <div className="flex items-center justify-between">
            <p className="font-semibold md:hidden">{config.platformName} 后台</p>
            <p className="ml-auto text-sm text-muted">
              当前身份 <span className="text-white">管理员</span>
            </p>
          </div>
        </header>
        <main className="p-5 md:p-8">{children}</main>
      </div>
    </div>
  );
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
