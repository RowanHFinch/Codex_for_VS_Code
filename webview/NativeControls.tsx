import React from 'react';
import { busy, type Action, type ViewState } from '../src/shared';
import type en from '../locales/en.json';

export function NativeControls({
  state,
  t,
  post,
  open,
}: {
  state: ViewState;
  t: typeof en;
  post(action: Action): void;
  open?: boolean;
}) {
  const disabled =
    state.agents?.busy ||
    busy(state.status) ||
    state.operationBusy ||
    state.integrationBusy ||
    Boolean(state.queued?.length);
  return (
    <details className="native-controls" open={open}>
      <summary>
        {t.agent} · {state.profile}
      </summary>
      <p className="context-note">{t.nativeHelp}</p>
      <label>
        {t.permissions}
        <select
          value={state.profile}
          disabled={disabled}
          onChange={e => post({ type: 'nativePolicy', profile: e.target.value })}
        >
          {state.profiles?.map(p => (
            <option key={p.id} value={p.id} disabled={!p.allowed}>
              {p.id}
              {p.description ? ` · ${p.description}` : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.approvalPolicy}
        <select
          value={typeof state.approval === 'string' ? state.approval : 'configured'}
          disabled={disabled}
          onChange={e => post({ type: 'nativePolicy', approval: e.target.value as 'on-request' })}
        >
          {typeof state.approval !== 'string' ? (
            <option value="configured" disabled>
              Codex config
            </option>
          ) : null}
          <option value="on-request">{t.askApproval}</option>
          <option value="never">{t.neverApproval}</option>
          <option value="untrusted">{t.trustedApproval}</option>
        </select>
      </label>
      <label>
        {t.reviewer}
        <select
          value={state.reviewer}
          disabled={disabled}
          onChange={e => post({ type: 'nativePolicy', reviewer: e.target.value as 'user' })}
        >
          <option value="user">{t.userReviewer}</option>
          <option value="auto_review">{t.autoReviewer}</option>
          {state.reviewer === 'guardian_subagent' ? <option value="guardian_subagent">guardian_subagent</option> : null}
        </select>
      </label>
      {state.memoryAvailable ? (
        <label>
          {t.nativeMemory}
          <select
            value={state.memoryEnabled === undefined ? 'unknown' : String(state.memoryEnabled)}
            disabled={disabled || !state.owned || state.writable === false}
            onChange={e => post({ type: 'memory', enabled: e.target.value === 'true' })}
          >
            <option disabled value="unknown">
              {t.memoryUnknown}
            </option>
            <option value="true">{t.memoryOn}</option>
            <option value="false">{t.memoryOff}</option>
          </select>
        </label>
      ) : null}
    </details>
  );
}
