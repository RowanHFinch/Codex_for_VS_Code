import type { ThreadItem } from '../protocol/v2/ThreadItem';
import type { ThreadTurnsListResponse } from '../protocol/v2/ThreadTurnsListResponse';
import type { ThreadItemsListResponse } from '../protocol/v2/ThreadItemsListResponse';

// Export messages/plans only, directly from native history rather than the bounded UI projection.
export async function exportMessages(
  request: <T>(method: string, params: unknown) => Promise<T>,
  threadId: string,
  title: string,
) {
  const turns: ThreadTurnsListResponse['data'] = [],
    cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: ThreadTurnsListResponse = await request('thread/turns/list', {
      threadId,
      cursor,
      limit: 100,
      sortDirection: 'asc',
      itemsView: 'full',
    });
    turns.push(...page.data);
    if (turns.length > 1000 || page.data.some(t => !['completed', 'failed', 'interrupted'].includes(t.status)))
      throw new Error('Export requires a completed chat of at most 1,000 turns.');
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= 100))
      throw new Error('History pagination did not advance within safe limits. No partial export was created.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (new Set(turns.map(t => t.id)).size !== turns.length)
    throw new Error('History changed while exporting. Refresh and export again.');
  let markdown = `# ${title.replace(/[\r\n]/g, ' ').slice(0, 200)}\n\nExport scope: user messages, assistant responses and plans. Tool activity and attachment bytes are excluded.\n\n`;
  let size = markdown.length,
    itemCount = 0;
  for (const turn of turns) {
    let items = turn.items;
    if (turn.itemsView !== 'full') {
      items = [];
      let itemCursor: string | null = null;
      const seen = new Set<string>();
      do {
        const page: ThreadItemsListResponse = await request('thread/items/list', {
          threadId,
          turnId: turn.id,
          cursor: itemCursor,
          limit: 100,
          sortDirection: 'asc',
        });
        items.push(...page.data.map(entry => entry.item));
        itemCursor = page.nextCursor;
        if (items.length > 10_000 || (itemCursor && (seen.has(itemCursor) || seen.size >= 100)))
          throw new Error('Item pagination exceeded safe export limits. No partial export was created.');
        if (itemCursor) seen.add(itemCursor);
      } while (itemCursor);
    }
    itemCount += items.length;
    if (itemCount > 20_000) throw new Error('Chat exceeds the 20,000-item export limit.');
    for (const item of items) {
      if (!['userMessage', 'agentMessage', 'plan'].includes(item.type)) continue;
      const text =
        item.type === 'userMessage'
          ? item.content.map(part => (part.type === 'text' ? part.text : `[${part.type} attachment]`)).join('\n')
          : (item as Extract<ThreadItem, { type: 'agentMessage' | 'plan' }>).text;
      const section = `## ${item.type === 'userMessage' ? 'You' : item.type === 'plan' ? 'Plan' : 'Codex'}\n\n${text}\n\n`;
      size += section.length;
      if (size > 5_000_000)
        throw new Error('Chat exceeds the 5,000,000-character export limit. No partial export was created.');
      markdown += section;
    }
  }
  const latest: ThreadTurnsListResponse = await request('thread/turns/list', {
    threadId,
    limit: 1,
    cursor: null,
    sortDirection: 'desc',
    itemsView: 'notLoaded',
  });
  const signature = (turn: ThreadTurnsListResponse['data'][number] | undefined) =>
    turn && JSON.stringify([turn.id, turn.status, turn.completedAt]);
  if (signature(latest.data[0]) !== signature(turns.at(-1)))
    throw new Error('History changed while exporting. No partial export was created.');
  return markdown;
}
