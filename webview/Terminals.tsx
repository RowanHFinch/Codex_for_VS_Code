import React, { useEffect } from 'react';
import type { Action, ViewState } from '../src/shared';
import type en from '../locales/en.json';

/** The agent's own background terminals in this chat; VS Code's integrated terminals are not listed here. */
export function Terminals({ state, t, post }: { state: ViewState; t: typeof en; post(action: Action): void }) {
  useEffect(() => post({ type: 'refreshTerminals' }), [state.threadId, post]);
  const terminals = state.terminals;
  return (
    <section className="integration-panel" aria-label={t.terminalsTitle}>
      <p className="context-note">{t.terminalsHelp}</p>
      <div className="toolbar">
        <button className="secondary" disabled={terminals?.loading} onClick={() => post({ type: 'refreshTerminals' })}>
          {t.refresh}
        </button>
        <button disabled={!terminals?.items.length} onClick={() => post({ type: 'stopAllTerminals' })}>
          {t.terminalsStopAll}
        </button>
      </div>
      {terminals?.error ? <p className="banner">{terminals.error}</p> : null}
      {terminals?.loading ? <p role="status">{t.loading}</p> : null}
      {terminals && !terminals.loading && !terminals.error && !terminals.items.length ? (
        <p className="context-note">{t.terminalsEmpty}</p>
      ) : null}
      <ul className="terminal-list">
        {terminals?.items.map(terminal => (
          <li key={terminal.processId}>
            <code title={terminal.cwd}>{terminal.command}</code>
            <small>
              {terminal.osPid !== null ? `PID ${terminal.osPid}` : ''}
              {terminal.cpuPercent !== null ? ` · CPU ${terminal.cpuPercent.toFixed(0)}%` : ''}
              {terminal.rssKb !== null ? ` · ${(terminal.rssKb / 1024).toFixed(0)} MB` : ''}
            </small>
            <button
              className="secondary"
              aria-label={`${t.terminalsStop} ${terminal.command}`}
              onClick={() => post({ type: 'stopTerminal', id: terminal.processId })}
            >
              {t.terminalsStop}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
