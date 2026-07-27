import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "./Button";

type ModalProps = {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  focusKey?: string | number;
  closeDisabled?: boolean;
  shellClassName?: string;
  bodyClassName?: string;
};

let openModalCount = 0;
let originalBodyOverflow = "";
let originalBodyPaddingRight = "";
const modalStack: symbol[] = [];

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
  focusKey,
  closeDisabled = false,
  shellClassName = "",
  bodyClassName = "",
}: ModalProps) {
  const titleId = useId();
  const shellRef = useRef<HTMLElement>(null);
  const modalId = useRef(Symbol("modal"));

  useEffect(() => {
    if (!open) return;

    const previouslyFocusedElement = document.activeElement;
    const releaseScrollLock = lockDocumentScroll();
    const currentModalId = modalId.current;
    const unregisterModal = registerModal(currentModalId);
    queueMicrotask(() => {
      const shell = shellRef.current;
      if (!shell || shell.contains(document.activeElement)) return;
      focusInitialElement(shell);
    });

    return () => {
      unregisterModal();
      releaseScrollLock();
      restoreModalFocus(previouslyFocusedElement);
    };
  }, [open]);

  useEffect(() => {
    if (!open || focusKey === undefined) return;

    const currentModalId = modalId.current;
    queueMicrotask(() => {
      if (!isTopModal(currentModalId)) return;
      const shell = shellRef.current;
      if (shell) focusInitialElement(shell);
    });
  }, [focusKey, open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      handleModalKeyDown(event, modalId.current, shellRef.current, closeDisabled, onClose);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDisabled, open, onClose]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className="xh-modal-backdrop"
      onClick={closeDisabled ? undefined : onClose}
    >
      <section
        aria-busy={closeDisabled}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`xh-modal-shell ${shellClassName}`}
        onClick={(event) => event.stopPropagation()}
        ref={shellRef}
        tabIndex={-1}
      >
        <div className="xh-modal-header">
          <div>
            <h2 id={titleId} className="xh-modal-title">
              {title}
            </h2>
            {description ? <p className="xh-modal-description">{description}</p> : null}
          </div>
          <Button type="button" className="xh-modal-close" variant="ghost" aria-label="关闭" disabled={closeDisabled} onClick={onClose}>
            <X className="shrink-0" size={18} strokeWidth={2} aria-hidden="true" />
          </Button>
        </div>
        <div className="xh-modal-divider" />
        <div className={`xh-modal-body ${bodyClassName}`}>{children}</div>
      </section>
    </div>,
    document.body,
  );
}

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
}

export function focusInitialElement(container: HTMLElement) {
  const preferred = container.querySelector<HTMLElement>("[data-modal-initial-focus]");
  (preferred ?? focusableElements(container)[0] ?? container).focus();
}

export function trapModalFocus(
  event: Pick<KeyboardEvent, "preventDefault" | "shiftKey">,
  container: HTMLElement,
) {
  const elements = focusableElements(container);
  if (elements.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = elements[0];
  const last = elements.at(-1)!;
  if (!container.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function registerModal(modalId: symbol) {
  modalStack.push(modalId);
  return () => {
    const stackIndex = modalStack.lastIndexOf(modalId);
    if (stackIndex >= 0) modalStack.splice(stackIndex, 1);
  };
}

export function isTopModal(modalId: symbol) {
  return modalStack.at(-1) === modalId;
}

export function handleModalKeyDown(
  event: Pick<KeyboardEvent, "key" | "preventDefault" | "shiftKey">,
  modalId: symbol,
  container: HTMLElement | null,
  closeDisabled: boolean,
  onClose: () => void,
) {
  if (!isTopModal(modalId)) return;
  if (event.key === "Escape" && !closeDisabled) {
    event.preventDefault();
    onClose();
    return;
  }
  if (event.key === "Tab" && container) {
    trapModalFocus(event, container);
  }
}

export function restoreModalFocus(element: Element | null) {
  if (element instanceof HTMLElement) element.focus();
}
