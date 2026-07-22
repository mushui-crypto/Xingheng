import { StarBorder } from "../ui/StarBorder";

type AuthVisualProps = {
  className?: string;
  variant?: "auth" | "home";
};

export function AuthVisual({ className = "", variant = "auth" }: AuthVisualProps) {
  const isHome = variant === "home";

  return (
    <section
      aria-label={isHome ? "StellaX 品牌视觉" : undefined}
      className={`${isHome ? "pointer-events-none absolute inset-0 min-h-0 overflow-hidden bg-transparent" : "relative min-h-dvh overflow-hidden bg-black"} ${className}`}
    >
      <div className={`absolute left-1/2 top-1/2 h-[1080px] w-[1200px] -translate-x-1/2 -translate-y-1/2 overflow-hidden ${isHome ? "scale-[0.4] sm:scale-[0.58] md:scale-[0.72] lg:scale-[0.82] xl:scale-[0.9]" : ""}`}>
        <StarBorder className="left-0 top-[-44px] z-0 h-[1158px] w-[1070.74px]" color="rgba(255,255,255,1)" shape="ellipse" speed="6s" thickness={1} />
        <StarBorder className="left-[80px] top-[80px] z-[1] h-[920px] w-[1040px]" color="rgba(255,255,255,1)" shape="rounded" speed="9s" thickness={1} />
        <img
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute left-[1197px] top-[60px] z-20 h-[960px] w-[3px] max-w-none object-fill"
          src="/assets/xingheng-axis@2x.png"
        />
        <img
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute left-[428px] top-[179px] h-[722.5px] w-[343.83px] max-w-none object-fill opacity-90"
          src="/assets/xingheng-constellation@2x.png"
        />
        <img
          alt="星衡 logo"
          className="pointer-events-none absolute left-[204px] top-[464px] z-10 h-[152px] w-[791.5px] max-w-none object-fill"
          src="/assets/xingheng-lockup@2x.png"
        />
      </div>
    </section>
  );
}
