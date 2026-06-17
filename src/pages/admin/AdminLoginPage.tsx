import { FormEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { useAdminAuthStore } from "../../store/adminAuthStore";
import { useConfigStore } from "../../store/configStore";

export function AdminLoginPage() {
  const navigate = useNavigate();
  const isAdminLoggedIn = useAdminAuthStore((state) => state.isAdminLoggedIn);
  const login = useAdminAuthStore((state) => state.login);
  const { config } = useConfigStore();
  const [email, setEmail] = useState("admin@example.com");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  if (isAdminLoggedIn) {
    return <Navigate to="/admin/dashboard" replace />;
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const result = login(email, password);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    navigate("/admin/dashboard", { replace: true });
  };

  return (
    <div className="grid min-h-screen place-items-center bg-shell px-4 text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(0,200,150,0.14),transparent_34%)]" />
      <Card className="relative w-full max-w-md">
        <div className="mb-8">
          <div
            className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg text-sm font-black text-[#07110f]"
            style={{ backgroundColor: config.themeColor }}
          >
            {config.logoText}
          </div>
          <h1 className="text-xl font-semibold">{config.platformName} 后台</h1>
          <p className="mt-1 text-sm text-muted">使用固定管理员账号登录。</p>
        </div>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <Input label="管理员邮箱" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          <Input
            label="管理员密码"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="admin123"
            required
          />
          {message ? <p className="rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">{message}</p> : null}
          <Button className="w-full" type="submit">
            登录后台
          </Button>
        </form>
      </Card>
    </div>
  );
}
