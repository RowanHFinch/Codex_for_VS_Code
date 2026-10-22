import type { ThreadItem } from '../protocol/v2/ThreadItem';
import { truncate, type TimelineItem } from '../shared';
export function turnErrorMessage(error: unknown) {
  const info = error && typeof error === 'object' && 'codexErrorInfo' in error ? error.codexErrorInfo : undefined;
  const code =
    typeof info === 'string'
      ? info
      : info && typeof info === 'object' && !Array.isArray(info)
        ? Object.keys(info)[0]
        : '';
  if (
    code === 'rateLimitExceeded' ||
    (code === 'responseTooManyFailedAttempts' && (info as any)?.responseTooManyFailedAttempts?.httpStatusCode === 429)
  )
    return `Codex is rate limited (${code}; HTTP 429). Request was not replayed.`;
  if (code === 'unauthorized')
    return 'The Codex CLI sign-in is missing or expired. Run `codex login` in a terminal, then reconnect. Request was not replayed.';
  const known = [
    'contextWindowExceeded',
    'sessionBudgetExceeded',
    'usageLimitExceeded',
    'rateLimitExceeded',
    'serverOverloaded',
    'cyberPolicy',
    'misalignmentPolicyViolation',
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'internalServerError',
    'unauthorized',
    'badRequest',
    'threadRollbackFailed',
    'sandboxError',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
    'activeTurnNotSteerable',
    'other',
  ];
  return `The runtime turn failed${code && known.includes(code) ? ` (${code})` : ''}. Request was not replayed.`;
}

export function timelineItem(item: ThreadItem, turnId: string, eventStatus?: string): TimelineItem {
  let text: string;
  let title: string | undefined, detail: string | undefined;
  switch (item.type) {
    case 'userMessage':
      text = item.content.map(i => (i.type === 'text' ? i.text : `[${i.type}]`)).join('\n');
      break;
    case 'agentMessage':
    case 'plan':
      text = item.text;
      break;
    case 'reasoning':
      text = item.summary.join('\n');
      break;
    case 'commandExecution':
      title = item.commandActions[0]?.type;
      detail = item.command;
      text = item.command + '\n' + (item.aggregatedOutput ?? '');
      break;
    case 'fileChange':
      text = item.changes.map(c => `${c.path}\n${c.diff}`).join('\n');
      break;
    case 'mcpToolCall':
      title = item.tool;
      detail = item.server;
      text =
        `${item.server} / ${item.tool}\n` +
        (item.result?.content
          .flatMap(value =>
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            value.type === 'text' &&
            typeof value.text === 'string'
              ? [value.text]
              : [],
          )
          .join('\n') ?? '');
      break;
    case 'dynamicToolCall':
      title = item.tool;
      text =
        item.tool +
        '\n' +
        (item.contentItems?.flatMap(value => (value.type === 'inputText' ? [value.text] : [])).join('\n') ?? '');
      break;
    case 'webSearch':
      detail = item.query;
      text = item.query;
      break;
    case 'collabAgentToolCall':
      title = item.tool;
      detail = item.receiverThreadIds.join(', ');
      text = item.prompt ?? item.tool;
      break;
    default:
      text = item.type;
  }
  // shortcut: cap each displayed item at 200k characters; page source before enabling long-response copy.
  return {
    id: item.id,
    turnId,
    type: item.type,
    phase: item.type === 'agentMessage' ? (item.phase ?? undefined) : undefined,
    text: truncate(text, 200_000),
    truncated: text.length > 200_000,
    status:
      (item.type === 'dynamicToolCall' && item.success === false) ||
      (item.type === 'mcpToolCall' && item.error !== null)
        ? 'failed'
        : 'status' in item
          ? String(item.status)
          : (eventStatus ?? 'completed'),
    title: title && truncate(title, 200),
    detail: detail && truncate(detail, 500),
    durationMs: 'durationMs' in item ? (item.durationMs ?? undefined) : undefined,
    exitCode: item.type === 'commandExecution' ? (item.exitCode ?? undefined) : undefined,
  };
}

export function appendReasoningDelta(
  items: TimelineItem[],
  turnId: string,
  itemId: string,
  index: number,
  delta: string,
) {
  if (!Number.isSafeInteger(index) || index < 0 || typeof delta !== 'string') return items;
  const existing = items.find(x => x.id === itemId && x.turnId === turnId);
  const separator = existing?.text && existing.summaryIndex !== index ? '\n\n' : '';
  const next = appendDelta(items, turnId, itemId, 'reasoning', separator + delta);
  const item = next.find(x => x.id === itemId && x.turnId === turnId)!;
  item.summaryIndex = index;
  item.status ??= 'inProgress';
  return next;
}

export function upsertItem(items: TimelineItem[], item: TimelineItem) {
  const i = items.findIndex(x => x.id === item.id && x.turnId === item.turnId);
  if (i === -1) return [...items, item];
  const next = [...items];
  next[i] =
    item.type === 'reasoning' && !item.text && item.status === 'completed'
      ? { ...item, text: items[i].text, truncated: items[i].truncated }
      : item;
  return next;
}

export function appendDelta(items: TimelineItem[], turnId: string, itemId: string, type: string, delta: string) {
  const existing = items.find(x => x.id === itemId && x.turnId === turnId);
  const text = (existing?.text ?? '') + delta;
  return upsertItem(items, {
    ...existing,
    id: itemId,
    turnId,
    type,
    text: truncate(text, 200_000),
    truncated: existing?.truncated || text.length > 200_000,
    status: existing?.status,
  });
}
