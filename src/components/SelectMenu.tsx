import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { XiaoIcon } from "./icons/XiaoIcon";
import "./select-menu.css";

export type SelectMenuOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type SelectMenuProps = {
  value: string;
  options: readonly SelectMenuOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
  className?: string;
  compact?: boolean;
  disabled?: boolean;
  leading?: ReactNode;
  placeholder?: string;
  title?: string;
};

type MenuPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

const firstEnabled = (options: readonly SelectMenuOption[]) =>
  options.findIndex((option) => !option.disabled);

const nextEnabled = (
  options: readonly SelectMenuOption[],
  current: number,
  direction: 1 | -1,
) => {
  if (!options.length) return -1;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (current + direction * offset + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
};

export const SelectMenu = forwardRef<HTMLButtonElement, SelectMenuProps>(function SelectMenu(
  {
    value,
    options,
    onValueChange,
    ariaLabel,
    ariaDescribedBy,
    ariaInvalid = false,
    className,
    compact = false,
    disabled = false,
    leading,
    placeholder = "Choose an option",
    title,
  },
  forwardedRef,
) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const optionButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value],
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  useImperativeHandle(forwardedRef, () => trigger.current as HTMLButtonElement);

  const updatePosition = () => {
    const anchor = trigger.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const edge = 8;
    const gap = 4;
    const estimatedHeight = Math.min(options.length * 34 + 8, 260);
    const below = window.innerHeight - rect.bottom - edge;
    const above = rect.top - edge;
    const placeAbove = below < Math.min(estimatedHeight, 160) && above > below;
    const maxHeight = Math.max(88, Math.min(260, (placeAbove ? above : below) - gap));
    const width = Math.min(Math.max(rect.width, 160), window.innerWidth - edge * 2);
    const left = Math.min(Math.max(edge, rect.left), window.innerWidth - width - edge);
    const top = placeAbove
      ? Math.max(edge, rect.top - Math.min(estimatedHeight, maxHeight) - gap)
      : rect.bottom + gap;
    setPosition({ top, left, width, maxHeight });
  };

  const close = (restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) window.requestAnimationFrame(() => trigger.current?.focus());
  };

  const openMenu = (preferredIndex = selectedIndex) => {
    if (disabled) return;
    const fallback = firstEnabled(options);
    setActiveIndex(
      preferredIndex >= 0 && !options[preferredIndex]?.disabled ? preferredIndex : fallback,
    );
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      optionButtons.current[activeIndex]?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) close();
    };
    const onViewportChange = () => updatePosition();
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [activeIndex, open]);

  const moveFocus = (direction: 1 | -1) => {
    const next = nextEnabled(options, activeIndex, direction);
    if (next < 0) return;
    setActiveIndex(next);
    optionButtons.current[next]?.focus();
  };

  const select = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onValueChange(option.value);
    close(true);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const start = selectedIndex >= 0 ? selectedIndex : firstEnabled(options);
      openMenu(
        event.key === "ArrowDown"
          ? start
          : nextEnabled(options, start < 0 ? 0 : start, -1),
      );
    }
  };

  const onOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const target = event.key === "Home"
        ? firstEnabled(options)
        : [...options].map((option, optionIndex) => ({ option, optionIndex }))
            .reverse()
            .find(({ option }) => !option.disabled)?.optionIndex ?? -1;
      if (target >= 0) {
        setActiveIndex(target);
        optionButtons.current[target]?.focus();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(index);
      return;
    }
    if (event.key.length === 1) {
      const normalized = event.key.toLocaleLowerCase();
      const match = options.findIndex(
        (option) => !option.disabled && option.label.toLocaleLowerCase().startsWith(normalized),
      );
      if (match >= 0) {
        event.preventDefault();
        setActiveIndex(match);
        optionButtons.current[match]?.focus();
      }
    }
  };

  return (
    <span
      className={[
        "select-menu",
        compact ? "select-menu--compact" : "",
        className ?? "",
      ].filter(Boolean).join(" ")}
    >
      <button
        ref={trigger}
        className="select-menu__trigger"
        type="button"
        aria-label={ariaLabel}
        aria-controls={open ? menuId : undefined}
        aria-describedby={ariaDescribedBy}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-invalid={ariaInvalid || undefined}
        disabled={disabled}
        title={title}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        {leading}
        <span className={!selected ? "is-placeholder" : undefined}>
          {selected?.label ?? placeholder}
        </span>
        <XiaoIcon name="caret" size={11} />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={menu}
              className="select-menu__popover"
              data-select-menu-popover
              id={menuId}
              role="listbox"
              aria-label={ariaLabel}
              style={{
                top: position.top,
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
              }}
            >
              {options.map((option, index) => (
                <button
                  ref={(node) => {
                    optionButtons.current[index] = node;
                  }}
                  className={index === activeIndex ? "is-active" : undefined}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  disabled={option.disabled}
                  key={option.value}
                  onClick={() => select(index)}
                  onFocus={() => setActiveIndex(index)}
                  onKeyDown={(event) => onOptionKeyDown(event, index)}
                >
                  <span>{option.label}</span>
                  {option.value === value ? <XiaoIcon name="check" size={13} /> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
});
