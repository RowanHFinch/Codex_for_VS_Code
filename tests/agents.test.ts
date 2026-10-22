import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentTasks } from '../src/sessions/agents';
import type { Thread } from '../src/protocol/v2/Thread';

test('verified descendants can discover grandchildren, and display overflow conservatively blocks shared changes', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ic-agent-tree-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const thread = (id: string, parentThreadId = 'parent') =>
    ({
      id,
      parentThreadId,
      cwd: root,
      modelProvider: 'openai',
      status: { type: 'idle' },
      preview: '',
      name: null,
    }) as Thread;
  const agents = new AgentTasks(
    {
      request: async <T>(method: string, p: any) =>
        (method === 'thread/read'
          ? { thread: thread(p.threadId, p.threadId === 'grandchild' ? 'child' : 'parent') }
          : { data: [{ id: 'grand-turn', status: 'inProgress' }] }) as T,
    },
    root,
    () => 'parent',
    () => {},
  );
  agents.notification({ method: 'thread/started', params: { thread: thread('child') } });
  agents.notification({
    method: 'item/completed',
    params: { threadId: 'child', item: { type: 'collabAgentToolCall', receiverThreadIds: ['grandchild'] } },
  });
  assert.equal(agents.active, true);
  for (let i = 0; i < 100 && !agents.hasTurn('grandchild', 'grand-turn'); i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(agents.hasTurn('grandchild', 'grand-turn'), true);
  agents.reset();
  for (let i = 0; i < 200; i++)
    agents.notification({ method: 'thread/started', params: { thread: thread(`child-${i}`) } });
  assert.equal(agents.active, false);
  assert.equal(agents.state.tasks.length, 200);
  agents.notification({
    method: 'item/completed',
    params: { threadId: 'parent', item: { type: 'collabAgentToolCall', receiverThreadIds: ['over-limit'] } },
  });
  assert.equal(agents.active, true);
  assert.equal(agents.state.busy, true);
  assert.equal(agents.state.uncertain, true);
});

test('authoritative turn readback reconciles a missed child completion without hiding a newer event', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ic-agent-state-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = {
    id: 'child',
    parentThreadId: 'parent',
    cwd: root,
    modelProvider: 'openai',
    status: { type: 'idle' },
    preview: '',
  } as Thread;
  const agents = new AgentTasks(
    {
      request: async <T>(method: string) =>
        (method === 'thread/read' ? { thread: child } : { data: [{ id: 'turn', status: 'completed' }] }) as T,
    },
    root,
    () => 'parent',
    () => {},
  );
  agents.notification({ method: 'thread/started', params: { thread: child } });
  agents.notification({ method: 'turn/started', params: { threadId: 'child', turn: { id: 'turn' } } });
  assert.equal(agents.active, true);
  assert.equal(await agents.activeTurn('child'), undefined);
  assert.equal(agents.active, false);
  assert.equal(agents.state.tasks[0].status, 'completed');
});

test('paginated child transcript unwraps native item envelopes and refuses cyclic empty pages', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ic-agent-items-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let cyclic = false;
  const agents = new AgentTasks(
    {
      request: async <T>(method: string) => {
        if (method === 'thread/read')
          return {
            thread: {
              id: 'child',
              parentThreadId: 'parent',
              cwd: root,
              modelProvider: 'openai',
              status: { type: 'idle' },
              preview: '',
            },
          } as T;
        if (method === 'thread/turns/list')
          return {
            data: [{ id: 'turn', itemsView: 'notLoaded', items: [], status: 'completed' }],
            nextCursor: null,
          } as T;
        return {
          data: cyclic ? [] : [{ item: { id: 'answer', type: 'agentMessage', text: 'child answer' } }],
          nextCursor: cyclic ? 'same' : null,
        } as T;
      },
    },
    root,
    () => 'parent',
    () => {},
  );
  await agents.open('child');
  assert.equal(agents.state.selected?.items[0].text, 'child answer');
  cyclic = true;
  await assert.rejects(agents.open('child'), /pagination/);
});
