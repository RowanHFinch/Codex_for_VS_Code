import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/sessions/coordinator';
import { DeliveryError, type RuntimeClient } from '../src/runtime/client';
import { runtimeSettings } from '../src/runtime/settings';

class Native extends EventEmitter {
  connected = true;
  id = 'native-chat';
  active = false;
  calls: { method: string; params: any }[] = [];
  responses: any[] = [];
  queue: any[] = [];
  intercept?: (method: string, params: any) => Promise<any>;
  constructor(readonly root: string) {
    super();
  }
  thread() {
    return {
      id: this.id,
      cwd: this.root,
      modelProvider: 'openai',
      name: 'native',
      status: { type: this.active ? 'active' : 'idle' },
      turns: [],
    };
  }
  async request(method: string, params: any = {}): Promise<any> {
    this.calls.push({ method, params });
    if (this.intercept) {
      const result = await this.intercept(method, params);
      if (result !== undefined) return result;
    }
    switch (method) {
      case 'account/read':
        return { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
      case 'model/list':
        return {
          data: [
            {
              id: 'native-model',
              model: 'native-model',
              isDefault: true,
              hidden: false,
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: ['low', 'medium', 'max'].map(reasoningEffort => ({ reasoningEffort })),
            },
          ],
        };
      case 'permissionProfile/list':
        return {
          data: [':workspace', ':read-only', ':danger-full-access'].map(id => ({
            id,
            description: null,
            allowed: true,
          })),
        };
      case 'thread/list':
        return { data: params.ancestorThreadId ? [] : [this.thread()], nextCursor: null };
      case 'thread/read':
        return { thread: this.thread() };
      case 'thread/fork':
        this.id = 'forked-chat';
        return { thread: this.thread() };
      case 'thread/start':
      case 'thread/resume':
        return {
          thread: this.thread(),
          sandbox: { type: 'readOnly', networkAccess: false },
          approvalPolicy: 'never',
          modelProvider: 'openai',
        };
      case 'thread/unsubscribe':
        return { status: 'unsubscribed' };
      case 'thread/turns/list':
        return { data: [], nextCursor: null };
      case 'thread/queue/list':
        return { data: this.queue, nextCursor: null };
      case 'thread/queue/add': {
        const item = { id: 'queued', input: params.input };
        this.queue.push(item);
        return { queuedSubmission: item };
      }
      case 'thread/queue/delete':
        this.queue = this.queue.filter(q => q.id !== params.queuedSubmissionId);
        return {};
      case 'thread/memoryMode/set':
      case 'turn/steer':
        return {};
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
    this.responses.push({ id, error: true });
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
  approval(params: any = {}, method = 'item/permissions/requestApproval') {
    this.emit('request', {
      id: 17,
      method,
      params: {
        threadId: this.id,
        turnId: 'turn',
        itemId: 'item',
        permissions: { fileSystem: { read: ['/synthetic/small'] } },
        ...params,
      },
    });
  }
}
async function fixture(
  t: { after(fn: () => Promise<void>): void },
  config: Record<string, any> = {},
  preflight = async () => {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ic-native-'))),
    data = new Map();
  const store = {
    get: (k: string, v: any) => data.get(k) ?? v,
    update: async (k: string, v: any) => {
      data.set(k, v);
    },
  };
  const defaults = runtimeSettings({
    model: 'native-model',
    model_reasoning_effort: 'max',
    sandbox_mode: 'workspace-write',
    approval_policy: 'on-request',
    features: { memories: true },
    ...config,
  });
  const c = new Coordinator(
      root,
      store,
      () => {},
      preflight,
      () => {},
    ),
    f = new Native(root);
  await c.attach(f as unknown as RuntimeClient, '0.152.0', defaults);
  t.after(async () => {
    await c.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { c, f, root, store, defaults };
}
test('native config and Max survive creation/reconnection; reviewed policy is isolated', async t => {
  const { c, f, root, defaults } = await fixture(t);
  assert.equal(c.state.effort, 'max');
  assert.equal(c.state.profile, ':workspace');
  await c.newThread();
  await c.send('native request');
  const start = f.calls.find(x => x.method === 'thread/start')!.params,
    turn = f.calls.find(x => x.method === 'turn/start')!.params;
  assert.equal(start.permissions, ':workspace');
  assert.equal(start.approvalPolicy, 'on-request');
  assert.deepEqual(
    start.dynamicTools.map((tool: any) => tool.name),
    ['set_chat_title'],
  );
  assert.equal(turn.effort, 'max');
  assert.equal(turn.permissions, ':workspace');
  assert.equal(turn.collaborationMode.settings.developer_instructions, null);
  f.complete();
  await c.configure('native-model', 'low', 'plan');
  const replacement = new Native(root);
  await c.attach(replacement as unknown as RuntimeClient, '0.152.0', defaults);
  assert.equal(c.state.effort, 'low');
  assert.equal(c.state.mode, 'plan');
  assert.equal(c.state.writable, false);
  assert.equal(
    replacement.calls.some(x => x.method === 'thread/resume' || x.method === 'thread/queue/add'),
    false,
  );
  await c.newThread(true);
  const reviewed = replacement.calls.find(x => x.method === 'thread/start')!.params;
  assert.equal(reviewed.sandbox, 'read-only');
  assert.equal(reviewed.config['features.hooks'], false);
  assert.equal(reviewed.config['features.plugins'], false);
});
test('an unsupported inherited model or effort is retained and visibly rejected, never downgraded', async t => {
  const { c, f } = await fixture(t, { model_reasoning_effort: 'ultra' });
  assert.equal(c.state.effort, 'ultra');
  await c.newThread();
  await assert.rejects(c.send('request'), /supported|Unsupported|available/);
  assert.equal(
    f.calls.some(x => x.method === 'turn/start'),
    false,
  );
});
test('a configured model missing from the CLI catalog falls back visibly to the catalog default', async t => {
  const { c, f } = await fixture(t, { model: 'gpt-from-newer-cli' });
  assert.notEqual(c.state.model, 'gpt-from-newer-cli');
  assert.equal(c.state.modelFallback?.requested, 'gpt-from-newer-cli');
  await c.newThread();
  await c.send('request');
  assert.equal(f.calls.find(x => x.method === 'turn/start')!.params.model, c.state.model);
});
test('external history stays passive, active writers are refused, Continue and Fork use native profiles', async t => {
  const { c, f } = await fixture(t);
  c.state.notice = 'Old chat notice';
  await c.openThread(f.id);
  assert.equal(c.state.writable, false);
  assert.equal(c.state.notice, undefined, 'history is represented by writability, not a persistent notice');
  assert.equal(
    f.calls.some(x => x.method === 'thread/resume'),
    false,
  );
  f.active = true;
  await assert.rejects(c.continueThread(), /another client/);
  f.active = false;
  await c.continueThread();
  assert.equal(c.state.writable, true);
  assert.equal(c.state.notice, undefined);
  assert.equal(f.calls.find(x => x.method === 'thread/resume')!.params.permissions, ':workspace');
  await c.continueThread(true);
  assert.equal(c.state.threadId, 'forked-chat');
  assert.equal(c.state.writable, true);
  assert.ok(f.calls.find(x => x.method === 'thread/unsubscribe'));
});
test('starting a new chat clears the previous chat notice', async t => {
  const { c } = await fixture(t);
  c.state.notice = 'Previous chat notice';
  await c.newThread();
  assert.equal(c.state.notice, undefined);
});
test('first Send resumes passive history once, preserves newer drafts and sends the selected settings', async t => {
  const { c, f } = await fixture(t);
  await c.openThread(f.id);
  await c.configure('native-model', 'low', 'plan');
  await c.setDraft('submitted');
  c.state.models[0].inputModalities = ['text', 'image'];
  const context = {
    id: 'selection',
    uri: 'file:///synthetic/example.ts',
    path: '/synthetic/example.ts',
    label: 'example.ts:1',
    text: 'selected code',
    version: 1,
    startLine: 1,
    endLine: 1,
    kind: 'selection' as const,
  };
  c.state.contexts = [context];
  const epoch = c.state.draftEpoch;
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve => {
    release = resolve;
  });
  const resuming = new Promise<void>(resolve => {
    entered = resolve;
  });
  f.intercept = async method => {
    if (method === 'thread/resume') {
      entered();
      await paused;
    }
  };
  const sending = c.send('submitted', undefined, undefined, ['/synthetic/image.png']);
  await resuming;
  await assert.rejects(c.send('duplicate'), /active operation/);
  await c.setDraft('new draft while resuming', c.state.threadId, true);
  c.state.contexts.push({ ...context, id: 'later-selection' });
  release();
  await sending;
  assert.equal(c.state.draft, 'new draft while resuming');
  assert.equal(c.state.draftEpoch, epoch);
  assert.equal(c.state.owned, true);
  assert.equal(c.state.writable, true);
  assert.equal(f.calls.filter(x => x.method === 'thread/resume').length, 1);
  const turns = f.calls.filter(x => x.method === 'turn/start');
  assert.equal(turns.length, 1);
  assert.match(turns[0].params.input[0].text, /^submitted\n/);
  assert.match(turns[0].params.input[0].text, /selected code/);
  assert.deepEqual(turns[0].params.input.at(-1), { type: 'localImage', path: '/synthetic/image.png' });
  assert.deepEqual(
    c.state.contexts.map(x => x.id),
    ['later-selection'],
  );
  assert.equal(turns[0].params.effort, 'low');
  assert.equal(turns[0].params.collaborationMode.mode, 'plan');
});
test('first Send keeps the draft on resume refusal or uncertain delivery and never replays', async t => {
  for (const delivery of ['rejected', 'unknown'] as const) {
    const { c, f } = await fixture(t);
    await c.openThread(f.id);
    await c.setDraft('keep my draft');
    f.intercept = async method => {
      if (method === 'thread/resume') throw new DeliveryError(delivery, method, 12, 'writer unavailable');
    };
    await assert.rejects(c.send(c.state.draft), /writer unavailable/);
    assert.equal(c.state.draft, 'keep my draft');
    assert.equal(c.state.status, 'unknown');
    await assert.rejects(c.send(c.state.draft), /unknown outcome/);
    assert.equal(f.calls.filter(x => x.method === 'thread/resume').length, 1);
    assert.equal(f.calls.filter(x => x.method === 'turn/start').length, 0);
  }
});
test('queued history is checked before acquiring its writer', async t => {
  const { c, f } = await fixture(t);
  await c.openThread(f.id);
  f.queue = [{ id: 'existing', input: [{ type: 'text', text: 'previously queued' }] }];
  await c.setDraft('new message');
  await assert.rejects(c.send(c.state.draft), /queued work/);
  assert.equal(c.state.draft, 'new message');
  assert.equal(
    f.calls.some(x => x.method === 'thread/resume' || x.method === 'turn/start'),
    false,
  );
});
test('a changed thread, concurrent turn or new queue during resume never sends the submitted message', async t => {
  for (const race of ['thread', 'turn', 'queue']) {
    const { c, f } = await fixture(t);
    await c.openThread(f.id);
    await c.setDraft('keep this message');
    f.intercept = async method => {
      if (method !== 'thread/resume') return;
      if (race === 'thread') return { thread: { ...f.thread(), id: 'unexpected' } };
      if (race === 'turn')
        f.emit('notification', {
          method: 'turn/started',
          params: { threadId: f.id, turn: { id: 'other-turn', status: 'inProgress' } },
        });
      if (race === 'queue') f.queue = [{ id: 'new-queue', input: [] }];
    };
    await assert.rejects(c.send(c.state.draft), /different chat|active work|pending work/);
    assert.equal(c.state.draft, 'keep this message');
    assert.equal(
      f.calls.some(x => x.method === 'turn/start'),
      false,
    );
    if (race !== 'queue') assert.equal(c.state.status, 'unknown');
  }
});
test('native activation runs preflight and an unknown start cannot be retried or followed by sending', async t => {
  let blocked = true;
  const { c, f } = await fixture(t, {}, async () => {
    if (blocked) throw new Error('Unconfirmed integrations');
  });
  await assert.rejects(c.newThread(), /Unconfirmed/);
  assert.equal(
    f.calls.some(x => x.method === 'thread/start'),
    false,
  );
  blocked = false;
  await c.newThread();
  f.intercept = async method => {
    if (method === 'thread/start') throw new DeliveryError('unknown', method, 1, 'lost acknowledgement');
  };
  await assert.rejects(c.newThread(), /lost acknowledgement/);
  assert.equal(c.state.status, 'unknown');
  assert.equal(c.state.writable, false);
  assert.equal(f.connected, false);
  await assert.rejects(c.newThread(), /connection/);
  await assert.rejects(c.send('retry'));
});
test('native approval has a unique snapshot and duplicate RPC ids never widen its permissions', async t => {
  const { c, f } = await fixture(t);
  await c.newThread();
  await c.send('request');
  f.approval();
  const old = c.state.decisions[0];
  assert.match(old.summary!, /synthetic\/small/);
  assert.equal(old.scope, 'turn');
  f.approval({ permissions: { fileSystem: { write: ['/synthetic/private'] }, network: { enabled: true } } });
  assert.equal(f.connected, false);
  assert.equal(c.state.decisions.length, 0);
  assert.deepEqual(f.responses, []);
  assert.throws(() => c.decide(17, old.token, undefined, false, true), /expired/);
});
test('a delayed approval from an old connection cannot approve a new request reusing its RPC id', async t => {
  const { c, f, root, defaults } = await fixture(t);
  await c.newThread();
  await c.send('request');
  f.approval();
  const old = c.state.decisions[0];
  c.decision(17, old.token);
  const replacement = new Native(root);
  await c.attach(replacement as unknown as RuntimeClient, '0.152.0', defaults);
  await c.continueThread();
  await c.send('replacement');
  replacement.approval({ permissions: { network: { enabled: true } } });
  assert.notEqual(c.state.decisions[0].token, old.token);
  assert.throws(() => c.decide(17, old.token, undefined, false, true), /expired/);
  assert.equal(replacement.responses.length, 0);
  const d = c.state.decisions[0];
  c.decide(17, d.token, undefined, false, true);
  assert.deepEqual(replacement.responses[0].result, { permissions: { network: { enabled: true } }, scope: 'turn' });
});
test('approval details preserve network destinations and roots; truncated details cannot be accepted', async t => {
  const { c, f } = await fixture(t);
  await c.newThread();
  await c.send('request');
  f.approval(
    {
      additionalPermissions: { network: { enabled: true } },
      networkApprovalContext: { host: 'synthetic.example', protocol: 'https' },
      command: 'fixture',
      cwd: '/synthetic/root',
    },
    'item/commandExecution/requestApproval',
  );
  let d = c.state.decisions[0];
  assert.match(d.summary!, /synthetic.example/);
  assert.match(d.summary!, /additionalPermissions/);
  c.decide(17, d.token);
  f.approval({ grantRoot: '/synthetic/private' }, 'item/fileChange/requestApproval');
  d = c.state.decisions[0];
  assert.equal(d.scope, 'session');
  assert.match(d.summary!, /grantRoot/);
  c.decide(17, d.token);
  f.approval({ reason: 'x'.repeat(21000) });
  d = c.state.decisions[0];
  assert.equal(d.truncated, true);
  assert.equal(d.canAccept, false);
  assert.throws(() => c.decide(17, d.token, undefined, false, true), /cannot be approved/);
});
test('native queue, steer and memory use runtime APIs and unknown deliveries stop the connection', async t => {
  const { c, f } = await fixture(t);
  await c.newThread();
  assert.equal(c.state.memoryEnabled, undefined);
  await c.memory(false);
  assert.equal(c.state.memoryEnabled, false);
  await c.send('initial');
  await c.setDraft('follow up');
  await c.followup('follow up', 'queue');
  assert.equal(c.state.draft, '');
  assert.equal(c.state.queued?.[0].text, 'follow up');
  await c.followup('adjust', 'steer');
  assert.equal(f.calls.find(x => x.method === 'turn/steer')!.params.expectedTurnId, 'turn');
  await c.removeQueued('queued');
  assert.deepEqual(c.state.queued, []);
  f.intercept = async method => {
    if (method === 'thread/queue/add') throw new DeliveryError('unknown', method, 2, 'lost queue acknowledgement');
  };
  await c.setDraft('do not repeat');
  await assert.rejects(c.followup('do not repeat', 'queue'), /lost queue/);
  assert.equal(c.state.status, 'unknown');
  assert.equal(c.state.draft, 'do not repeat');
  assert.equal(f.connected, false);
});
test('follow-up preflight cannot steer a different or already completed turn', async t => {
  let release!: () => void,
    reached!: () => void,
    hold = false;
  const gate = new Promise<void>(resolve => {
      release = resolve;
    }),
    ready = new Promise<void>(resolve => {
      reached = resolve;
    });
  const { c, f } = await fixture(t, {}, async () => {
    if (hold) {
      reached();
      await gate;
    }
  });
  await c.newThread();
  await c.send('initial');
  hold = true;
  const followup = c.followup('stale', 'steer');
  await ready;
  f.complete();
  release();
  await assert.rejects(followup, /turn changed/);
  assert.equal(
    f.calls.some(x => x.method === 'turn/steer'),
    false,
  );
});

test('forking an explicit source from a fresh channel never writes its empty draft to the parent', async t => {
  const { c, f, store } = await fixture(t);
  await store.update('draft.native-chat', 'unsent parent draft');
  await c.continueThread(true, 'native-chat');
  assert.equal(c.state.threadId, 'forked-chat');
  assert.equal(store.get('draft.native-chat', ''), 'unsent parent draft');
  assert.equal(
    f.calls.some(call => call.method === 'thread/resume'),
    false,
  );
});
test('opening stored history from a fresh channel restores its draft without overwriting it', async t => {
  const { c, store } = await fixture(t);
  await store.update('draft.native-chat', 'history draft');
  await c.openThread('native-chat');
  assert.equal(c.state.draft, 'history draft');
  assert.equal(store.get('draft.native-chat', ''), 'history draft');
});

test('settings cannot claim a new policy while native queued work still uses the previous task settings', async t => {
  const { c, f } = await fixture(t);
  await c.newThread();
  await c.send('initial');
  await c.followup('queued', 'queue');
  f.complete();
  await assert.rejects(c.configurePolicy(':read-only'), /queued work/);
  await assert.rejects(c.configure('native-model', 'low', 'default'), /queued work/);
  assert.equal(c.state.profile, ':workspace');
  assert.equal(c.state.effort, 'max');
  await c.removeQueued('queued');
  await c.configurePolicy(':read-only');
  assert.equal(c.state.profile, ':read-only');
});

const settle = () => new Promise(resolve => setImmediate(resolve));
test('child agent output stays passive, sibling threads are refused and Stop targets only its current turn', async t => {
  const { c, f, root } = await fixture(t);
  await c.newThread();
  f.intercept = async (method, p) => {
    if (method === 'thread/read' && p.threadId !== f.id)
      return {
        thread: {
          ...f.thread(),
          id: p.threadId,
          parentThreadId: p.threadId === 'child' ? f.id : 'foreign-parent',
          cwd: root,
          status: { type: 'active' },
        },
      };
    if (method === 'thread/read' && p.threadId === 'foreign-parent')
      return { thread: { ...f.thread(), id: 'foreign-parent', parentThreadId: null } };
    if (method === 'thread/list' && p.ancestorThreadId) return { data: [{ id: 'child' }], nextCursor: null };
    if (method === 'thread/turns/list' && p.threadId === 'child')
      return {
        data: [
          {
            id: 'child-turn',
            status: 'inProgress',
            itemsView: 'full',
            items: [{ id: 'child-message', type: 'agentMessage', text: 'synthetic child transcript' }],
          },
        ],
        nextCursor: null,
      };
    if (method === 'turn/interrupt') return {};
  };
  await c.agents.refresh();
  assert.equal(c.state.agents?.tasks[0].id, 'child');
  await c.agents.open('child');
  assert.match(c.state.agents!.selected!.items[0].text, /synthetic child/);
  assert.equal(c.state.items.length, 0);
  assert.equal(
    f.calls.some(x => x.method === 'thread/resume' || x.method === 'turn/start'),
    false,
  );
  await assert.rejects(c.agents.open('sibling'), /different|ancestry/);
  await c.stopAgent('child');
  assert.deepEqual(f.calls.find(x => x.method === 'turn/interrupt')!.params, {
    threadId: 'child',
    turnId: 'child-turn',
  });
  c.state.writable = false;
  await assert.rejects(c.stopAgent('child'), /owning/);
});
test('child approvals retain their own turn and survive parent completion; unrelated requests never route', async t => {
  const { c, f, root } = await fixture(t);
  await c.newThread();
  await c.send('parent');
  f.intercept = async (method, p) => {
    if (method === 'thread/read' && p.threadId === 'child')
      return { thread: { ...f.thread(), id: 'child', parentThreadId: f.id, cwd: root } };
    if (method === 'thread/read' && p.threadId !== f.id)
      return { thread: { ...f.thread(), id: p.threadId, parentThreadId: null } };
    if (method === 'thread/turns/list' && p.threadId === 'child')
      return { data: [{ id: 'child-turn', status: 'inProgress', items: [] }], nextCursor: null };
  };
  f.approval({ threadId: 'child', turnId: 'child-turn' });
  for (let i = 0; i < 100 && !c.state.decisions.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const d = c.state.decisions[0];
  assert.ok(d);
  assert.equal(d.threadId, 'child');
  f.complete();
  assert.equal(c.state.decisions.length, 1);
  assert.equal(c.state.status, 'waiting');
  c.decide(d.id, d.token, undefined, false, true);
  assert.equal(f.responses.at(-1).result.scope, 'turn');
  assert.equal(c.state.status, 'completed');
  f.approval({ threadId: 'sibling', turnId: 'other-turn' });
  for (let i = 0; i < 100 && !f.responses.at(-1).error; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(c.state.decisions.length, 0);
  assert.equal(f.responses.at(-1).error, true);
});
test('child completion expires its approval without deleting an active parent decision', async t => {
  const { c, f, root } = await fixture(t);
  await c.newThread();
  await c.send('parent');
  f.approval();
  const parent = c.state.decisions[0];
  f.emit('notification', {
    method: 'thread/started',
    params: { thread: { ...f.thread(), id: 'child', parentThreadId: f.id, cwd: root } },
  });
  f.emit('notification', { method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } });
  f.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'child', turn: { id: 'child-turn', status: 'interrupted' } },
  });
  assert.equal(c.state.decisions[0].token, parent.token);
  c.decide(parent.id, parent.token);
  assert.equal(c.state.status, 'running');
});
test('MCP URL elicitation keeps the authorization URL private and cancels requests without turn identity', async t => {
  const { c, f } = await fixture(t);
  await c.newThread();
  await c.send('request');
  f.approval(
    {
      mode: 'url',
      serverName: 'fixture',
      message: 'Continue authorization at https://authorize.example/?state=PRIVATE_STATE',
      url: 'https://authorize.example/?state=PRIVATE_STATE',
    },
    'mcpServer/elicitation/request',
  );
  const d = c.state.decisions[0];
  assert.equal(d.canAccept, true);
  assert.equal(d.summary?.includes('PRIVATE_STATE'), false);
  assert.match(c.authorization(d.id, d.token), /PRIVATE_STATE/);
  c.decide(d.id, d.token, undefined, false, true);
  assert.deepEqual(f.responses.at(-1).result, { action: 'accept', content: null, _meta: null });
  f.approval({ turnId: null, mode: 'url', serverName: 'fixture' }, 'mcpServer/elicitation/request');
  assert.equal(f.responses.at(-1).result.action, 'cancel');
});
test('MCP form decisions validate the private schema, expire with the turn and never open an authorization page', async t => {
  const { c, f } = await fixture(t);
  await c.newThread();
  await c.send('request');
  const params = {
    mode: 'form',
    serverName: 'fixture',
    message: 'Choose a count',
    requestedSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] },
  };
  f.approval(params, 'mcpServer/elicitation/request');
  let d = c.state.decisions[0];
  assert.ok(d.form);
  assert.equal(d.canAccept, true);
  assert.throws(() => c.authorization(d.id, d.token), /no supported authorization/);
  assert.throws(() => c.decide(d.id, d.token, undefined, false, true, { count: 0 }));
  assert.equal(f.responses.length, 0);
  // A renderer projection cannot relax the authoritative request snapshot.
  d.form!.fields[0].minimum = 0;
  assert.throws(() => c.decide(d.id, d.token, undefined, false, true, { count: 0 }));
  c.decide(d.id, d.token, undefined, false, true, { count: 1 });
  assert.deepEqual(f.responses.at(-1).result, { action: 'accept', content: { count: 1 }, _meta: null });
  f.approval(params, 'mcpServer/elicitation/request');
  d = c.state.decisions[0];
  f.complete();
  assert.throws(() => c.decide(d.id, d.token, undefined, false, true, { count: 1 }), /expired/);
});
test('unsupported or restricted MCP forms stay decline/cancel only and declined values never leave the client', async t => {
  const { c, f } = await fixture(t);
  await c.newThread();
  await c.send('request');
  for (const mode of ['form', 'openai/form', 'openaiForm']) {
    f.approval(
      {
        mode,
        serverName: 'fixture',
        message: 'unsupported',
        requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } },
      },
      'mcpServer/elicitation/request',
    );
    const d = c.state.decisions[0];
    assert.equal(d.canAccept, false);
    assert.throws(() => c.decide(d.id, d.token, undefined, false, true, {}));
    c.decide(d.id, d.token, undefined, false, false, { ignored: 'private' });
    assert.deepEqual(f.responses.at(-1).result, { action: 'decline', content: null, _meta: null });
  }
  c.state.permission = 'reviewed';
  f.approval(
    { mode: 'form', serverName: 'fixture', message: 'restricted', requestedSchema: { type: 'object', properties: {} } },
    'mcpServer/elicitation/request',
  );
  const d = c.state.decisions[0];
  assert.equal(d.canAccept, false);
  assert.throws(() => c.decide(d.id, d.token, undefined, false, true, {}));
  c.decide(d.id, d.token, undefined, true);
  assert.equal(f.responses.at(-1).result.action, 'cancel');
});
test('native usage keeps missing data unknown, isolates child updates and clears on reconnect', async t => {
  const { c, f, root, defaults } = await fixture(t);
  await c.newThread();
  let reads = 0;
  f.intercept = async method => {
    if (method === 'account/rateLimits/read') {
      reads++;
      return { accountId: 'PRIVATE_ACCOUNT', rateLimits: { limitId: 'codex', primary: { usedPercent: 10 } } };
    }
  };
  await c.refreshUsage();
  assert.equal(reads, 1);
  assert.equal(c.state.usage?.buckets[0].windows[0].usedPercent, 10);
  assert.ok(!JSON.stringify(c.state.usage).includes('PRIVATE_ACCOUNT'));
  f.emit('notification', { method: 'account/rateLimits/updated', params: { rateLimits: {} } });
  assert.equal(c.state.usage?.stale, true);
  f.emit('notification', {
    method: 'thread/tokenUsage/updated',
    params: { threadId: 'unrelated', tokenUsage: { modelContextWindow: 100 } },
  });
  assert.equal(c.state.tokenUsage, undefined);
  f.emit('notification', {
    method: 'thread/tokenUsage/updated',
    params: { threadId: f.id, tokenUsage: { modelContextWindow: 100 } },
  });
  const tokens = c.state.tokenUsage as import('../src/runtime/usage').TokenUsage | undefined;
  assert.equal(tokens?.contextWindow, 100);
  assert.equal(tokens?.total.input, null);
  const next = new Native(root);
  await c.attach(next as unknown as RuntimeClient, '0.152.0', defaults);
  assert.equal(c.state.usage, undefined);
  assert.equal(c.state.tokenUsage, undefined);
  let finish!: (value: any) => void;
  next.intercept = async method => {
    if (method === 'account/rateLimits/read')
      return new Promise(resolve => {
        finish = resolve;
      });
  };
  const read = c.refreshUsage();
  next.stop();
  finish({ rateLimits: { primary: { usedPercent: 1 } } });
  await read;
  assert.equal(c.state.usage, undefined);
});

test('a duplicate child RPC id closes the connection before any asynchronous ancestry lookup or approval', async t => {
  const { c, f } = await fixture(t);
  await c.newThread();
  await c.send('parent');
  f.approval();
  const previous = c.state.decisions[0];
  let reads = 0;
  f.intercept = async method => {
    if (method === 'thread/read') {
      reads++;
      return new Promise(() => {});
    }
  };
  f.approval({ threadId: 'child', turnId: 'child-turn' });
  assert.equal(f.connected, false);
  assert.equal(reads, 0);
  assert.throws(() => c.decide(17, previous.token, undefined, false, true), /expired/);
  assert.equal(f.responses.length, 0);
});
test('late child metadata cannot hide active work or allow native preference changes', async t => {
  const { c, f, root } = await fixture(t);
  await c.newThread();
  await c.send('parent');
  f.complete();
  const child = { ...f.thread(), id: 'child', parentThreadId: f.id, cwd: root, status: { type: 'idle' } };
  f.emit('notification', { method: 'thread/started', params: { thread: child } });
  let release!: (value: any) => void;
  const pending = new Promise(resolve => {
    release = resolve;
  });
  f.intercept = async (method, p) => {
    if (method === 'thread/read' && p.threadId === 'child') return pending;
  };
  const checking = c.agents.verify('child');
  f.emit('notification', { method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } });
  release({ thread: structuredClone(child) });
  await checking;
  assert.equal(c.agents.state.tasks[0].status, 'running');
  assert.equal(c.state.agents?.busy, true);
  await assert.rejects(c.configurePolicy(':read-only'), /child agents/);
  await assert.rejects(c.configure('native-model', 'low', 'default'), /child agents/);
  assert.equal(c.state.profile, ':workspace');
  f.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'child', turn: { id: 'child-turn', status: 'interrupted' } },
  });
  assert.equal(c.agents.active, false);
  await c.configurePolicy(':read-only');
});

test('native collaboration events discover a child without resuming it, and failed discovery keeps shared settings blocked', async t => {
  const { c, f, root } = await fixture(t);
  await c.newThread();
  f.intercept = async (method, p) => {
    if (method === 'thread/read' && p.threadId === 'child')
      return { thread: { ...f.thread(), id: 'child', parentThreadId: f.id, cwd: root, status: { type: 'active' } } };
    if (method === 'thread/turns/list' && p.threadId === 'child')
      return { data: [{ id: 'child-turn', status: 'inProgress' }], nextCursor: null };
    if (method === 'thread/read' && p.threadId === 'missing-child') throw new Error('Synthetic metadata failure');
  };
  const event = (id: string) =>
    f.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: f.id,
        turnId: 'parent',
        item: {
          type: 'collabAgentToolCall',
          id: 'collab-' + id,
          tool: 'spawnAgent',
          status: 'completed',
          receiverThreadIds: [id],
          agentsStates: {},
          prompt: null,
        },
      },
    });
  event('child');
  assert.equal(c.agents.active, true);
  for (let i = 0; i < 100 && !c.agents.hasTurn('child', 'child-turn'); i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(c.agents.hasTurn('child', 'child-turn'), true);
  assert.equal(
    f.calls.some(x => x.method === 'thread/resume'),
    false,
  );
  event('missing-child');
  for (let i = 0; i < 100 && !c.state.agents?.uncertain; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(c.state.agents?.uncertain, true);
  await assert.rejects(c.configurePolicy(':read-only'), /child agents/);
  await assert.rejects(c.archive(), /child agents/);
  await assert.rejects(c.closeChat(), /child agents/);
});

test('a child request resolved during ancestry lookup cannot reappear as an actionable approval', async t => {
  const { c, f, root } = await fixture(t);
  await c.newThread();
  let release!: (value: any) => void, reached!: () => void;
  const pending = new Promise(resolve => {
      release = resolve;
    }),
    started = new Promise<void>(resolve => {
      reached = resolve;
    });
  f.intercept = async (method, p) => {
    if (method === 'thread/read' && p.threadId === 'child') {
      reached();
      return pending;
    }
    if (method === 'thread/turns/list' && p.threadId === 'child')
      return { data: [{ id: 'child-turn', status: 'inProgress' }] };
  };
  f.approval({ threadId: 'child', turnId: 'child-turn' });
  await started;
  f.emit('notification', { method: 'serverRequest/resolved', params: { threadId: 'child', requestId: 17 } });
  release({ thread: { ...f.thread(), id: 'child', parentThreadId: f.id, cwd: root } });
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(c.state.decisions.length, 0);
  assert.equal(f.responses.length, 0);
  assert.equal(f.connected, true);
});
test('read-only chats and side questions switch off every configured MCP server and native extension', async t => {
  const { c, f } = await fixture(t, { mcp_servers: { docs: { url: 'https://x' }, 'bad name': {} } });
  await c.newThread(true);
  const reviewed = f.calls.find(x => x.method === 'thread/start')!.params.config;
  assert.equal(reviewed['mcp_servers.docs.enabled'], false);
  assert.equal(reviewed['features.hooks'], false);
  assert.equal(
    Object.keys(reviewed).some(key => key.includes('bad name')),
    false,
  );
  f.calls.length = 0;
  await c.newThread();
  f.intercept = async method =>
    method === 'thread/fork'
      ? {
          thread: { ...f.thread(), id: 'side-chat' },
          sandbox: { type: 'readOnly', networkAccess: false },
          approvalPolicy: 'never',
          modelProvider: 'openai',
        }
      : undefined;
  await c.askSide(c.state.threadId!, 'side?');
  const fork = f.calls.find(x => x.method === 'thread/fork')!.params;
  assert.equal(fork.config['mcp_servers.docs.enabled'], false);
  assert.equal(fork.config['features.plugins'], false);
});
test('a timed-out read leaves the runtime connected; nothing was written that needs reconciling', async t => {
  const { c, f } = await fixture(t);
  await c.newThread();
  f.intercept = async method => {
    if (method === 'thread/read') throw new DeliveryError('unknown', method, 1, 'Timed out');
  };
  await assert.rejects(c.openThread(c.state.threadId!), /Timed out/);
  assert.equal(f.connected, true);
});
