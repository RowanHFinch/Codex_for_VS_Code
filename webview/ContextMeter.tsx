import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { TokenUsage } from '../src/runtime/usage';
import type en from '../locales/en.json';

export function ContextMeter({ usage, t }: { usage: TokenUsage; t: typeof en }) {
  const [open, setOpen] = useState(false),
    [pinned, setPinned] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null),
    id = useId();
  const [place, setPlace] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const close = () => {
    setOpen(false);
    setPinned(false);
  };
  useEffect(() => {
    if (usage.lastTokens == null || !usage.contextWindow) close();
  }, [usage.lastTokens, usage.contextWindow]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (!button.current || !tooltip.current) return;
      const anchor = button.current.getBoundingClientRect();
      const width = tooltip.current.getBoundingClientRect().width;
      setPlace({
        left: Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 8)),
        bottom: window.innerHeight - anchor.top,
      });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, usage.lastTokens, usage.contextWindow, t]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  if (usage.lastTokens == null || !usage.contextWindow) return null;
  const percent = Math.min(100, Math.round((usage.lastTokens / usage.contextWindow) * 100));
  const displayPercent = percent === 0 && usage.lastTokens > 0 ? '<1' : percent;
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const tokens = t.contextTokensUsed
    .replace('{used}', compact.format(usage.lastTokens).toLowerCase())
    .replace('{limit}', compact.format(usage.contextWindow).toLowerCase());
  return (
    <div
      className="context-meter-wrap"
      ref={root}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned && document.activeElement !== button.current) setOpen(false);
      }}
    >
      <button
        type="button"
        className={`context-meter${percent > 80 ? ' high' : ''}`}
        ref={button}
        aria-label={t.contextWindow}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onClick={() => {
          setPinned(!pinned);
          setOpen(!pinned);
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6" pathLength="100" />
          <circle cx="8" cy="8" r="6" pathLength="100" strokeDasharray={`${percent} 100`} transform="rotate(-90 8 8)" />
        </svg>
        <small aria-hidden="true">{displayPercent}%</small>
      </button>
      {open ? (
        <div className="context-tooltip" ref={tooltip} style={place} role="tooltip" id={id}>
          <div className="context-tooltip-body">
            <span>{t.contextWindow}:</span>
            <span>{t.contextFull.replace('{percent}', String(displayPercent))}</span>
            <strong>{tokens}</strong>
          </div>
        </div>
      ) : null}
    </div>
  );
}
