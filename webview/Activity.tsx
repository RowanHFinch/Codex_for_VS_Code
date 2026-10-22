import React, { useEffect, useState } from 'react';
import type { TimelineItem } from '../src/shared';
import type en from '../locales/en.json';
import { Icon } from './icons';

export function activityState(item: TimelineItem, active = true) {
  // A decline is the user's or policy's decision, not a tool crash.
  if (item.status === 'declined') return 'declined';
  if (item.status === 'failed' || (item.exitCode !== undefined && item.exitCode !== 0)) return 'failed';
  if (item.status === 'inProgress') return active ? 'running' : 'stopped';
  return item.status === 'completed' ? 'completed' : 'stopped';
}
export function activityLabel(item: TimelineItem, t: typeof en) {
  if (item.type === 'commandExecution') {
    const [now, past] =
      item.title === 'read'
        ? [t.readFile, t.readDone]
        : item.title === 'listFiles'
          ? [t.listFiles, t.listDone]
          : item.title === 'search'
            ? [t.searchFiles, t.searchDone]
            : [t.runCommand, t.runDone];
    return item.status === 'inProgress' ? now : past;
  }
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall' || item.type === 'collabAgentToolCall')
    return item.title || t.toolCall;
  if (item.type === 'hook') return `${t.hook} · ${item.text}`;
  return (
    (
      {
        reasoning: t.thinking,
        webSearch: t.webSearch,
        fileChange: t.fileChanges,
        contextCompaction: t.compacting,
        subAgentActivity: t.subagent,
        imageView: t.viewImage,
        imageGeneration: t.generateImage,
      } as Record<string, string>
    )[item.type] ?? t.activity
  );
}
/** Consecutive finished tool calls fold into one line; a failure opens the group. */
export function ActivityGroup({ items, t }: { items: TimelineItem[]; t: typeof en }) {
  const failed = items.filter(item => activityState(item, false) === 'failed').length;
  const [open, setOpen] = useState(failed > 0);
  return (
    <details className="activity-group" open={open}>
      <summary
        onClick={e => {
          e.preventDefault();
          setOpen(value => !value);
        }}
      >
        <Icon name="chevron" className={open ? 'open' : ''} />
        <span>{t.activitySteps.replace('{count}', String(items.length))}</span>
        {failed ? (
          <span className="activity-group-failed">{t.activityStepsFailed.replace('{count}', String(failed))}</span>
        ) : null}
      </summary>
      {open ? items.map(item => <Activity key={item.id} item={item} t={t} active={false} />) : null}
    </details>
  );
}
export function Activity({ item, t, active }: { item: TimelineItem; t: typeof en; active: boolean }) {
  const status = activityState(item, active);
  const [open, setOpen] = useState(status === 'running' || status === 'failed');
  useEffect(() => {
    if (status === 'failed') setOpen(true);
  }, [status]);
  const label = activityLabel(item, t);
  const statusLabel = {
    running: t.activityRunning,
    completed: t.activityCompleted,
    failed: t.activityFailed,
    declined: t.activityDeclined,
    stopped: t.activityStopped,
  }[status];
  return (
    <details className={`activity activity-${status}`} open={open}>
      <summary
        onClick={e => {
          e.preventDefault();
          setOpen(value => !value);
        }}
      >
        <span className="activity-status" role="img" title={statusLabel} aria-label={statusLabel}>
          <Icon
            name={
              status === 'failed'
                ? 'error'
                : status === 'declined'
                  ? 'close'
                  : status === 'completed'
                    ? 'check'
                    : status === 'running'
                      ? 'spinner'
                      : 'stop'
            }
          />
        </span>
        <span className="activity-name">{label}</span>
        <span className="activity-detail" title={item.detail}>
          {item.detail}
        </span>
        {item.exitCode !== undefined || item.durationMs !== undefined ? (
          <small>
            {[
              item.exitCode !== undefined ? `${t.exitShort} ${item.exitCode}` : '',
              item.durationMs !== undefined ? `${(Math.max(0, item.durationMs) / 1000).toFixed(1)}s` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </small>
        ) : null}
        <Icon name="chevron" className={`activity-chevron${open ? ' open' : ''}`} />
      </summary>
      {item.truncated ? <p>{t.truncated}</p> : null}
      <pre>{item.text}</pre>
    </details>
  );
}
