import { Navigate, useLocation } from "react-router-dom";
import { ForgotPasswordForm, LoginForm, RegisterForm, ResetPasswordForm } from "../../features/auth/components/AuthForms";
import { useAuthStore } from "../../store/authStore";
import { AuthFrame } from "./AuthFrame";

type AuthMode = "login" | "register" | "forgot" | "reset";

export function AuthPage() {
  const location = useLocation();
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const mode: AuthMode =
    location.pathname === "/register"
      ? "register"
      : location.pathname === "/forgot-password"
        ? "forgot"
        : location.pathname === "/reset-password"
          ? "reset"
          : "login";

  if (isLoggedIn) {
    return <Navigate to="/app/dashboard" replace />;
  }

  return (
    <AuthFrame activeTab={mode === "register" ? "register" : "login"}>
      <div key={mode} className="auth-mode-panel min-h-[520px]">
        {mode === "login" ? <LoginForm /> : mode === "register" ? <RegisterForm /> : mode === "forgot" ? <ForgotPasswordForm /> : <ResetPasswordForm />}
      </div>
    </AuthFrame>
  );
}
