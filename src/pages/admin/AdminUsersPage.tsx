import { useEffect } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { useUserStore } from "../../store/userStore";
import { formatDateTime } from "../../utils/validators";

export function AdminUsersPage() {
  const users = useUserStore((state) => state.users);
  const loadAdminUsers = useUserStore((state) => state.loadAdminUsers);
  const setUserStatus = useUserStore((state) => state.setUserStatus);

  useEffect(() => {
    void loadAdminUsers();
  }, [loadAdminUsers]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">用户管理</h1>
        <p className="mt-2 text-sm text-muted">查看所有注册用户，并控制账号启用状态。</p>
      </div>
      <Card className="overflow-hidden p-0">
        {users.length === 0 ? (
          <div className="p-10 text-center">
            <p className="font-medium">暂无注册用户</p>
            <p className="mt-2 text-sm text-muted">用户在注册页创建账号后会显示在这里。</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-line bg-white/[0.03] text-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">用户 ID</th>
                  <th className="px-5 py-3 font-medium">邮箱</th>
                  <th className="px-5 py-3 font-medium">昵称</th>
                  <th className="px-5 py-3 font-medium">状态</th>
                  <th className="px-5 py-3 font-medium">注册时间</th>
                  <th className="px-5 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {users.map((user) => (
                  <tr key={user.id} className="hover:bg-white/[0.02]">
                    <td className="px-5 py-4 font-mono text-xs text-slate-300">{user.id}</td>
                    <td className="px-5 py-4">{user.email}</td>
                    <td className="px-5 py-4 text-muted">{user.nickname || "未设置"}</td>
                    <td className="px-5 py-4">
                      <Badge tone={user.status === "active" ? "success" : "danger"}>{user.status}</Badge>
                    </td>
                    <td className="px-5 py-4 text-muted">{formatDateTime(user.createdAt)}</td>
                    <td className="px-5 py-4">
                      {user.status === "active" ? (
                        <Button variant="danger" onClick={() => void setUserStatus(user.id, "disabled")}>
                          禁用
                        </Button>
                      ) : (
                        <Button variant="secondary" onClick={() => void setUserStatus(user.id, "active")}>
                          启用
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
