import React, { useState } from 'react';
import type { Action, ViewState } from '../src/shared';
import type en from '../locales/en.json';

export function LocalData({
  kind,
  state,
  t,
  post,
}: {
  kind: 'agents' | 'memories';
  state: ViewState;
  t: typeof en;
  post(action: Action): void;
}) {
  const [search, setSearch] = useState('');
  const data = kind === 'agents' ? state.agents : state.memories;
  const statuses: Record<string, string> = {
    notLoaded: t.offline,
    idle: t.idle,
    systemError: t.failed,
    active: t.running,
    running: t.running,
    inProgress: t.running,
    pendingInit: t.starting,
    interrupting: t.interrupting,
    completed: t.completed,
    failed: t.failed,
    errored: t.failed,
    interrupted: t.interrupted,
  };
  return (
    <section
      className="integration-panel integrations local-data"
      aria-label={kind === 'agents' ? t.agentTasks : t.memoryBrowser}
    >
      <div className="panel-heading integration-toolbar">
        <h2>{kind === 'agents' ? t.agentTasks : t.memoryBrowser}</h2>
        <button
          disabled={!state.runtimeVersion || data?.loading || (kind === 'agents' && !state.threadId)}
          onClick={() => post({ type: kind === 'agents' ? 'refreshAgents' : 'browseMemories' })}
        >
          {t.refresh}
        </button>
      </div>
      <p className="context-note">{kind === 'agents' ? t.agentTasksHelp : t.memoryBrowserHelp}</p>
      <input aria-label={t.search} placeholder={t.search} value={search} onChange={e => setSearch(e.target.value)} />
      {state.agents?.uncertain && kind === 'agents' ? <p role="alert">{t.agentsUncertain}</p> : null}
      {data?.limited ? <p className="notice">{t.localListLimited}</p> : null}
      {kind === 'agents' ? (
        <>
          {!state.agents?.selected ? (
            <>
              {state.agents?.tasks
                .filter(task => `${task.title} ${task.role}`.toLowerCase().includes(search.toLowerCase()))
                .map(task => (
                  <article key={task.id} className="integration-card">
                    <div className="integration-title">
                      <strong>{task.title}</strong>
                      <span className="scope-badge">{task.role}</span>
                      <span>{statuses[task.status] ?? task.status}</span>
                    </div>
                    <div className="toolbar">
                      <button className="secondary" onClick={() => post({ type: 'agentOutput', id: task.id })}>
                        {t.agentOutput}
                      </button>
                      <button
                        className="text-button"
                        disabled={
                          !state.writable ||
                          state.permission !== 'agent' ||
                          !['running', 'active'].includes(task.status)
                        }
                        onClick={() => post({ type: 'stopAgent', id: task.id })}
                      >
                        {t.stopAgent}
                      </button>
                    </div>
                  </article>
                ))}
              {!state.agents?.tasks.length ? <p>{t.noAgentTasks}</p> : null}
            </>
          ) : null}
          {state.agents?.selected ? (
            <div className="local-preview">
              <div className="integration-title">
                <h3>{t.agentOutput}</h3>
                <button className="text-button" onClick={() => post({ type: 'closeAgentOutput' })}>
                  {t.closePreview}
                </button>
              </div>
              {state.agents.selected.cursor ? (
                <button onClick={() => post({ type: 'moreAgentOutput', id: state.agents!.selected!.id })}>
                  {t.more}
                </button>
              ) : null}
              {state.agents.selected.items.map(item => (
                <article key={`${item.turnId}/${item.id}`}>
                  <small>
                    {item.type === 'agentMessage' ? t.agent : item.type === 'userMessage' ? t.user : item.type}
                    {item.status ? ` · ${statuses[item.status] ?? item.status}` : ''}
                  </small>
                  <pre>{item.text}</pre>
                </article>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <>
          {state.memories?.selected ? (
            <div className="local-preview">
              <div className="integration-title">
                <h3>{state.memories.selected.path}</h3>
                <button className="text-button" onClick={() => post({ type: 'closeMemoryPreview' })}>
                  {t.closePreview}
                </button>
              </div>
              <pre>{state.memories.selected.text}</pre>
            </div>
          ) : null}
          {!state.memories?.selected ? (
            <>
              {state.memories?.files
                .filter(file => file.path.toLowerCase().includes(search.toLowerCase()))
                .map(file => (
                  <article key={file.id} className="integration-card">
                    <button
                      className="text-button memory-file"
                      onClick={() => post({ type: 'readMemory', id: file.id })}
                    >
                      {file.path}
                    </button>
                    <small>
                      {Math.ceil(file.bytes / 1024)} KB · {new Date(file.updatedAt).toLocaleDateString(state.locale)}
                    </small>
                  </article>
                ))}
              {!state.memories?.files.length ? <p>{t.noMemoryFiles}</p> : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
