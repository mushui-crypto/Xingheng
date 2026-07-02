import { useEffect, type ReactNode } from "react";
import { Button } from "./Button";

type ModalProps = {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
};

export function Modal({ open, title, description, children, onClose }: ModalProps) {
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/75 p-3 backdrop-blur-sm md:items-center md:justify-center md:p-6" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="xh-modal-title"
        className="w-full border border-white/15 bg-[#050505] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.05)] md:max-w-lg md:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="xh-modal-title" className="xh-panel-title">
              {title}
            </h2>
            {description ? <p className="mt-2 text-sm leading-6 text-muted">{description}</p> : null}
          </div>
          <Button type="button" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </div>
        <div className="mt-5">{children}</div>
      </section>
    </div>
  );
}
