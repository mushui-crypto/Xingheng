import { Check, ChevronDown } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

export type DropdownSelectOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

type DropdownSelectProps<T extends string> = {
  value: T;
  options: Array<DropdownSelectOption<T>>;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  disabled?: boolean;
};

type MenuPosition = {
  left: number;
  top: number;
  width: number;
};

export function DropdownSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
  disabled = false,
}: DropdownSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listboxId = `${useId()}-listbox`;
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options[selectedIndex];

  const moveActive = (direction: 1 | -1) => {
    setActiveIndex((current) => {
      for (let offset = 1; offset <= options.length; offset += 1) {
        const next = (current + direction * offset + options.length) % options.length;
        if (!options[next]?.disabled) return next;
      }
      return current;
    });
  };

  const selectOption = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openMenu = (index = selectedIndex) => {
    if (disabled) return;
    setActiveIndex(index);
    setOpen(true);
  };

  const updateMenuPosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 8;
    const menuGap = 6;
    const estimatedMenuHeight = Math.min(options.length * 40 + 8, 256);
    const placeAbove = rect.bottom + menuGap + estimatedMenuHeight > window.innerHeight
      && rect.top > estimatedMenuHeight + menuGap;
    const top = placeAbove
      ? Math.max(viewportPadding, rect.top - estimatedMenuHeight - menuGap)
      : Math.min(window.innerHeight - estimatedMenuHeight - viewportPadding, rect.bottom + menuGap);
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(viewportPadding, window.innerWidth - rect.width - viewportPadding),
    );

    setMenuPosition({ left, top, width: rect.width });
  };

  useEffect(() => {
    if (!open) setMenuPosition(null);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    updateMenuPosition();
    const focusFrame = window.requestAnimationFrame(() => menuRef.current?.focus());
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        closeMenu();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(selectedIndex);
    }
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(options.findIndex((option) => !option.disabled));
    } else if (event.key === "End") {
      event.preventDefault();
      let lastEnabledIndex = options.length - 1;
      while (lastEnabledIndex > 0 && options[lastEnabledIndex]?.disabled) lastEnabledIndex -= 1;
      setActiveIndex(lastEnabledIndex);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectOption(activeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === "Tab") {
      closeMenu();
    }
  };

  return (
    <div className={`relative shrink-0 ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        className="flex h-10 w-full items-center justify-between gap-3 border border-line bg-black px-3 text-sm font-normal text-[#b7bcc4] outline-none transition hover:border-white/35 hover:text-white focus-visible:border-white/60 focus-visible:ring-1 focus-visible:ring-white/25 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="truncate">{selectedOption?.label ?? label}</span>
        <ChevronDown
          className={`shrink-0 text-[#7f8792] transition-transform duration-200 ${open ? "rotate-180 text-white" : ""}`}
          size={15}
          aria-hidden="true"
        />
      </button>

      {open && menuPosition ? createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          role="listbox"
          aria-label={label}
          aria-activedescendant={`${listboxId}-option-${activeIndex}`}
          tabIndex={-1}
          className="fixed z-[70] max-h-64 overflow-y-auto border border-white/20 bg-[#090909] p-1 shadow-[0_6px_8px_rgba(0,0,0,0.45)] outline-none"
          style={menuPosition}
          onKeyDown={handleMenuKeyDown}
        >
          {options.map((option, index) => {
            const selected = option.value === value;
            const active = index === activeIndex;
            return (
              <button
                key={option.value}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={option.disabled}
                tabIndex={-1}
                className={`flex h-10 w-full items-center justify-between gap-3 px-2.5 text-left text-sm font-normal outline-none transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  active ? "bg-white/[0.09] text-white" : "text-[#aeb4bd] hover:bg-white/[0.06] hover:text-white"
                }`}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => selectOption(index)}
              >
                <span className="truncate">{option.label}</span>
                {selected ? <Check className="shrink-0 text-white" size={15} strokeWidth={2} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
