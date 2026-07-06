import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { USER_AUTH_MESSAGE_KEY } from "../../api/session";
import { useAuthStore } from "../../store/authStore";
import { useUserStore } from "../../store/userStore";
import { readStorage, storageKeys, writeStorage } from "../../utils/storage";
import { isValidEmail } from "../../utils/validators";
import { AuthFrame } from "./AuthFrame";

type AuthMode = "login" | "register";
type RememberedEmail = {
  email: string;
};

const emptyRememberedEmail: RememberedEmail = {
  email: "",
};

const authInputClass =
  "xh-auth-input h-[68px] w-full rounded border border-[#2e2e2e] bg-[rgba(14,14,14,0.96)] px-6 text-base text-white outline-none transition placeholder:text-[#919191] focus:border-white/45";
const authPasswordInputClass = `${authInputClass} pr-14`;

function readRememberedEmail() {
  return readStorage<RememberedEmail>(storageKeys.rememberedEmail, emptyRememberedEmail);
}

function saveRememberedEmail(email: string) {
  writeStorage(storageKeys.rememberedEmail, { email });
}

function clearRememberedEmail() {
  writeStorage(storageKeys.rememberedEmail, emptyRememberedEmail);
}

export function AuthPage() {
  const location = useLocation();
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const mode: AuthMode = location.pathname === "/register" ? "register" : "login";

  if (isLoggedIn) {
    return <Navigate to="/app/dashboard" replace />;
  }

  return (
    <AuthFrame activeTab={mode}>
      <div key={mode} className="auth-mode-panel min-h-[520px]">
        {mode === "login" ? <LoginForm /> : <RegisterForm />}
      </div>
    </AuthFrame>
  );
}

function LoginForm() {
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);
  const [rememberedEmail] = useState(() => readRememberedEmail());
  const [email, setEmail] = useState(rememberedEmail.email);
  const [password, setPassword] = useState("");
  const [rememberEmail, setRememberEmail] = useState(Boolean(rememberedEmail.email));
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");

  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const authMessage = window.sessionStorage.getItem(USER_AUTH_MESSAGE_KEY);
    if (authMessage) {
      window.sessionStorage.removeItem(USER_AUTH_MESSAGE_KEY);
      setMessage(authMessage);
    }
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    const result = await login(email, password);
    setSubmitting(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    if (rememberEmail) {
      saveRememberedEmail(email);
    } else {
      clearRememberedEmail();
    }
    navigate("/app/dashboard", { replace: true });
  };

  return (
    <>
      <AuthHeader
        title="进入星衡"
        subtitle="登录或创建账号以进入模拟交易控制台。"
      />

      <form className="space-y-6" onSubmit={handleSubmit}>
        <AuthInput label="Email" placeholder="Enter your email" type="email" autoComplete="email" value={email} onChange={setEmail} />
        <AuthPasswordInput
          label="Password"
          placeholder="Enter your password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          visible={showPassword}
          onToggleVisible={() => setShowPassword((value) => !value)}
        />

        <div className="flex items-center justify-between text-[15px] text-[#919191]">
          <label className="inline-flex items-center gap-3">
            <input
              className="h-4 w-4 rounded border-white/25 bg-transparent"
              type="checkbox"
              checked={rememberEmail}
              onChange={(event) => {
                setRememberEmail(event.target.checked);
                if (!event.target.checked) clearRememberedEmail();
              }}
            />
            Remember email
          </label>
          <span>Forgot password?</span>
        </div>

        {message ? <p className="border border-red-400/35 bg-red-500/10 p-3 text-sm text-red-200">{message}</p> : null}

        <AuthSubmitButton disabled={submitting}>{submitting ? "Signing In..." : "Sign in"}</AuthSubmitButton>
      </form>
    </>
  );
}

function RegisterForm() {
  const navigate = useNavigate();
  const registerUser = useUserStore((state) => state.registerUser);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [message, setMessage] = useState("");

  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setMessage("");

    if (!isValidEmail(email)) {
      setMessage("请输入有效的邮箱地址。");
      return;
    }

    if (password.length < 8) {
      setMessage("密码至少需要 8 位。");
      return;
    }

    if (password !== confirmPassword) {
      setMessage("两次输入的密码不一致。");
      return;
    }

    setSubmitting(true);
    const result = await registerUser({ email, password });
    setSubmitting(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    navigate("/login", { replace: true });
  };

  return (
    <>
      <AuthHeader
        title="创建星衡账号"
        subtitle="创建账号后进入星衡模拟交易控制台。"
      />

      <form className="space-y-6" onSubmit={handleSubmit}>
        <AuthInput label="Email" placeholder="Enter your email" type="email" autoComplete="email" value={email} onChange={setEmail} />
        <AuthPasswordInput
          label="Password"
          placeholder="Enter your password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          minLength={8}
          visible={showPassword}
          onToggleVisible={() => setShowPassword((value) => !value)}
        />
        <AuthPasswordInput
          label="Confirm password"
          placeholder="Repeat your password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          minLength={8}
          visible={showConfirmPassword}
          onToggleVisible={() => setShowConfirmPassword((value) => !value)}
        />

        {message ? <p className="border border-red-400/35 bg-red-500/10 p-3 text-sm text-red-200">{message}</p> : null}

        <AuthSubmitButton disabled={submitting}>{submitting ? "Creating..." : "Create Account"}</AuthSubmitButton>
      </form>
    </>
  );
}

function AuthHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-8">
      <h1 className="text-[32px] font-medium leading-10 tracking-[0.2px]">{title}</h1>
      <p className="mt-2 text-[15px] leading-6 text-[#919191]">{subtitle}</p>
    </div>
  );
}

function AuthInput({
  label,
  placeholder,
  type = "text",
  autoComplete,
  value,
  onChange,
  minLength,
}: {
  label: string;
  placeholder: string;
  type?: string;
  autoComplete?: string;
  value: string;
  onChange: (value: string) => void;
  minLength?: number;
}) {
  return (
    <label className="block">
      <span className="mb-3 block text-sm font-medium uppercase tracking-[1.4px] text-white">{label}</span>
      <input
        className={authInputClass}
        placeholder={placeholder}
        type={type}
        autoComplete={autoComplete}
        value={value}
        minLength={minLength}
        onChange={(event) => onChange(event.target.value)}
        required
      />
    </label>
  );
}

function AuthPasswordInput({
  label,
  placeholder,
  autoComplete,
  value,
  onChange,
  minLength,
  visible,
  onToggleVisible,
}: {
  label: string;
  placeholder: string;
  autoComplete?: string;
  value: string;
  onChange: (value: string) => void;
  minLength?: number;
  visible: boolean;
  onToggleVisible: () => void;
}) {
  return (
    <label className="block">
      <span className="mb-3 block text-sm font-medium uppercase tracking-[1.4px] text-white">{label}</span>
      <div className="relative">
        <input
          className={authPasswordInputClass}
          placeholder={placeholder}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          minLength={minLength}
          onChange={(event) => onChange(event.target.value)}
          required
        />
        <button
          className="absolute right-5 top-1/2 -translate-y-1/2 text-white/75 transition hover:text-white"
          type="button"
          onClick={onToggleVisible}
          aria-label={visible ? "Hide password" : "Show password"}
        >
          {visible ? <Eye size={19} /> : <EyeOff size={19} />}
        </button>
      </div>
    </label>
  );
}

function AuthSubmitButton({ children, disabled = false }: { children: string; disabled?: boolean }) {
  return (
    <button
      className="relative flex h-[72px] w-full items-center justify-center rounded-[3px] border border-white bg-black px-6 text-[17px] font-medium tracking-[2px] text-white transition hover:bg-white hover:text-black disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-black disabled:hover:text-white"
      type="submit"
      disabled={disabled}
    >
      {children}
      <ArrowRight className="absolute right-6" size={22} />
    </button>
  );
}
