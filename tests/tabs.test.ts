import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionTabs } from '../src/sessions/tabs';
import { Coordinator, type SessionStore } from '../src/sessions/coordinator';
import type { RuntimeClient } from '../src/runtime/client';

class Runtime extends EventEmitter {
  connected = true;
  responses: any[] = [];
  calls: any[] = [];
  constructor(
    readonly root: string,
    readonly id: string,
  ) {
    super();
  }
  thread() {
    return {
      id: this.id,
      cwd: this.root,
      modelProvider: 'openai',
      name: this.id,
      preview: '',
      status: { type: 'idle' },
    };
  }
  async request(method: string, params: any = {}): Promise<any> {
    this.calls.push({ method, params });
    switch (method) {
      case 'account/read':
        return { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
      case 'model/list':
        return {
          data: [
            {
              id: 'm',
              model: 'm',
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
              defaultReasoningEffort: 'low',
            },
          ],
        };
      case 'thread/list':
        return { data: [this.thread()], nextCursor: null };
      case 'thread/start':
      case 'thread/resume':
        return {
          thread: this.thread(),
          sandbox: { type: 'readOnly', networkAccess: false },
          approvalPolicy: 'never',
          modelProvider: 'openai',
        };
      case 'thread/read':
        return { thread: this.thread() };
      case 'thread/turns/list':
        return { data: [], nextCursor: null };
      case 'turn/start':
        this.emit('notification', {
          method: 'turn/started',
          params: { threadId: this.id, turn: { id: 'turn', status: 'inProgress' } },
        });
        return { turn: { id: 'turn', status: 'inProgress' } };
      default:
        throw new Error(method);
    }
  }
  respond(id: unknown, result: unknown) {
    this.responses.push({ id, result });
  }
  reject(id: unknown) {
    this.responses.push({ id, rejected: true });
  }
  stop() {
    this.connected = false;
    this.emit('disconnect');
  }
  async shutdown() {
    this.stop();
  }
  complete() {
    this.emit('notification', {
      method: 'turn/completed',
      params: { threadId: this.id, turn: { id: 'turn', status: 'completed' } },
    });
  }
}
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ic-tabs-'))),
    values = new Map<string, any>();
  const store: SessionStore = {
    get: (key, fallback) => values.get(key) ?? fallback,
    update: async (key, value) => {
      await new Promise(resolve => setTimeout(resolve, 1));
      values.set(key, value);
    },
  };
  const runtimes = new Map<string, Runtime>();
  const create = () =>
    new SessionTabs(
      store,
      (id, scoped, metadata, changed) =>
        new Coordinator(
          root,
          scoped,
          changed,
          async () => {},
          () => {},
          undefined,
          metadata,
        ),
      () => {},
    );
  const tabs = create();
  async function connect(id: string, fresh = true) {
    const runtime = new Runtime(root, `thread-${id}`);
    runtimes.set(id, runtime);
    const c = tabs.get(id);
    await c.attach(runtime as unknown as RuntimeClient, '0.152.0');
    if (fresh) await c.newThread();
    return { c, runtime };
  }
  t.after(async () => {
    await tabs.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { tabs, create, values, root, connect, runtimes };
}
test('independent tabs stream concurrently and identical server-request IDs cannot cross approvals', async t => {
  const { tabs, connect } = await setup(t),
    a = tabs.active,
    b = await tabs.add();
  const first = await connect(a),
    second = await connect(b);
  await first.c.setDraft('alpha');
  await second.c.setDraft('beta');
  await Promise.all([
    first.c.send('alpha', undefined, async () => [{ name: 'fixture', path: '/fixture/SKILL.md' }]),
    second.c.send('beta'),
  ]);
  for (const { c, runtime } of [first, second])
    runtime.emit('request', {
      id: 'same-id',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: c.state.threadId,
        turnId: 'turn',
        itemId: 'question',
        questions: [{ id: 'q', question: 'Choose?', options: null }],
      },
    });
  first.c.decide('same-id', first.c.state.decisions[0].token, { q: { answers: ['first-only'] } });
  assert.equal(first.runtime.responses.length, 1);
  assert.equal(second.runtime.responses.length, 0);
  assert.equal(second.c.state.decisions.length, 1);
  first.runtime.emit('notification', {
    method: 'item/agentMessage/delta',
    params: { threadId: first.c.state.threadId, turnId: 'turn', itemId: 'answer', delta: 'alpha-only' },
  });
  assert.equal(first.c.state.items.at(-1)?.text, 'alpha-only');
  assert.equal(second.c.state.items.length, 0);
  assert.equal(first.runtime.calls.find(c => c.method === 'turn/start').params.input[1].type, 'skill');
  assert.equal(second.runtime.calls.find(c => c.method === 'turn/start').params.input.length, 1);
  await assert.rejects(tabs.close(b), /Stop or finish/);
  second.c.decide('same-id', second.c.state.decisions[0].token, undefined, true);
  first.runtime.complete();
  second.runtime.complete();
});
test('groups, tab identity, distinct drafts and owned metadata survive recreation without a replay', async t => {
  const { tabs, create, connect, values } = await setup(t),
    a = tabs.active,
    b = await tabs.add();
  const first = await connect(a),
    second = await connect(b);
  await Promise.all([first.c.setDraft('unsent alpha'), second.c.setDraft('unsent beta')]);
  await tabs.group('add', undefined, 'Research');
  await tabs.group('add', undefined, 'Build');
  const research = tabs.groups[0].id;
  await tabs.assign(a, research);
  await tabs.group('collapse', research, true);
  await tabs.group('down', research);
  await tabs.select(a);
  await tabs.dispose();
  const restored = create();
  try {
    assert.equal(restored.active, a);
    assert.equal(restored.summary().length, 2);
    assert.equal(restored.get(a).state.threadId, first.runtime.id);
    assert.equal(restored.get(a).state.draft, 'unsent alpha');
    assert.equal(restored.get(b).state.draft, 'unsent beta');
    assert.equal(restored.groups[1].id, research);
    assert.equal(restored.groups[1].collapsed, true);
    assert.equal(restored.summary().find(tab => tab.id === a)?.groupId, research);
    assert.equal(values.get('owned').length, 2);
    assert.equal(restored.get(a).state.status, 'offline');
    assert.equal(restored.get(b).state.status, 'offline');
    restored.get(a).state.sessions = [{ id: second.runtime.id, title: 'Restored history title' } as any];
    assert.equal(restored.summary().find(tab => tab.id === b)?.title, 'Restored history title');
    assert.equal(first.runtime.calls.filter(c => c.method === 'turn/start').length, 0);
    await restored.group('remove', research);
    assert.equal(restored.summary().find(tab => tab.id === a)?.groupId, undefined);
    assert.equal(restored.get(a).state.draft, 'unsent alpha');
  } finally {
    await restored.dispose();
  }
});
test('background completion becomes unread and selecting the tab clears it without stealing focus', async t => {
  const { tabs, connect } = await setup(t),
    first = await connect(tabs.active),
    a = tabs.active,
    b = await tabs.add();
  tabs.setVisible([b]);
  await first.c.send('background');
  first.runtime.complete();
  assert.equal(tabs.active, b);
  assert.equal(tabs.summary().find(tab => tab.id === a)?.unread, true);
  await tabs.select(a);
  assert.equal(tabs.summary().find(tab => tab.id === a)?.unread, false);
});
test('closing serializes against a send and releases the runtime while keeping a usable empty tab', async t => {
  const { tabs, connect } = await setup(t),
    a = tabs.active,
    first = await connect(a);
  await first.c.setDraft('preserve');
  const closing = tabs.close(a);
  await assert.rejects(first.c.send('must not deliver'), /active operation/);
  await closing;
  assert.equal(first.runtime.calls.filter(c => c.method === 'turn/start').length, 0);
  assert.equal(first.runtime.connected, false);
  assert.equal(tabs.summary().length, 1);
  assert.notEqual(tabs.active, a);
});
test('closing the last tab survives a factory that synchronously reads the active tab', async t => {
  const { root } = await setup(t),
    values = new Map<string, any>();
  const store: SessionStore = {
    get: (key, fallback) => values.get(key) ?? fallback,
    update: async (key, value) => {
      values.set(key, value);
    },
  };
  // Mirrors ChatHost: ActiveEditorContext's constructor broadcasts, which reads tabs.get(tabs.active).
  let tabs: SessionTabs | undefined;
  tabs = new SessionTabs(
    store,
    (id, scoped, metadata, changed) => {
      tabs?.get(tabs.active);
      return new Coordinator(
        root,
        scoped,
        changed,
        async () => {},
        () => {},
        undefined,
        metadata,
      );
    },
    () => {},
  );
  t.after(() => tabs!.dispose());
  const only = tabs.active;
  await tabs.close(only);
  assert.equal(tabs.sessions.size, 1);
  assert.notEqual(tabs.active, only);
  assert.ok(tabs.get(tabs.active));
});

test('legacy single-chat draft migrates only to its first tab, never into newly created tabs', async t => {
  const { create, values } = await setup(t);
  values.set('draft', 'legacy unsent text');
  const migrated = create();
  try {
    assert.equal(migrated.get(migrated.active).state.draft, 'legacy unsent text');
    const added = await migrated.add();
    assert.equal(migrated.get(added).state.draft, '');
  } finally {
    await migrated.dispose();
  }
});
