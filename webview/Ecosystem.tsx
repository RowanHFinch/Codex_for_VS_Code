import React from 'react';
import { busy, type Action, type ViewState } from '../src/shared';
import type en from '../locales/en.json';

export function Ecosystem({ state, t, post }: { state: ViewState; t: typeof en; post(action: Action): void }) {
  const data = state.ecosystem,
    disabled = state.integrationBusy || state.integrationMutationBusy || data?.loading || busy(state.status);
  return (
    <section className="integration-panel integrations" aria-label={t.ecosystem}>
      <div className="panel-heading integration-toolbar">
        <h2>{t.ecosystem}</h2>
        <button disabled={!data || disabled} onClick={() => post({ type: 'refreshEcosystem' })}>
          {t.refresh}
        </button>
        <button className="text-button" disabled={!data || disabled} onClick={() => post({ type: 'reconnectMcp' })}>
          {t.reconnectSessions}
        </button>
      </div>
      {!data ? (
        <p>{t.connectIntegrations}</p>
      ) : (
        <>
          <p className="context-note">{t.ecosystemHelp}</p>
          {data.notice ? <p className="notice">{data.notice}</p> : null}
          <div className="integration-card">
            {data.features.map(feature => (
              <label className="integration-title" key={feature.name}>
                <span>
                  {feature.name === 'multi_agent'
                    ? t.agents
                    : feature.name === 'memories'
                      ? t.nativeMemory
                      : feature.name === 'hooks'
                        ? t.hooks
                        : t.plugins}
                </span>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={feature.enabled}
                  onChange={e =>
                    post({ type: 'ecosystemFeature', name: feature.name as 'hooks', enabled: e.target.checked })
                  }
                />
              </label>
            ))}
          </div>
          <h3>{t.hooks}</h3>
          {data.hooks.map(hook => (
            <article key={hook.id} className="integration-card">
              <div className="integration-title">
                <strong>{hook.event}</strong>
                <span>
                  {hook.trust} · {hook.source}
                </span>
                <label>
                  <span className="sr-only">
                    {t.enable} {hook.event}
                  </span>
                  <input
                    type="checkbox"
                    disabled={disabled || hook.managed || !hook.supported}
                    checked={hook.enabled}
                    onChange={e => post({ type: 'hookToggle', id: hook.id, enabled: e.target.checked })}
                  />
                </label>
              </div>
              {!hook.supported ? <p className="context-note">{t.hookUnsupported}</p> : null}
              <div className="toolbar">
                <button className="text-button" onClick={() => post({ type: 'openEcosystem', id: hook.id })}>
                  {t.openConfiguration}
                </button>
                {!hook.managed && hook.supported && hook.trust !== 'trusted' ? (
                  <button disabled={disabled} onClick={() => post({ type: 'trustHook', id: hook.id })}>
                    {t.reviewTrust}
                  </button>
                ) : null}
              </div>
            </article>
          ))}
          {!data.hooks.length ? <p className="context-note">{t.noHooks}</p> : null}
          <div className="integration-title">
            <h3>{t.agents}</h3>
            <button className="text-button" disabled={disabled} onClick={() => post({ type: 'newAgent' })}>
              {t.newAgent}
            </button>
          </div>
          {data.agents.map(agent => (
            <article key={agent.id} className="integration-card">
              <div className="integration-title">
                <strong>{agent.name}</strong>
                <span>{agent.scope}</span>
                <button className="text-button" onClick={() => post({ type: 'openEcosystem', id: agent.id })}>
                  {t.openInstructions}
                </button>
              </div>
            </article>
          ))}
          {!data.agents.length ? <p className="context-note">{t.noAgents}</p> : null}
          <div className="integration-title">
            <h3>{t.plugins}</h3>
            <button className="text-button" disabled={disabled} onClick={() => post({ type: 'browsePlugins' })}>
              {t.browsePlugins}
            </button>
          </div>
          {data.plugins.map(plugin => (
            <article key={plugin.id} className="integration-card">
              <div className="integration-title">
                <strong>{plugin.name}</strong>
                <label>
                  <span className="sr-only">
                    {t.enable} {plugin.name}
                  </span>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={plugin.enabled}
                    onChange={e => post({ type: 'pluginToggle', id: plugin.id, enabled: e.target.checked })}
                  />
                </label>
              </div>
              <p>{plugin.description}</p>
              <button
                className="text-button"
                disabled={disabled}
                onClick={() => post({ type: 'removePlugin', id: plugin.id })}
              >
                {t.remove}
              </button>
            </article>
          ))}
          {!data.plugins.length ? <p className="context-note">{t.noPlugins}</p> : null}
        </>
      )}
    </section>
  );
}
