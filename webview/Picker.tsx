import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

export type PickerItem = {
  key: string;
  label: string;
  detail?: string;
  checked?: boolean;
  warning?: boolean;
  disabled?: boolean;
  onSelect(): void;
};
export type PickerSection = { title?: string; items: PickerItem[]; segmented?: boolean };

/** A composer pill that opens a popover of choices above it; Escape or an outside click closes it. */
export function Picker({
  label,
  ariaLabel,
  className = '',
  disabled,
  icon,
  sections = [],
  children,
  buttonClassName = 'pill picker-button',
}: {
  label: string;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  icon?: React.ReactNode;
  sections?: PickerSection[];
  children?: React.ReactNode;
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null),
    popover = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<React.CSSProperties>({ visibility: 'hidden' });
  // Fixed positioning keeps the popover out of scrolling/clipping containers around the composer.
  useLayoutEffect(() => {
    if (!open || !button.current || !popover.current) return;
    const position = () => {
      if (!button.current || !popover.current) return;
      const anchor = button.current.getBoundingClientRect(),
        margin = 8,
        width = popover.current.getBoundingClientRect().width;
      // Open toward the side with room: pills on the right half align their right edges.
      const preferred = anchor.left > window.innerWidth / 2 ? anchor.right - width : anchor.left;
      setPlace({
        position: 'fixed',
        left: Math.max(margin, Math.min(preferred, window.innerWidth - width - margin)),
        bottom: window.innerHeight - anchor.top + 6,
        maxHeight: Math.max(80, anchor.top - margin - 6),
      });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open || place.visibility === 'hidden') return;
    if (children) {
      popover.current?.focus({ preventScroll: true });
      return;
    }
    const options = popover.current?.querySelectorAll<HTMLButtonElement>('.picker-item:not(:disabled)');
    const selected = popover.current?.querySelector<HTMLButtonElement>('.picker-item.checked:not(:disabled)');
    (selected ?? options?.[0])?.focus({ preventScroll: true });
  }, [open, place.visibility]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  return (
    <div
      className={`picker ${className}`}
      ref={root}
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={button}
        className={buttonClassName}
        aria-label={ariaLabel}
        title={label || ariaLabel}
        aria-haspopup={children ? 'dialog' : 'menu'}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        onClick={() => {
          setPlace({ visibility: 'hidden' });
          setOpen(value => !value);
        }}
      >
        {icon}
        {label ? <span>{label}</span> : null}
      </button>
      {open ? (
        <div
          id={menuId}
          className="picker-popover"
          role={children ? 'dialog' : 'menu'}
          tabIndex={children ? -1 : undefined}
          aria-label={ariaLabel}
          ref={popover}
          style={place}
          onKeyDown={e => {
            if (children) return;
            if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            const items = Array.from(
              e.currentTarget.querySelectorAll<HTMLButtonElement>('.picker-item:not(:disabled)'),
            );
            if (!items.length) return;
            e.preventDefault();
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? items.length - 1
                  : (current + (e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1) + items.length) % items.length;
            items[next].focus();
            items[next].scrollIntoView({ block: 'nearest' });
          }}
        >
          {children ??
            sections.map((section, index) => (
              <div
                key={index}
                role="group"
                aria-label={section.title}
                className={`picker-section${section.segmented ? ' segmented' : ''}`}
              >
                {section.title ? <div className="picker-title">{section.title}</div> : null}
                <div className="picker-items">
                  {section.items.map(item => (
                    <button
                      key={item.key}
                      role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                      aria-checked={item.checked}
                      className={`picker-item${item.checked ? ' checked' : ''}${item.warning ? ' warning' : ''}`}
                      disabled={item.disabled}
                      onClick={() => {
                        setOpen(false);
                        button.current?.focus();
                        item.onSelect();
                      }}
                    >
                      <span className="picker-label">{item.label}</span>
                      {item.detail ? <span className="picker-detail">{item.detail}</span> : null}
                      {item.checked && !section.segmented ? <span className="picker-check">✓</span> : null}
                    </button>
                  ))}
                </div>
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}
