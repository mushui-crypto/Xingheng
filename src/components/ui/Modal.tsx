import { useEffect, useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "./Button";

type ModalProps = {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  shellClassName?: string;
  bodyClassName?: string;
};

let openModalCount = 0;
let originalBodyOverflow = "";
let originalBodyPaddingRight = "";

function lockDocumentScroll() {
  const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

  if (openModalCount === 0) {
    originalBodyOverflow = document.body.style.overflow;
    originalBodyPaddingRight = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";

    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
  }

  openModalCount += 1;

  return () => {
    openModalCount = Math.max(0, openModalCount - 1);

    if (openModalCount === 0) {
      document.body.style.overflow = originalBodyOverflow;
      document.body.style.paddingRight = originalBodyPaddingRight;
    }
  };
}

export function Modal({
  open,
  title,
  description,
  children,
  onClose,
  shellClassName = "",
  bodyClassName = "",
}: ModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;

    const previouslyFocusedElement = document.activeElement;
    const releaseScrollLock = lockDocumentScroll();

    return () => {
      releaseScrollLock();
      if (previouslyFocusedElement instanceof HTMLElement) {
        previouslyFocusedElement.focus();
      }
    };
  }, [open]);

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

  return createPortal(
    <div
      className="xh-modal-backdrop"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`xh-modal-shell ${shellClassName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="xh-modal-header">
          <div>
            <h2 id={titleId} className="xh-modal-title">
              {title}
            </h2>
            {description ? <p className="xh-modal-description">{description}</p> : null}
          </div>
          <Button type="button" className="xh-modal-close" variant="ghost" aria-label="关闭" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </Button>
        </div>
        <div className="xh-modal-divider" />
        <div className={`xh-modal-body ${bodyClassName}`}>{children}</div>
      </section>
    </div>,
    document.body,
  );
}
