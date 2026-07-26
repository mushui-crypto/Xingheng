import { FormEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import {
  RuntimeEnvironmentStatusBar,
  SensitiveEnvironmentGate,
} from "../../features/runtimeEnvironment/RuntimeEnvironmentUi";
import { useAdminAuthStore } from "../../store/adminAuthStore";

export function AdminLoginPage() {
  const navigate = useNavigate();
  const isAdminLoggedIn = useAdminAuthStore((state) => state.isAdminLoggedIn);
  const login = useAdminAuthStore((state) => state.login);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  if (isAdminLoggedIn) {
    return <Navigate to="/admin/dashboard" replace />;
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void login(email, password).then((result) => {
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      navigate("/admin/dashboard", { replace: true });
    });
  };

  return (
    <div className="min-h-screen bg-shell text-white">
      <RuntimeEnvironmentStatusBar />
      <SensitiveEnvironmentGate>
        <div className="relative grid min-h-[calc(100vh-40px)] place-items-center px-4">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.12),transparent_34%)]" />
          <Card className="relative w-full max-w-md">
            <div className="mb-8">
              <img
                alt="星衡 logo"
                className="mb-4 h-11 w-11 border border-white/20 object-contain"
                src="/assets/xingheng-logo@2x.png"
              />
              <h1 className="text-xl font-semibold">星衡后台</h1>
              <p className="mt-1 text-sm text-muted">使用固定管理员账号登录。</p>
            </div>
            <form className="space-y-4" onSubmit={handleSubmit}>
              <Input label="管理员邮箱" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
              <Input
                label="管理员密码"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
              {message ? <p className="border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">{message}</p> : null}
              <Button className="w-full" type="submit">
                登录后台
              </Button>
            </form>
          </Card>
        </div>
      </SensitiveEnvironmentGate>
    </div>
  );
}
