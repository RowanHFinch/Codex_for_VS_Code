import React from 'react';
import { busy, type Action, type ViewState } from '../src/shared';
import type en from '../locales/en.json';
import { Icon } from './icons';
type Props = { state: ViewState; t: typeof en; post(action: Action): void };
export function SessionBar({ state, t, post }: Props) {
  return (
    <div className="session-tabs" role="tablist" aria-label={t.chatTabs}>
      {state.tabs?.map(tab => (
        <div className={`session-tab ${tab.id === state.channelId ? 'selected' : ''}`} key={tab.id}>
          <button
            role="tab"
            aria-selected={tab.id === state.channelId}
            title={`${tab.title || t.newChat} · ${t[tab.status]}`}
            onClick={() => post({ type: 'selectTab', id: tab.id })}
          >
            <i className={`tab-status ${tab.status}`} aria-hidden="true" />
            <span>{tab.title || t.newChat}</span>
            {tab.unread ? (
              <span className="unread" aria-label={t.unread}>
                •
              </span>
            ) : null}
          </button>
          <button
            className="icon-button"
            aria-label={`${t.closeTab} ${tab.title || t.newChat}`}
            disabled={busy(tab.status) || state.integrationBusy}
            onClick={() => post({ type: 'closeTab', id: tab.id })}
          >
            <Icon name="close" />
          </button>
        </div>
      ))}
      <button
        className="icon-button"
        aria-label={t.newTab}
        title={t.newTab}
        disabled={state.integrationBusy}
        onClick={() => post({ type: 'newTab' })}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}
export function SessionGroups({ state, t, post }: Props) {
  const selected = state.tabs?.find(tab => tab.id === state.channelId);
  return (
    <section className="session-groups" aria-label={t.groups}>
      <div className="group-heading">
        <strong>{t.groups}</strong>
        <button className="text-button" onClick={() => post({ type: 'addGroup' })}>
          {t.addGroup}
        </button>
      </div>
      <label className="group-assignment">
        {t.moveChat}
        <select
          aria-label={t.moveChat}
          value={selected?.groupId ?? ''}
          onChange={e => post({ type: 'assignGroup', id: state.channelId!, groupId: e.target.value || null })}
        >
          <option value="">{t.ungrouped}</option>
          {state.groups?.map(group => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      </label>
      {state.groups?.map((group, index) => {
        const tabs = state.tabs?.filter(tab => tab.groupId === group.id) ?? [];
        const sessions = state.sessions.filter(
          s => state.groupAssignments?.[s.id] === group.id && !tabs.some(tab => tab.threadId === s.id),
        );
        return (
          <section className="session-group" key={group.id}>
            <div className="group-heading">
              <button
                className="group-toggle text-button"
                aria-expanded={!group.collapsed}
                onClick={() =>
                  post({ type: 'group', id: group.id, operation: 'collapse', collapsed: !group.collapsed })
                }
              >
                {group.collapsed ? '▸' : '▾'} {group.name}
                <small>{tabs.length + sessions.length}</small>
              </button>
              <div className="toolbar">
                <button
                  className="text-button"
                  disabled={index === 0}
                  aria-label={`${t.moveUp} ${group.name}`}
                  onClick={() => post({ type: 'group', id: group.id, operation: 'up' })}
                >
                  ↑
                </button>
                <button
                  className="text-button"
                  disabled={index === (state.groups?.length ?? 0) - 1}
                  aria-label={`${t.moveDown} ${group.name}`}
                  onClick={() => post({ type: 'group', id: group.id, operation: 'down' })}
                >
                  ↓
                </button>
                <button
                  className="text-button"
                  aria-label={`${t.renameGroup} ${group.name}`}
                  onClick={() => post({ type: 'group', id: group.id, operation: 'rename' })}
                >
                  …
                </button>
                <button
                  className="icon-button"
                  aria-label={`${t.removeGroup} ${group.name}`}
                  title={t.removeGroupHelp}
                  onClick={() => post({ type: 'group', id: group.id, operation: 'remove' })}
                >
                  <Icon name="close" />
                </button>
              </div>
            </div>
            {!group.collapsed ? (
              <div className="group-members">
                {tabs.map(tab => (
                  <button
                    className="session"
                    key={tab.id}
                    aria-current={tab.id === state.channelId}
                    onClick={() => post({ type: 'selectTab', id: tab.id })}
                  >
                    {tab.title || t.newChat}
                    <small>
                      {t[tab.status]}
                      {tab.unread ? ` · ${t.unread}` : ''}
                    </small>
                  </button>
                ))}
                {sessions.map(session => (
                  <button
                    className="session"
                    key={session.id}
                    disabled={state.sessionsArchived}
                    onClick={() => post({ type: 'open', threadId: session.id })}
                  >
                    {session.title}
                  </button>
                ))}
                {!tabs.length && !sessions.length ? <p className="context-note">{t.emptyGroup}</p> : null}
              </div>
            ) : null}
          </section>
        );
      })}
    </section>
  );
}
