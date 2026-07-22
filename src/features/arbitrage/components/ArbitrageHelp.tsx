import { CircleHelp } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type TooltipPosition = {
  left: number;
  top: number;
  above: boolean;
};

export function ArbitrageHelp({ content, label = "查看说明" }: { content: string; label?: string }) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition>({ left: 0, top: 0, above: true });

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      left: Math.min(window.innerWidth - 152, Math.max(152, rect.left + rect.width / 2)),
      top: rect.top >= 96 ? rect.top - 8 : rect.bottom + 8,
      above: rect.top >= 96,
    });
  }, []);

  const show = () => {
    updatePosition();
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-dim transition-colors hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-white"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={show}
      >
        <CircleHelp aria-hidden="true" size={13} strokeWidth={1.7} />
      </button>
      {open && typeof document !== "undefined" ? createPortal(
        <div
          id={id}
          role="tooltip"
          className="pointer-events-none fixed z-[70] w-max max-w-[min(18rem,calc(100vw-2rem))] border border-white/20 bg-[#171717] px-3 py-2 text-left text-xs font-normal normal-case tracking-normal leading-5 text-[#e5e7eb] shadow-[0_4px_8px_rgba(0,0,0,0.45)]"
          style={{
            left: position.left,
            top: position.top,
            transform: position.above ? "translate(-50%, -100%)" : "translateX(-50%)",
          }}
        >
          {content}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
