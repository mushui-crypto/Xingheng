import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { USER_AUTH_MESSAGE_KEY } from "../../../api/session";
import { useAuthStore } from "../../../store/authStore";
import { useUserStore } from "../../../store/userStore";
import { readStorage, storageKeys, writeStorage } from "../../../utils/storage";
import { isValidEmail } from "../../../utils/validators";
import {
  AuthCodeInput,
  AuthFeedback,
  type AuthFeedbackState,
  AuthHeader,
  AuthInlineNote,
  AuthInput,
  AuthPasswordInput,
  AuthSubmitButton,
  useCooldownTimer,
} from "./AuthFormPrimitives";

type RememberedEmail = {
  email: string;
};

const emptyRememberedEmail: RememberedEmail = {
  email: "",
};

function readRememberedEmail() {
  return readStorage<RememberedEmail>(storageKeys.rememberedEmail, emptyRememberedEmail);
}

function saveRememberedEmail(email: string) {
  writeStorage(storageKeys.rememberedEmail, { email });
}

function clearRememberedEmail() {
  writeStorage(storageKeys.rememberedEmail, emptyRememberedEmail);
}

export function LoginForm() {
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);
  const [rememberedEmail] = useState(() => readRememberedEmail());
  const [email, setEmail] = useState(rememberedEmail.email);
  const [password, setPassword] = useState("");
  const [rememberEmail, setRememberEmail] = useState(Boolean(rememberedEmail.email));
  const [showPassword, setShowPassword] = useState(false);
  const [feedback, setFeedback] = useState<AuthFeedbackState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const authMessage = window.sessionStorage.getItem(USER_AUTH_MESSAGE_KEY);
    if (authMessage) {
      window.sessionStorage.removeItem(USER_AUTH_MESSAGE_KEY);
      setFeedback({ tone: "success", text: authMessage });
    }
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFeedback(null);
    setSubmitting(true);
    const result = await login(email, password);
    setSubmitting(false);
    if (!result.ok) {
      setFeedback({ tone: "error", text: result.message });
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
      <AuthHeader title="进入星衡" subtitle="登录或创建账号以进入模拟交易控制台。" />

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
          <Link className="transition hover:text-white" to="/forgot-password">
            Forgot password?
          </Link>
        </div>

        {feedback ? <AuthFeedback feedback={feedback} /> : null}

        <AuthSubmitButton disabled={submitting}>{submitting ? "Signing In..." : "Sign in"}</AuthSubmitButton>
      </form>
    </>
  );
}

export function RegisterForm() {
  const navigate = useNavigate();
  const registerUser = useUserStore((state) => state.registerUser);
  const requestRegisterCode = useUserStore((state) => state.requestRegisterCode);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [feedback, setFeedback] = useState<AuthFeedbackState | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);

  useCooldownTimer(cooldown, setCooldown);

  const handleSendCode = async () => {
    setFeedback(null);
    if (!isValidEmail(email)) {
      setFeedback({ tone: "error", text: "请输入有效的邮箱地址。" });
      return;
    }
    setSendingCode(true);
    const result = await requestRegisterCode(email);
    setSendingCode(false);
    if (!result.ok) {
      setFeedback({ tone: "error", text: result.message });
      return;
    }
    setCooldown(60);
    setFeedback({ tone: "success", text: result.devCode ? `${result.message}。开发验证码：${result.devCode}` : result.message });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFeedback(null);

    if (!isValidEmail(email)) {
      setFeedback({ tone: "error", text: "请输入有效的邮箱地址。" });
      return;
    }

    if (!/^\d{6}$/.test(code.trim())) {
      setFeedback({ tone: "error", text: "请输入 6 位邮箱验证码。" });
      return;
    }

    if (password.length < 8) {
      setFeedback({ tone: "error", text: "密码至少需要 8 位。" });
      return;
    }

    if (password !== confirmPassword) {
      setFeedback({ tone: "error", text: "两次输入的密码不一致。" });
      return;
    }

    setSubmitting(true);
    const result = await registerUser({ email, password, code });
    setSubmitting(false);
    if (!result.ok) {
      setFeedback({ tone: "error", text: result.message });
      return;
    }
    window.sessionStorage.setItem(USER_AUTH_MESSAGE_KEY, "注册成功，请使用邮箱和密码登录。");
    navigate("/login", { replace: true });
  };

  return (
    <>
      <AuthHeader title="创建星衡账号" subtitle="先获取邮箱验证码，完成注册后即可使用该邮箱登录。" />

      <form className="space-y-6" onSubmit={handleSubmit}>
        <AuthInput label="Email" placeholder="Enter your email" type="email" autoComplete="email" value={email} onChange={setEmail} />
        <AuthCodeInput
          label="Email code"
          placeholder="Enter 6-digit code"
          value={code}
          onChange={setCode}
          buttonText={sendingCode ? "Sending..." : cooldown > 0 ? `${cooldown}s` : "Send code"}
          buttonDisabled={sendingCode || cooldown > 0}
          onSend={handleSendCode}
        />
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

        {feedback ? <AuthFeedback feedback={feedback} /> : null}

        <AuthSubmitButton disabled={submitting}>{submitting ? "Creating..." : "Create Account"}</AuthSubmitButton>
      </form>
    </>
  );
}

type PasswordResetStep = "code" | "password";

export function ForgotPasswordForm({ initialEmail = "" }: { initialEmail?: string }) {
  const requestPasswordReset = useUserStore((state) => state.requestPasswordReset);
  const verifyPasswordResetCode = useUserStore((state) => state.verifyPasswordResetCode);
  const resetPassword = useUserStore((state) => state.resetPassword);
  const navigate = useNavigate();
  const [step, setStep] = useState<PasswordResetStep>("code");
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [feedback, setFeedback] = useState<AuthFeedbackState | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [submittingReset, setSubmittingReset] = useState(false);

  useCooldownTimer(cooldown, setCooldown);

  const handleEmailChange = (nextEmail: string) => {
    setEmail(nextEmail);
    setResetToken("");
    setFeedback(null);
    if (step === "password") {
      setStep("code");
    }
  };

  const handleCodeChange = (nextCode: string) => {
    setCode(nextCode);
    setResetToken("");
    setFeedback(null);
    if (step === "password") {
      setStep("code");
    }
  };

  const handleSendCode = async () => {
    setFeedback(null);
    if (!isValidEmail(email)) {
      setFeedback({ tone: "error", text: "请输入有效的邮箱地址。" });
      return;
    }
    setSendingCode(true);
    const result = await requestPasswordReset(email);
    setSendingCode(false);
    if (!result.ok) {
      setCooldown(0);
      setStep("code");
      setFeedback({ tone: "error", text: result.message });
      return;
    }
    setCooldown(60);
    setFeedback({ tone: "success", text: result.devCode ? `${result.message}。开发验证码：${result.devCode}` : "验证码已发送" });
  };

  const handleVerifyCode = async (event: FormEvent) => {
    event.preventDefault();
    setFeedback(null);
    setResetToken("");
    if (!isValidEmail(email)) {
      setFeedback({ tone: "error", text: "请输入有效的邮箱地址。" });
      return;
    }
    if (!/^\d{6}$/.test(code.trim())) {
      setFeedback({ tone: "error", text: "请输入 6 位邮箱验证码。" });
      return;
    }
    setVerifyingCode(true);
    const result = await verifyPasswordResetCode(email, code.trim());
    setVerifyingCode(false);
    if (!result.ok) {
      setFeedback({ tone: "error", text: result.message });
      return;
    }
    setResetToken(result.resetToken);
    setStep("password");
  };

  const handleResetPassword = async (event: FormEvent) => {
    event.preventDefault();
    setFeedback(null);
    if (!isValidEmail(email)) {
      setFeedback({ tone: "error", text: "请输入有效的邮箱地址。" });
      setStep("code");
      return;
    }
    if (!resetToken) {
      setFeedback({ tone: "error", text: "请先验证邮箱验证码。" });
      setStep("code");
      return;
    }
    if (password.length < 8) {
      setFeedback({ tone: "error", text: "密码至少需要 8 位。" });
      return;
    }
    if (password !== confirmPassword) {
      setFeedback({ tone: "error", text: "两次输入的密码不一致。" });
      return;
    }
    setSubmittingReset(true);
    const result = await resetPassword({ email, password, token: resetToken });
    setSubmittingReset(false);
    if (!result.ok) {
      setFeedback({ tone: "error", text: result.message });
      return;
    }
    window.sessionStorage.setItem(USER_AUTH_MESSAGE_KEY, "密码已重置，请使用新密码登录。");
    navigate("/login", { replace: true });
  };

  return (
    <>
      <AuthHeader
        title="找回密码"
        subtitle={step === "code" ? "输入注册邮箱并获取验证码，验证后在本页设置新密码。" : "验证码已填写，请设置新的登录密码。"}
      />
      {step === "code" ? (
        <form className="space-y-6" onSubmit={handleVerifyCode}>
          <AuthInput label="Email" placeholder="Enter your email" type="email" autoComplete="email" value={email} onChange={handleEmailChange} />
          <AuthCodeInput
            label="Email code"
            placeholder="Enter 6-digit code"
            value={code}
            onChange={handleCodeChange}
            buttonText={sendingCode ? "Sending..." : cooldown > 0 ? `${cooldown}s` : "Send code"}
            buttonDisabled={sendingCode || cooldown > 0}
            onSend={handleSendCode}
          />
          {feedback ? <AuthFeedback feedback={feedback} /> : null}
          <AuthSubmitButton disabled={verifyingCode}>{verifyingCode ? "Verifying..." : "Next"}</AuthSubmitButton>
        </form>
      ) : (
        <form className="space-y-6" onSubmit={handleResetPassword}>
          <AuthInlineNote>
            <p>邮箱：{email}</p>
            <button className="mt-1 text-white transition hover:text-white/75" type="button" onClick={() => setStep("code")}>
              返回修改邮箱或验证码
            </button>
          </AuthInlineNote>
          <AuthPasswordInput
            label="New password"
            placeholder="Enter new password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            minLength={8}
            visible={showPassword}
            onToggleVisible={() => setShowPassword((value) => !value)}
          />
          <AuthPasswordInput
            label="Confirm password"
            placeholder="Repeat new password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            minLength={8}
            visible={showConfirmPassword}
            onToggleVisible={() => setShowConfirmPassword((value) => !value)}
          />
          {feedback ? <AuthFeedback feedback={feedback} /> : null}
          <AuthSubmitButton disabled={submittingReset}>{submittingReset ? "Resetting..." : "Reset password"}</AuthSubmitButton>
        </form>
      )}
      <div className="mt-6 text-sm text-[#919191]">
        <Link className="transition hover:text-white" to="/login">返回登录</Link>
      </div>
    </>
  );
}

export function ResetPasswordForm() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const resetPassword = useUserStore((state) => state.resetPassword);
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [feedback, setFeedback] = useState<AuthFeedbackState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const token = searchParams.get("token") ?? "";

  if (!token) {
    return <ForgotPasswordForm initialEmail={email} />;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFeedback(null);
    if (!isValidEmail(email)) {
      setFeedback({ tone: "error", text: "请输入有效的邮箱地址。" });
      return;
    }
    if (password.length < 8) {
      setFeedback({ tone: "error", text: "密码至少需要 8 位。" });
      return;
    }
    if (password !== confirmPassword) {
      setFeedback({ tone: "error", text: "两次输入的密码不一致。" });
      return;
    }
    setSubmitting(true);
    const result = await resetPassword({ email, password, token });
    setSubmitting(false);
    if (!result.ok) {
      setFeedback({ tone: "error", text: result.message });
      return;
    }
    window.sessionStorage.setItem(USER_AUTH_MESSAGE_KEY, "密码已重置，请使用新密码登录。");
    navigate("/login", { replace: true });
  };

  return (
    <>
      <AuthHeader title="重置密码" subtitle="链接有效期为 10 分钟，请设置新的登录密码。" />
      <form className="space-y-6" onSubmit={handleSubmit}>
        <AuthInput label="Email" placeholder="Enter your email" type="email" autoComplete="email" value={email} onChange={setEmail} />
        <AuthPasswordInput
          label="New password"
          placeholder="Enter new password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          minLength={8}
          visible={showPassword}
          onToggleVisible={() => setShowPassword((value) => !value)}
        />
        <AuthPasswordInput
          label="Confirm password"
          placeholder="Repeat new password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          minLength={8}
          visible={showConfirmPassword}
          onToggleVisible={() => setShowConfirmPassword((value) => !value)}
        />
        {feedback ? <AuthFeedback feedback={feedback} /> : null}
        <AuthSubmitButton disabled={submitting}>{submitting ? "Resetting..." : "Reset password"}</AuthSubmitButton>
      </form>
      <div className="mt-6 text-sm text-[#919191]">
        <Link className="transition hover:text-white" to="/forgot-password">重新获取验证码</Link>
      </div>
    </>
  );
}
