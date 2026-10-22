import React, { useState } from 'react';
import { busy, type Action, type ViewState } from '../src/shared';
import type en from '../locales/en.json';
export function IntegrationPanel({
  state,
  t,
  kind,
  post,
  back,
  refresh,
  pending = false,
}: {
  state: ViewState;
  t: typeof en;
  kind: 'skills' | 'mcp';
  post(action: Action): void;
  back(): void;
  refresh(): void;
  pending?: boolean;
}) {
  const [search, setSearch] = useState('');
  const catalog = state.integrations,
    working = Boolean(state.integrationBusy || catalog?.loading),
    disabled = working || catalog?.uncertain || pending;
  const mutationDisabled = disabled || state.integrationMutationBusy;
  const status: Record<string, string> = {
    notConnected: t.mcpNotConnected,
    notStarted: t.mcpNotConnected,
    ready: t.mcpConnected,
    connected: t.mcpConnected,
    starting: t.mcpStarting,
    authenticationRequired: t.mcpAuthRequired,
    failed: t.failed,
    cancelled: t.mcpCancelled,
    disabled: t.disabled,
  };
  const auth: Record<string, string> = {
    unknown: t.mcpUnknown,
    unsupported: t.mcpNotSupported,
    notLoggedIn: t.mcpSignedOut,
    bearerToken: t.mcpBearerToken,
    oAuth: t.mcpSignedIn,
  };
  const scope: Record<string, string> = {
    user: t.scopeUser,
    repo: t.scopeRepo,
    system: t.scopeSystem,
    admin: t.scopeAdmin,
    'managed/project': t.scopeManaged,
  };
  return (
    <section className="integration-panel" aria-label={kind === 'skills' ? t.skills : t.mcp}>
      <div className="panel-heading">
        <div>
          <h2>{kind === 'skills' ? t.skills : t.mcp}</h2>
          <p>{kind === 'skills' ? t.skillsHelp : t.mcpHelp}</p>
        </div>
        <button className="text-button" onClick={back}>
          {t.backToChat}
        </button>
      </div>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      <div className="integration-toolbar">
        <input
          aria-label={t.filterIntegrations}
          placeholder={t.filterIntegrations}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button
          className="secondary"
          disabled={working}
          onClick={() => (catalog ? refresh() : post({ type: 'connect' }))}
        >
          {catalog ? t.refresh : t.connect}
        </button>
      </div>
      {!catalog ? (
        <p>{t.connectIntegrations}</p>
      ) : (
        <>
          {working || pending ? <p role="status">{t.loadingIntegrations}</p> : null}
          {catalog.uncertain ? (
            <p role="alert" className="error">
              {t.integrationUnknown}
            </p>
          ) : null}
          {catalog.notice ? <p className="notice">{catalog.notice}</p> : null}
          {kind === 'skills' ? (
            <div className="integration-list">
              {catalog.skills
                .filter(s => `${s.name} ${s.description}`.toLowerCase().includes(search.toLowerCase()))
                .map(skill => (
                  <article className="integration-card" key={skill.id}>
                    <div className="integration-title">
                      <h3>{skill.name}</h3>
                      <span className="scope-badge">{scope[skill.scope] ?? skill.scope}</span>
                      <label>
                        <span className="sr-only">
                          {t.enable} {skill.name}
                        </span>
                        <input
                          type="checkbox"
                          checked={skill.enabled}
                          disabled={mutationDisabled}
                          onChange={e => post({ type: 'skillToggle', id: skill.id, enabled: e.target.checked })}
                        />
                      </label>
                    </div>
                    <p>{skill.description}</p>
                    <div className="toolbar">
                      <button
                        className="secondary"
                        disabled={!skill.enabled || disabled || busy(state.status)}
                        onClick={() => {
                          post({ type: 'selectSkill', id: skill.id });
                          back();
                        }}
                      >
                        {t.useSkill}
                      </button>
                      <button className="text-button" onClick={() => post({ type: 'openSkill', id: skill.id })}>
                        {t.openInstructions}
                      </button>
                    </div>
                  </article>
                ))}
              {!catalog.skills.length ? <p>{t.noSkills}</p> : null}
            </div>
          ) : (
            <>
              <div className="integration-toolbar">
                <button disabled={mutationDisabled} onClick={() => post({ type: 'addMcp' })}>
                  {t.addMcp}
                </button>
                <button
                  className="secondary"
                  disabled={mutationDisabled}
                  onClick={() => post({ type: 'reconnectMcp' })}
                >
                  {t.reconnectSessions}
                </button>
                <button className="text-button" onClick={() => post({ type: 'openMcpConfig' })}>
                  {t.openConfiguration}
                </button>
              </div>
              <p className="notice">{t.mcpBoundary}</p>
              <p className="context-note">{t.mcpReconnectHelp}</p>
              <div className="integration-list">
                {catalog.servers
                  .filter(s => s.name.toLowerCase().includes(search.toLowerCase()))
                  .map(server => (
                    <article className="integration-card" key={server.id}>
                      <div className="integration-title">
                        <h3>{server.name}</h3>
                        <span className="scope-badge">
                          {server.transport} · {scope[server.scope] ?? server.scope}
                        </span>
                        <label>
                          <span className="sr-only">
                            {t.enable} {server.name}
                          </span>
                          <input
                            type="checkbox"
                            checked={server.enabled && server.allowed}
                            // Project and managed servers cannot be edited here, but this workspace can allow or block them.
                            disabled={mutationDisabled || (!server.editable && !server.enabled)}
                            onChange={e => post({ type: 'mcpToggle', id: server.id, enabled: e.target.checked })}
                          />
                        </label>
                      </div>
                      <p>
                        {t.configurationState}: {server.enabled ? t.enabled : t.disabled} ·{' '}
                        {server.allowed ? t.allowedHere : t.blockedHere}
                      </p>
                      <p className="context-note">
                        {t.connectionState}: {status[server.status] ?? t.mcpUnknown} · {t.authentication}:{' '}
                        {auth[server.auth] ?? t.mcpUnknown}
                      </p>
                      {!server.editable ? <p className="context-note">{t.managedMcp}</p> : null}
                      {server.transport === 'HTTP' && (!server.enabled || !server.allowed) ? (
                        <p className="context-note">{t.mcpSignInHelp}</p>
                      ) : null}
                      <div className="toolbar">
                        {server.transport === 'HTTP' ? (
                          <button
                            className="secondary"
                            disabled={
                              mutationDisabled ||
                              !server.enabled ||
                              !server.allowed ||
                              state.auth?.status === 'pending' ||
                              state.auth?.status === 'unknown' ||
                              (state.auth?.kind === 'mcp' && state.auth.name === server.name)
                            }
                            title={!server.enabled || !server.allowed ? t.mcpSignInHelp : undefined}
                            onClick={() => post({ type: 'mcpLogin', id: server.id })}
                          >
                            {t.signInMcp}
                          </button>
                        ) : null}
                        <button
                          className="text-button"
                          disabled={mutationDisabled || !server.editable}
                          onClick={() => post({ type: 'mcpRemove', id: server.id })}
                        >
                          {t.remove}
                        </button>
                      </div>
                      <details>
                        <summary>
                          {t.tools} ({server.tools.length})
                        </summary>
                        <ul>
                          {server.tools.map(tool => (
                            <li key={tool}>
                              <code>{tool}</code>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </article>
                  ))}
                {!catalog.servers.length ? <p>{t.noMcp}</p> : null}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
