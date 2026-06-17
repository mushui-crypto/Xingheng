import { Activity, Settings, ShieldCheck, UsersRound } from "lucide-react";
import { Card } from "../../components/ui/Card";
import { useConfigStore } from "../../store/configStore";
import { useUserStore } from "../../store/userStore";

export function AdminDashboardPage() {
  const users = useUserStore((state) => state.users);
  const { config } = useConfigStore();
  const activeUsers = users.filter((user) => user.status === "active").length;
  const disabledUsers = users.filter((user) => user.status === "disabled").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">数据概览</h1>
        <p className="mt-2 text-sm text-muted">第一模块仅展示基础用户与白标配置统计。</p>
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        <Stat icon={<UsersRound size={22} />} label="注册用户" value={String(users.length)} />
        <Stat icon={<ShieldCheck size={22} />} label="启用用户" value={String(activeUsers)} />
        <Stat icon={<Activity size={22} />} label="禁用用户" value={String(disabledUsers)} />
        <Stat icon={<Settings size={22} />} label="默认币种" value={config.defaultCurrency} />
      </div>
      <Card>
        <p className="text-sm text-muted">当前白标</p>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-lg text-sm font-black text-[#07110f]"
            style={{ backgroundColor: config.themeColor }}
          >
            {config.logoText}
          </div>
          <div>
            <h2 className="text-xl font-semibold">{config.platformName}</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted">{config.riskNotice}</p>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  const themeColor = useConfigStore((state) => state.config.themeColor);

  return (
    <Card>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">{label}</p>
        <span style={{ color: themeColor }}>{icon}</span>
      </div>
      <p className="mt-4 text-3xl font-semibold">{value}</p>
    </Card>
  );
}
