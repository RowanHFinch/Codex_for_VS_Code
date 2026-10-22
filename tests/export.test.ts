import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportMessages } from '../src/sessions/export';
import { parseAction } from '../src/bridge';

const turn = (id: string, items: any[] = [], itemsView = 'full') => ({
  id,
  items,
  itemsView,
  status: 'completed',
  completedAt: 1,
});
const first = turn('first', [], 'summary'),
  last = turn('last', [{ type: 'agentMessage', id: 'a', text: 'FULL_RESPONSE_' + 'x'.repeat(200_001) }]);
test('export paginates native turns and items, includes full messages and excludes tool data/attachment bytes', async () => {
  const calls: any[] = [];
  const rpc = async (method: string, p: any): Promise<any> => {
    calls.push({ method, p });
    assert.equal(p.threadId, 'thread');
    if (method === 'thread/turns/list')
      return p.sortDirection === 'desc' || p.cursor
        ? { data: [last], nextCursor: null }
        : { data: [first], nextCursor: 'older' };
    if (p.cursor) return { data: [{ item: { type: 'plan', id: 'plan', text: 'PLAN_CONTENT' } }], nextCursor: null };
    return {
      data: [
        {
          item: {
            type: 'userMessage',
            id: 'user',
            content: [
              { type: 'text', text: 'USER_CONTENT' },
              { type: 'image', url: 'PRIVATE_IMAGE_BYTES' },
            ],
          },
        },
        { item: { type: 'commandExecution', id: 'tool', aggregatedOutput: 'PRIVATE_TOOL_OUTPUT' } },
      ],
      nextCursor: 'items-next',
    };
  };
  const text = await exportMessages(rpc, 'thread', 'Chat\ntitle');
  assert.ok(text.startsWith('# Chat title'));
  assert.ok(text.includes('USER_CONTENT'));
  assert.ok(text.includes('PLAN_CONTENT'));
  assert.ok(text.includes('x'.repeat(200_001)));
  assert.ok(text.includes('[image attachment]'));
  assert.ok(!text.includes('PRIVATE_'));
  assert.ok(calls.every(c => !/resume|start/.test(c.method)));
});
test('export refuses pagination cycles, active turns, overflow and a new turn within the same timestamp', async () => {
  for (const rpc of [
    async () => ({ data: [first], nextCursor: 'cycle' }),
    async () => ({ data: [{ ...first, status: 'inProgress' }], nextCursor: null }),
    async () => ({
      data: [turn('big', [{ type: 'agentMessage', id: 'big', text: 'x'.repeat(5_000_001) }])],
      nextCursor: null,
    }),
    async (_: string, p: any) => ({ data: [p.sortDirection === 'asc' ? first : last], nextCursor: null }),
  ])
    await assert.rejects(exportMessages(rpc as any, 'thread', 'Chat'));
  let empty = 0;
  await assert.rejects(
    exportMessages(async () => ({ data: [], nextCursor: String(++empty) }) as any, 'thread', 'Chat'),
  );
  assert.equal(empty, 101);
  assert.equal(parseAction({ type: 'export', threadId: 'thread', destination: 'document' }).type, 'export');
  assert.throws(() => parseAction({ type: 'export', threadId: 'thread', destination: '/overwrite/file' }));
});
