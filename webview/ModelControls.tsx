import React, { useEffect, useRef, useState } from 'react';
import type { PickerItem } from './Picker';

export function ModelControls({
  models,
  efforts,
  modelLabel,
  effortLabel,
}: {
  models: PickerItem[];
  efforts: PickerItem[];
  modelLabel: string;
  effortLabel: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const [choosingModel, setChoosingModel] = useState(false);
  const modelButton = useRef<HTMLButtonElement>(null);
  const modelMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (choosingModel) {
      const menu = modelMenu.current;
      (
        menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
        menu?.querySelector<HTMLButtonElement>('button')
      )?.focus();
    } else modelButton.current?.focus({ preventScroll: true });
  }, [choosingModel]);
  const selected = efforts.findIndex(item => (draft === null ? item.checked : item.key === draft));
  const index = Math.max(0, selected);
  const progress = efforts.length > 1 ? index / (efforts.length - 1) : 0;
  const label = efforts[selected]?.label ?? effortLabel;
  // Commit once per gesture: the host serializes configuration writes.
  const commit = () => {
    const item = efforts.find(item => item.key === pending.current);
    pending.current = null;
    setDraft(null);
    item?.onSelect();
  };
  if (choosingModel)
    return (
      <div
        className="model-menu"
        role="menu"
        aria-label={modelLabel}
        ref={modelMenu}
        onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          if (!items.length) return;
          event.preventDefault();
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
          items[next].focus();
          items[next].scrollIntoView({ block: 'nearest' });
        }}
      >
        <div className="model-menu-title">{modelLabel}</div>
        {models.map(item => (
          <button
            key={item.key}
            type="button"
            role="menuitemradio"
            aria-checked={Boolean(item.checked)}
            disabled={item.disabled}
            className="model-option"
            onClick={() => {
              setChoosingModel(false);
              item.onSelect();
            }}
          >
            <span>{item.label}</span>
            {item.checked ? (
              <span aria-hidden="true" className="model-check">
                ✓
              </span>
            ) : null}
          </button>
        ))}
      </div>
    );
  return (
    <div className="model-controls">
      <div className="reasoning-value" aria-live="polite">
        {label}
      </div>
      <button
        type="button"
        className="model-switch"
        aria-label={modelLabel}
        aria-haspopup="menu"
        ref={modelButton}
        onClick={() => setChoosingModel(true)}
      >
        <span>{models.find(item => item.checked)?.label ?? modelLabel}</span>
        <span className="model-chevron" aria-hidden="true" />
      </button>
      <div className="reasoning-slider" style={{ '--reasoning-progress': progress } as React.CSSProperties}>
        <div className="reasoning-track" aria-hidden="true">
          <div className="reasoning-ticks">
            {efforts.map((item, position) => (
              <span key={item.key} className={position <= index ? 'filled' : ''} />
            ))}
          </div>
        </div>
        <input
          type="range"
          aria-label={effortLabel}
          aria-valuetext={label}
          min={0}
          max={Math.max(0, efforts.length - 1)}
          step={1}
          value={index}
          disabled={efforts.length < 2}
          onChange={event => {
            const key = efforts[Number(event.target.value)]?.key ?? null;
            pending.current = key;
            setDraft(key);
          }}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          onPointerCancel={() => {
            pending.current = null;
            setDraft(null);
          }}
        />
      </div>
    </div>
  );
}
