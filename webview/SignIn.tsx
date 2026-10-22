import React from 'react';
import { busy, signedIn as reusable, type Action, type ViewState } from '../src/shared';
import type en from '../locales/en.json';

/** Shows how the local Codex CLI is signed in. Signing in happens in the CLI itself (`codex login`). */
export function CliSignIn({ state, t, post }: { state: ViewState; t: typeof en; post(action: Action): void }) {
  const connected = Boolean(state.runtimeVersion) && !['offline', 'connecting', 'unknown'].includes(state.status);
  const checking =
    state.status === 'connecting' || (connected && state.account === 'unknown' && !state.accountReadFailed);
  const signedOut = connected && !busy(state.status) && state.account === 'unavailable' && !state.integrationBusy;
  const canRecheck = connected && !busy(state.status) && !state.integrationBusy && !state.operationBusy;
  const signedIn = !checking && connected && reusable(state.account);
  return (
    <section className="cli-sign-in" aria-label={t.cliSignIn}>
      <p className={`context-note${signedIn ? ' signed-in' : ''}`} role="status">
        {connected && state.accountReadFailed
          ? t.accountReadFailed
          : checking
            ? t.cliChecking
            : signedIn
              ? `${state.account === 'apiKey' ? t.accountApiKey : state.account === 'provider' ? t.accountProvider : t.account} · Codex ${state.runtimeVersion}`
              : signedOut
                ? t.signedOut
                : t.cliReuseHelp}
      </p>
      {canRecheck && (signedOut || state.accountReadFailed) ? (
        <div className="toolbar">
          <button className="secondary" onClick={() => post({ type: 'connect' })}>
            {state.accountReadFailed ? t.reconnect : t.recheckLogin}
          </button>
        </div>
      ) : null}
    </section>
  );
}
