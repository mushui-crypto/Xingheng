import { Link } from "react-router-dom";

export function GuestAccessPanel({
  className = "",
  description,
  title = "登录后使用账户功能",
}: {
  className?: string;
  description: string;
  title?: string;
}) {
  return (
    <section className={`flex min-w-0 flex-col justify-center border border-[#2b2b2b] bg-black p-5 ${className}`}>
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      <p className="mt-2 text-xs leading-5 text-muted">{description}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link className="inline-flex min-h-10 items-center justify-center bg-white px-4 text-sm font-semibold text-black" to="/login">登录</Link>
        <Link className="inline-flex min-h-10 items-center justify-center border border-white/25 px-4 text-sm font-semibold text-white" to="/register">注册</Link>
      </div>
    </section>
  );
}
