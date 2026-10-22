import React, { useId, useState } from 'react';
import type { Action, Decision, ViewState } from '../src/shared';
import type en from '../locales/en.json';
import { Icon } from './icons';

type Props = { decision: Decision; t: typeof en; post(action: Action): void };

const counts = (added: number, removed: number) => (
  <span className="line-counts">
    <span className="added">+{added}</span> <span className="removed">−{removed}</span>
  </span>
);

/** Native file-change and command approvals; other request kinds keep the generic card. */
export function ApprovalCard({ decision, t, post }: Props) {
  const reply = (extra: Partial<Extract<Action, { type: 'decision' }>>) =>
    post({ type: 'decision', id: decision.id, token: decision.token, ...extra });
  const can = (option: NonNullable<Decision['options']>[number]) =>
    decision.canAccept && (decision.options ?? []).includes(option);
  const file = decision.method === 'item/fileChange/requestApproval';
  return (
    <section className="decision approval" aria-label={file ? t.proposedChanges : t.commandApproval}>
      <span className="status-badge warning">{t.approvalRequired}</span>
      <h3>
        <Icon name={file ? 'file' : 'terminal'} />
        {file ? t.proposedChanges : t.commandApproval}
      </h3>
      {decision.reason ? <p>{decision.reason}</p> : null}
      {file ? (
        <>
          <ul className="change-list">
            {(decision.changes ?? []).map(change => {
              const outside = change.path.startsWith('/');
              return (
                <li key={change.path}>
                  <Icon name="file" />
                  <button
                    className="text-button change-path"
                    disabled={outside || change.kind === 'delete'}
                    title={t.openDiff}
                    onClick={() =>
                      post({ type: 'openChange', id: decision.id, token: decision.token, path: change.path })
                    }
                  >
                    {change.movePath ? `${change.path} → ${change.movePath}` : change.path}
                  </button>
                  <small>{outside ? t.outsideWorkspace : change.kind}</small>
                  {counts(change.added, change.removed)}
                </li>
              );
            })}
          </ul>
          <p className="context-note">{t.diffHint}</p>
        </>
      ) : (
        <>
          {decision.command ? <pre className="command">$ {decision.command}</pre> : null}
          {decision.cwd ? <small className="context-note">{decision.cwd}</small> : null}
        </>
      )}
      <div className="actions">
        {can('accept') ? (
          <button onClick={() => reply({ accept: true })}>{file ? t.acceptChanges : t.allowOnce}</button>
        ) : null}
        <button className="secondary" onClick={() => reply({})}>
          {file ? t.rejectChanges : t.deny}
        </button>
      </div>
      <div className="actions approval-alternatives">
        {can('acceptForSession') ? (
          <button className="text-button" onClick={() => reply({ accept: true, session: true })}>
            {file ? t.acceptSessionEdits : t.allowSession}
          </button>
        ) : null}
        <button className="text-button" onClick={() => reply({ cancel: true })}>
          {t.cancelTurn}
        </button>
      </div>
    </section>
  );
}

/** Summary of files a finished turn changed, with diff and undo entry points. */
export function TurnChanges({
  turnId,
  files,
  t,
  post,
  disabled,
}: {
  turnId: string;
  files: NonNullable<ViewState['turnChanges']>[string];
  t: typeof en;
  post(action: Action): void;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const added = files.reduce((n, f) => n + f.added, 0),
    removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <section className="turn-changes" aria-label={t.changedFiles}>
      <div className="turn-changes-summary">
        <span className="turn-changes-icon">
          <Icon name="diff" />
        </span>
        <div className="turn-changes-heading">
          <span>{(files.length === 1 ? t.editedFile : t.editedFiles).replace('{count}', String(files.length))}</span>
          {counts(added, removed)}
        </div>
        <div className="turn-changes-actions">
          <button className="text-button" disabled={disabled} onClick={() => post({ type: 'undoTurn', turnId })}>
            {t.undoShort}
            <Icon name="undo" />
          </button>
          <button className="text-button view-changes" onClick={() => post({ type: 'openTurnChanges', turnId })}>
            {t.viewChanges}
          </button>
        </div>
      </div>
      <ul className="change-list" id={listId}>
        {(expanded ? files : files.slice(0, 3)).map(f => {
          const slash = f.path.lastIndexOf('/');
          return (
            <li key={f.path}>
              <button
                className="text-button change-path"
                title={f.path}
                onClick={() => post({ type: 'openTurnFile', turnId, path: f.path })}
              >
                <span className="change-directory">{f.path.slice(0, slash + 1)}</span>
                {f.path.slice(slash + 1)}
              </button>
              {counts(f.added, f.removed)}
            </li>
          );
        })}
      </ul>
      {files.length > 3 ? (
        <button
          className="text-button turn-changes-more"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded(!expanded)}
        >
          <span>{expanded ? t.showFewerFiles : t.showMoreFiles.replace('{count}', String(files.length - 3))}</span>
          <Icon name="chevron" className={expanded ? 'expanded' : ''} />
        </button>
      ) : null}
    </section>
  );
}
