import { Activity, ShieldCheck, UsersRound } from "lucide-react";
import { useEffect } from "react";
import { Card } from "../../components/ui/Card";
import { useUserStore } from "../../store/userStore";

export function AdminDashboardPage() {
  const users = useUserStore((state) => state.users);
  const loadAdminUsers = useUserStore((state) => state.loadAdminUsers);
  const activeUsers = users.filter((user) => user.status === "active").length;
  const disabledUsers = users.filter((user) => user.status === "disabled").length;

  useEffect(() => {
    void loadAdminUsers();
  }, [loadAdminUsers]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">数据概览</h1>
        <p className="mt-2 text-sm text-muted">当前展示基础用户统计与系统运行概览。</p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Stat icon={<UsersRound size={22} />} label="注册用户" value={String(users.length)} />
        <Stat icon={<ShieldCheck size={22} />} label="启用用户" value={String(activeUsers)} />
        <Stat icon={<Activity size={22} />} label="禁用用户" value={String(disabledUsers)} />
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Card>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">{label}</p>
        <span className="text-emerald-400">{icon}</span>
      </div>
      <p className="mt-4 text-3xl font-semibold">{value}</p>
    </Card>
  );
}
