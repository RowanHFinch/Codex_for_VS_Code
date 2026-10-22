import React, { useEffect, useRef, useState } from 'react';
import { busy, type Action, type ViewState } from '../src/shared';
import type en from '../locales/en.json';
import { CliSignIn } from './SignIn';
import { Usage } from './Usage';
import { Icon } from './icons';

export function Sidebar({ state, t, post }: { state: ViewState; t: typeof en; post(action: Action): void }) {
  const [filter, setFilter] = useState(state.sessionsSearch);
  const online = !['offline', 'connecting', 'unknown'].includes(state.status);
  useEffect(() => {
    if (!online || state.integrationBusy || state.usage || state.account !== 'chatgpt') return;
    post({ type: 'refreshUsage' });
  }, [online, state.integrationBusy, state.usage, state.account, post]);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(searchTimer.current), [post]);
  useEffect(() => {
    document.documentElement.lang = state.locale;
  }, [state.locale]);
  const tabs = state.tabs ?? [];
  const open = tabs.filter(tab => (tab.title || t.newChat).toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const history = state.sessions.filter(session => !tabs.some(tab => tab.threadId === session.id));
  return (
    <main className="manager">
      <details open className="manager-section">
        <summary>{t.accountAndUsage}</summary>
        <div className="manager-content">
          <CliSignIn state={state} t={t} post={post} />
          <Usage state={state} t={t} post={post} compact />
        </div>
      </details>
      <details open className="manager-section">
        <summary>{t.sessionManager}</summary>
        <div className="manager-content">
          <button
            className="manager-new secondary"
            disabled={state.integrationBusy}
            onClick={() => post({ type: 'newTab' })}
          >
            <Icon name="plus" />
            {t.newChat}
          </button>
          <div className="history-search">
            <Icon name="search" />
            <input
              aria-label={t.searchChats}
              placeholder={t.searchChats}
              value={filter}
              disabled={!online || state.integrationBusy}
              onChange={e => {
                const text = e.target.value;
                setFilter(text);
                clearTimeout(searchTimer.current);
                searchTimer.current = setTimeout(() => post({ type: 'search', text, archived: false }), 250);
              }}
            />
            <button
              className="text-button"
              aria-label={t.refresh}
              title={t.refresh}
              disabled={!online || state.integrationBusy}
              onClick={() => post({ type: 'refresh' })}
            >
              {t.refresh}
            </button>
          </div>
          {open.length ? (
            <>
              <h2>{t.openChats}</h2>
              {open.map(tab => {
                const status = tab.error
                  ? 'failed'
                  : busy(tab.status) || ['failed', 'unknown'].includes(tab.status)
                    ? tab.status
                    : undefined;
                return (
                  <button
                    key={tab.id}
                    className="session"
                    aria-current={tab.id === state.channelId ? 'true' : undefined}
                    onClick={() => post({ type: 'selectTab', id: tab.id })}
                  >
                    <span className="session-title">
                      {tab.title || t.newChat}
                      {tab.unread ? (
                        <span className="unread" aria-label={t.unread}>
                          {' '}
                          •
                        </span>
                      ) : null}
                    </span>
                    {status ? <small>{t[status]}</small> : null}
                  </button>
                );
              })}
            </>
          ) : null}
          <h2>{state.sessionsArchived ? t.archived : t.recentChats}</h2>
          {history.map(session => (
            <button
              key={session.id}
              className="session"
              disabled={!online || state.integrationBusy || state.sessionsArchived}
              onClick={() => post({ type: 'open', threadId: session.id })}
            >
              <span className="session-title">{session.title || t.newChat}</span>
              <small>{new Date(session.updatedAt * 1000).toLocaleDateString(state.locale)}</small>
            </button>
          ))}
          {!history.length ? (
            <p className="context-note">
              {state.status === 'connecting' ? t.connecting : filter ? t.noMatches : t.noHistory}
            </p>
          ) : null}
          {state.sessionsCursor ? (
            <button
              className="text-button"
              disabled={!online || state.integrationBusy}
              onClick={() => post({ type: 'moreSessions' })}
            >
              {t.more}
            </button>
          ) : null}
        </div>
      </details>
      {state.error ? (
        <p className="banner error" role="alert">
          {state.error}
        </p>
      ) : null}
      {!online ? (
        <button
          className="secondary"
          disabled={state.status === 'connecting'}
          onClick={() => post({ type: 'connect' })}
        >
          {state.status === 'connecting' ? t.connecting : t.reconnect}
        </button>
      ) : null}
      <button className="text-button manager-settings" onClick={() => post({ type: 'settings' })}>
        <Icon name="settings" />
        {t.settings}
      </button>
    </main>
  );
}
