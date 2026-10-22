import React, { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { busy, type Action, type ViewState } from '../src/shared';
import type en from '../locales/en.json';

/** A side question asks a temporary read-only copy of the open chat; nothing flows back into it. */
export function SideChat({ state, t, post }: { state: ViewState; t: typeof en; post(action: Action): void }) {
  const [draft, setDraft] = useState('');
  const side = state.side?.parentId === state.threadId ? state.side : undefined;
  const working = Boolean(side && busy(side.status));
  const ask = () => {
    if (!draft.trim() || working || !state.threadId) return;
    post({ type: 'sideAsk', threadId: state.threadId, text: draft });
    setDraft('');
  };
  return (
    <section className="integration-panel side-chat" aria-label={t.sideTitle}>
      <div className="side-transcript">
        <span className="status-badge">{t.sideReadOnly}</span>
        <p className="context-note">{t.sideHelp}</p>
        {!state.threadId ? <p className="banner">{t.sideNeedsChat}</p> : null}
        <ol className="side-messages" aria-live="polite">
          {side?.items
            .filter(item => item.type === 'userMessage' || item.type === 'agentMessage')
            .map(item => (
              <li key={item.turnId + item.id} className={item.type === 'userMessage' ? 'side-user' : 'side-agent'}>
                {item.type === 'userMessage' ? (
                  <p>{item.text}</p>
                ) : (
                  <Markdown
                    skipHtml
                    remarkPlugins={[remarkGfm]}
                    components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}
                  >
                    {item.text}
                  </Markdown>
                )}
              </li>
            ))}
        </ol>
        {working ? <p role="status">{t.sideWorking}</p> : null}
        {side?.error ? (
          <p role="alert" className="error">
            {side.error}
          </p>
        ) : null}
      </div>
      <div className="side-compose">
        <textarea
          aria-label={t.sideTitle}
          placeholder={t.sidePlaceholder}
          rows={3}
          value={draft}
          disabled={!state.threadId}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              ask();
            }
          }}
        />
        <div className="toolbar">
          <small className="context-note">{t.sideShortcut}</small>
          {side ? (
            <button className="secondary" onClick={() => post({ type: 'sideClose' })}>
              {t.sideClose}
            </button>
          ) : null}
          <button disabled={!draft.trim() || working || !state.threadId} onClick={ask}>
            {t.sideAsk}
          </button>
        </div>
      </div>
    </section>
  );
}
