import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, realpath, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/sessions/coordinator';
import { DeliveryError, THREAD_NOT_FOUND, type RuntimeClient } from '../src/runtime/client';

class Fake extends EventEmitter {
  connected = true;
  responses: unknown[] = [];
  calls: { method: string; params: any }[] = [];
  turn?: (params: any) => unknown;
  account = 'chatgpt';
  terminals = ['p1', 'p2'];
  policy = 'never';
  failHistory = false;
  id = 'owned-thread';
  name: string | null = null;
  constructor(readonly root: string) {
    super();
  }
  thread() {
    return {
      id: this.id,
      cwd: this.root,
      modelProvider: 'openai',
      name: this.name,
      preview: '',
      status: { type: 'idle' },
      turns: [],
    };
  }
  async request(method: string, params: any = {}): Promise<any> {
    this.calls.push({ method, params });
    switch (method) {
      case 'account/read':
        return { account: { type: this.account }, requiresOpenaiAuth: true };
      case 'model/list':
        return {
          data: [
            {
              id: 'model',
              model: 'model',
              isDefault: true,
              hidden: false,
              defaultReasoningEffort: 'low',
              supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
            },
          ],
        };
      case 'thread/list':
        return { data: params.ancestorThreadId ? [] : [this.thread()], nextCursor: null };
      case 'thread/start':
      case 'thread/resume':
        return {
          thread: this.thread(),
          sandbox: { type: 'readOnly', networkAccess: false },
          approvalPolicy: this.policy,
          modelProvider: 'openai',
        };
      case 'thread/fork':
        return {
          thread: { ...this.thread(), id: 'side-thread' },
          sandbox: { type: 'readOnly', networkAccess: false },
          approvalPolicy: 'never',
          modelProvider: 'openai',
        };
      case 'thread/read':
        return { thread: this.thread() };
      case 'thread/turns/list':
        if (this.failHistory) throw new DeliveryError('unknown', method, 13, 'History timed out');
        return { data: [], nextCursor: null };
      case 'turn/start':
        if (this.turn) return this.turn(params);
        this.emit('notification', {
          method: 'turn/started',
          params: { threadId: params.threadId, turn: { id: 'turn', status: 'inProgress' } },
        });
        return { turn: { id: 'turn', status: 'inProgress' } };
      case 'thread/unsubscribe':
        return { status: 'unsubscribed' };
      case 'thread/name/set':
        this.name = params.name;
        return {};
      case 'turn/interrupt':
        return {};
      case 'thread/backgroundTerminals/list':
        return {
          data: this.terminals.map(processId => ({
            processId,
            command: 'npm run dev',
            cwd: this.root,
            itemId: 'i',
            osPid: 42,
            cpuPercent: 1,
            rssKb: 2048,
          })),
          nextCursor: null,
        };
      case 'thread/backgroundTerminals/terminate':
        this.terminals = this.terminals.filter(id => id !== params.processId);
        return {};
      case 'thread/backgroundTerminals/clean':
        this.terminals = [];
        return {};
      default:
        throw new Error(`Unexpected method: ${method}`);
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
}
async function setup(
  t: { after: (fn: () => Promise<void>) => void },
  dirty = false,
  review?: ConstructorParameters<typeof Coordinator>[5],
  preflight?: () => Promise<void>,
) {
  const temp = await mkdtemp(join(tmpdir(), 'codex-session-')),
    root = await realpath(temp);
  const data = new Map();
  const store = {
    get: (key: string, fallback: any) => data.get(key) ?? fallback,
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
  const c = new Coordinator(
    root,
    store,
    () => {},
    async () => {
      if (dirty) throw new Error('Dirty buffer');
      await preflight?.();
    },
    () => {},
    review,
  );
  const f = new Fake(root);
  await c.attach(f as unknown as RuntimeClient, '0.152.0');
  t.after(async () => {
    try {
      await c.dispose();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
  return { c, f, root, store };
}
test('send uses real plan mode and read-only policy, and clears the draft only on acknowledgement', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  await c.setDraft('question');
  c.state.mode = 'plan';
  f.emit('notification', { method: 'future/event', params: { threadId: 'owned-thread' } });
  await c.send('question');
  const turn = f.calls.find(x => x.method === 'turn/start')!.params;
  assert.equal(turn.collaborationMode.mode, 'plan');
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(turn.approvalPolicy, 'never');
  assert.equal(c.state.draft, '');
});
test('send attaches pasted images only for models that accept image input', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  const path = '/tmp/codex-vscode-images-x/img-1.png';
  await assert.rejects(c.send('what is this', undefined, undefined, [path]), /does not accept images/);
  assert.ok(!f.calls.some(x => x.method === 'turn/start'));
  c.state.status = 'idle';
  c.state.models[0].inputModalities = ['text', 'image'];
  await c.send('what is this', undefined, undefined, [path]);
  const turn = f.calls.find(x => x.method === 'turn/start')!.params;
  assert.deepEqual(turn.input.at(-1), { type: 'localImage', path });
  f.emit('notification', {
    method: 'turn/completed',
    params: { threadId: f.id, turn: { id: 'turn', status: 'completed' } },
  });
  await c.send('  ', undefined, undefined, [path]);
  assert.deepEqual(f.calls.filter(x => x.method === 'turn/start').at(-1)!.params.input, [{ type: 'localImage', path }]);
});
test('a passively opened chat reloads when another client appends to its rollout', async t => {
  const { c, f, root } = await setup(t);
  const rollout = join(root, 'rollout.jsonl');
  await writeFile(rollout, '{}\n');
  const thread = f.thread.bind(f);
  f.thread = () => ({ ...thread(), path: rollout });
  await c.openThread('owned-thread');
  assert.equal(c.state.writable, false);
  const loads = () => f.calls.filter(x => x.method === 'thread/turns/list').length;
  const before = loads();
  await appendFile(rollout, '{"external":true}\n');
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(loads(), before + 1);
});
test('side questions run in an ephemeral read-only fork and never touch the main chat', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  const mainItems = c.state.items.length;
  await c.askSide('owned-thread', 'what did we decide?');
  const fork = f.calls.find(x => x.method === 'thread/fork')!.params;
  assert.equal(fork.threadId, 'owned-thread');
  assert.equal(fork.ephemeral, true);
  assert.equal(fork.sandbox, 'read-only');
  const turn = f.calls.filter(x => x.method === 'turn/start').at(-1)!.params;
  assert.equal(turn.threadId, 'side-thread');
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  f.emit('notification', {
    method: 'item/completed',
    params: { threadId: 'side-thread', turnId: 'turn', item: { type: 'agentMessage', id: 'a', text: 'We chose B.' } },
  });
  f.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'side-thread', turn: { id: 'turn', status: 'completed' } },
  });
  assert.equal(c.state.items.length, mainItems);
  assert.equal(c.state.side?.items.at(-1)?.text, 'We chose B.');
  assert.equal(c.state.side?.status, 'completed');
  assert.equal(c.state.status, 'idle');
  await c.askSide('owned-thread', 'and why?');
  assert.equal(f.calls.filter(x => x.method === 'thread/fork').length, 1, 'follow-ups reuse the same side fork');
  await c.closeSide();
  assert.equal(c.state.side, undefined);
  assert.ok(f.calls.some(x => x.method === 'thread/unsubscribe' && x.params.threadId === 'side-thread'));
});
test('background terminals list, stop one and stop all through the runtime', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  await c.refreshTerminals();
  assert.deepEqual(
    c.state.terminals?.items.map(i => i.processId),
    ['p1', 'p2'],
  );
  await assert.rejects(c.stopTerminals('gone'), /Refresh first/);
  await c.stopTerminals('p1');
  assert.deepEqual(
    c.state.terminals?.items.map(i => i.processId),
    ['p2'],
  );
  await c.stopTerminals();
  assert.deepEqual(c.state.terminals?.items, []);
  assert.ok(f.calls.some(x => x.method === 'thread/backgroundTerminals/clean'));
});
test('slow account metadata does not block connection or history and never starts login', async t => {
  const { c, root } = await setup(t),
    next = new Fake(root),
    request = next.request.bind(next);
  let release!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  next.request = async (method, params) => {
    if (method === 'account/read') await held;
    return request(method, params);
  };
  const reconnecting = c.attach(next as unknown as RuntimeClient, '0.152.0');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.state.account, 'unknown');
  await Promise.race([
    reconnecting,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Account blocked readiness')), 100)),
  ]);
  assert.equal(c.state.status, 'idle');
  await c.openThread('owned-thread');
  assert.equal(c.state.threadId, 'owned-thread');
  assert.equal(c.state.account, 'unknown');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.state.account, 'chatgpt');
  assert.equal(
    next.calls.some(call => call.method === 'account/login/start'),
    false,
  );
  next.stop();
  assert.equal(c.state.account, 'unknown');
});
test('late account results cannot overwrite a reconnected or disconnected session', async t => {
  const { c, root } = await setup(t);
  const old = new Fake(root),
    current = new Fake(root);
  const original = old.request.bind(old);
  let release!: (value: any) => void;
  old.request = (method, params) =>
    method === 'account/read'
      ? new Promise(resolve => {
          release = resolve;
        })
      : original(method, params);
  await c.attach(old as unknown as RuntimeClient, 'fixture');
  current.account = 'apiKey';
  await c.attach(current as unknown as RuntimeClient, 'fixture');
  release({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.state.account, 'apiKey');
  const disconnected = new Fake(root),
    request = disconnected.request.bind(disconnected);
  disconnected.request = (method, params) =>
    method === 'account/read'
      ? new Promise(resolve => {
          release = resolve;
        })
      : request(method, params);
  await c.attach(disconnected as unknown as RuntimeClient, 'fixture');
  disconnected.stop();
  release({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.state.account, 'unknown');
});
test('account metadata failure stays unknown and does not leak errors or block history', async t => {
  const { c, root } = await setup(t),
    next = new Fake(root),
    request = next.request.bind(next);
  next.request = async (method, params) => {
    if (method === 'account/read') throw new Error('PRIVATE_AUTH_DETAIL');
    return request(method, params);
  };
  await c.attach(next as unknown as RuntimeClient, 'fixture');
  assert.equal(c.state.account, 'unknown');
  assert.equal(c.state.accountReadFailed, true);
  assert.equal(c.state.status, 'idle');
  assert.ok(!JSON.stringify(c.state).includes('PRIVATE_AUTH_DETAIL'));
  await c.openThread('owned-thread');
  assert.equal(c.state.threadId, 'owned-thread');
});
test('dirty buffers block before turn delivery', async t => {
  const { c, f } = await setup(t, true);
  await c.newThread();
  await c.setDraft('draft');
  await assert.rejects(c.send('question'), /Dirty buffer/);
  assert.equal(
    f.calls.some(x => x.method === 'turn/start'),
    false,
  );
  assert.equal(c.state.draft, 'draft');
  assert.equal(c.state.status, 'failed');
});
test('new-thread history loading remains visibly exclusive even after the thread identity is available', async t => {
  const { c, f } = await setup(t),
    request = f.request.bind(f);
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => {
      release = resolve;
    }),
    loading = new Promise<void>(resolve => {
      reached = resolve;
    });
  f.request = async (method, params) => {
    if (method === 'thread/list') {
      reached();
      await held;
    }
    return request(method, params);
  };
  const opening = c.newThread();
  await loading;
  assert.equal(c.state.threadId, 'owned-thread');
  assert.equal(c.state.operationBusy, true);
  await assert.rejects(c.send('too early'), /active operation/);
  release();
  await opening;
  assert.equal(c.state.operationBusy, false);
  assert.equal(
    f.calls.some(call => call.method === 'turn/start'),
    false,
  );
});
test('turn completion before RPC acknowledgement does not regress to running', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  f.turn = () => {
    f.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'owned-thread', turn: { id: 'turn', status: 'completed' } },
    });
    return { turn: { id: 'turn', status: 'inProgress' } };
  };
  await c.send('question');
  assert.equal(c.state.status, 'completed');
});
test('RPC acceptance alone is not proof that a turn can be interrupted', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  f.turn = () => ({ turn: { id: 'turn', status: 'inProgress' } });
  await c.send('question');
  assert.equal(c.state.status, 'starting');
  await assert.rejects(c.cancel(), /turn-start event/);
  f.emit('notification', {
    method: 'turn/started',
    params: { threadId: 'owned-thread', turn: { id: 'turn', status: 'inProgress' } },
  });
  await c.cancel();
  assert.equal(c.state.status, 'interrupting');
  f.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'owned-thread', turn: { id: 'turn', status: 'interrupted' } },
  });
  assert.equal(c.state.status, 'interrupted');
});
test('late events from a replaced runtime cannot answer a request on a new connection', async t => {
  const { c, f, root } = await setup(t);
  await c.newThread();
  const newer = new Fake(root);
  await c.attach(newer as unknown as RuntimeClient, '0.152.0');
  f.emit('request', {
    id: 1,
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'owned-thread', turnId: 'wrong', itemId: 'i' },
  });
  f.emit('notification', { method: 'turn/started', params: { threadId: 'owned-thread', turn: { id: 'wrong' } } });
  assert.deepEqual(newer.responses, []);
  assert.equal(c.state.status, 'idle');
});
test('unknown delivery preserves the draft and blocks repeat send until history reconciliation', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  await c.setDraft('draft');
  f.turn = () => {
    throw new DeliveryError('unknown', 'turn/start', 42, 'No acknowledgement');
  };
  await assert.rejects(c.send('question'));
  assert.equal(c.state.status, 'unknown');
  assert.equal(c.state.draft, 'draft');
  await assert.rejects(c.send('again'), /Reload history/);
  assert.equal(f.calls.filter(x => x.method === 'turn/start').length, 1);
});
test('native authentication rejection while account metadata is pending preserves the draft without replay', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  c.state.account = 'unknown';
  await c.setDraft('draft');
  f.turn = () => {
    throw new DeliveryError('rejected', 'turn/start', 401, 'Runtime rejected request (401)');
  };
  await assert.rejects(c.send('question'), /401/);
  assert.equal(c.state.draft, 'draft');
  assert.equal(f.calls.filter(x => x.method === 'turn/start').length, 1);
  assert.equal(
    f.calls.some(x => x.method === 'account/login/start'),
    false,
  );
});
test('failed history reconciliation never unlocks sending after an unknown outcome', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  c.state.status = 'unknown';
  f.failHistory = true;
  await assert.rejects(c.openThread('owned-thread'), /History timed out/);
  assert.equal(c.state.status, 'unknown');
  await assert.rejects(c.send('retry'), /Reload history/);
  assert.equal(
    f.calls.some(x => x.method === 'turn/start'),
    false,
  );
});
test('reconnection never sends in the gap between model discovery and history hydration', async t => {
  const { c, root } = await setup(t);
  await c.newThread();
  const replacement = new Fake(root);
  let release!: () => void, reached!: () => void;
  const listed = new Promise<void>(resolve => {
    reached = resolve;
  });
  const blocked = new Promise<void>(resolve => {
    release = resolve;
  });
  const request = replacement.request.bind(replacement);
  replacement.request = async (method, params) => {
    if (method === 'thread/list') {
      reached();
      await blocked;
    }
    return request(method, params);
  };
  const reconnected = c.attach(replacement as unknown as RuntimeClient, '0.152.0');
  await listed;
  await assert.rejects(c.send('stale draft'), /active operation|connection and history/);
  release();
  await reconnected;
  assert.equal(
    replacement.calls.some(x => x.method === 'turn/start'),
    false,
  );
  c.state.status = 'offline';
  await assert.rejects(c.send('offline'), /connection and history/);
});
test('approvals keep identities, reject cross-thread requests and resolve at most once', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  await c.send('question');
  f.emit('request', {
    id: 'wrong',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'other', turnId: 'turn', itemId: 'item' },
  });
  assert.equal(c.state.decisions.length, 0);
  f.emit('request', {
    id: 'decision',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'owned-thread', turnId: 'turn', itemId: 'item' },
  });
  c.decide('decision', c.state.decisions[0]?.token ?? 'expired');
  assert.deepEqual(f.responses.at(-1), { id: 'decision', result: { decision: 'decline' } });
  assert.throws(() => c.decide('decision', c.state.decisions[0]?.token ?? 'expired'), /expired/);
});
test('a native file approval can only be accepted when its change list is known', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  await c.send('edit');
  c.state.permission = 'agent'; // exercise the native branch with the fake runtime
  f.emit('request', {
    id: 'unseen',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'owned-thread', turnId: 'turn', itemId: 'never-started' },
  });
  const unseen = c.state.decisions.find(d => d.id === 'unseen')!;
  assert.equal(unseen.canAccept, false);
  assert.throws(() => c.decide('unseen', unseen.token, undefined, false, true), /cannot be approved/);
  f.emit('notification', {
    method: 'item/started',
    params: {
      threadId: 'owned-thread',
      turnId: 'turn',
      item: {
        type: 'fileChange',
        id: 'seen',
        status: 'inProgress',
        changes: [{ path: 'a.txt', kind: { type: 'add' }, diff: 'x\n' }],
      },
    },
  });
  f.emit('request', {
    id: 'visible',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'owned-thread', turnId: 'turn', itemId: 'seen' },
  });
  const visible = c.state.decisions.find(d => d.id === 'visible')!;
  assert.equal(visible.canAccept, true);
  assert.deepEqual(visible.changes, [{ path: 'a.txt', kind: 'add', added: 1, removed: 0 }]);
  c.decide('visible', visible.token, undefined, false, true, undefined, true);
  assert.deepEqual(f.responses.at(-1), { id: 'visible', result: { decision: 'acceptForSession' } });
});
test('sign-in mode is display-only, and an ineffective permission policy fails closed', async t => {
  const { c, root } = await setup(t);
  const f = new Fake(root);
  f.account = 'amazonBedrock';
  await c.attach(f as unknown as RuntimeClient, '0.152.0');
  assert.equal(c.state.account, 'provider');
  const keyed = new Fake(root);
  keyed.account = 'apiKey';
  await c.attach(keyed as unknown as RuntimeClient, '0.152.0');
  assert.equal(c.state.account, 'apiKey');
  keyed.policy = 'on-request';
  await assert.rejects(c.newThread(), /did not honor/);
  assert.equal(keyed.connected, false);
});
test('client editing is authorized per turn, correlated, and aborted before interruption', async t => {
  const signals: AbortSignal[] = [];
  const { c, f } = await setup(t, false, async (_call, signal) => {
    signals.push(signal);
    return new Promise(resolve =>
      signal.addEventListener('abort', () => resolve({ success: false, contentItems: [] }), { once: true }),
    );
  });
  await c.newThread();
  const request = (id: string, turnId = 'turn') => ({
    id,
    method: 'item/tool/call',
    params: {
      threadId: 'owned-thread',
      turnId,
      callId: id,
      namespace: null,
      tool: 'propose_text_edits',
      arguments: {},
    },
  });
  await c.send('read only');
  f.emit('request', request('readonly'));
  assert.equal(signals.length, 0);
  f.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'owned-thread', turn: { id: 'turn', status: 'completed' } },
  });
  c.state.permission = 'reviewed';
  await c.send('edit');
  f.emit('request', request('wrong-turn', 'other'));
  assert.equal(signals.length, 0);
  f.emit('request', request('allowed'));
  assert.equal(c.state.status, 'waiting');
  assert.equal(signals.length, 1);
  await c.cancel();
  assert.equal(signals[0].aborted, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    f.responses.some((r: any) => r.id === 'allowed'),
    false,
  );
});
test('Plan mode always refuses client edits even when reviewed permission is selected', async t => {
  let reviews = 0;
  const { c, f } = await setup(t, false, async () => {
    reviews++;
    return { success: true, contentItems: [] };
  });
  await c.newThread();
  c.state.mode = 'plan';
  c.state.permission = 'reviewed';
  await c.send('plan');
  f.emit('request', {
    id: 'p',
    method: 'item/tool/call',
    params: {
      threadId: 'owned-thread',
      turnId: 'turn',
      callId: 'p',
      namespace: null,
      tool: 'propose_text_edits',
      arguments: {},
    },
  });
  assert.equal(reviews, 0);
  assert.equal((f.responses.at(-1) as any).result.success, false);
});
test('a late async review from an old connection cannot answer or cancel a new request with the same ID', async t => {
  const pending: { resolve: (value: any) => void; signal: AbortSignal }[] = [];
  const { c, f, root } = await setup(
    t,
    false,
    async (_call, signal) => new Promise(resolve => pending.push({ resolve, signal })),
  );
  await c.newThread();
  c.state.permission = 'reviewed';
  await c.send('edit');
  const message = {
    id: 'shared',
    method: 'item/tool/call',
    params: {
      threadId: 'owned-thread',
      turnId: 'turn',
      callId: 'call',
      namespace: null,
      tool: 'propose_text_edits',
      arguments: {},
    },
  };
  f.emit('request', message);
  const replacement = new Fake(root);
  await c.attach(replacement as unknown as RuntimeClient, '0.152.0');
  await c.continueThread();
  await c.send('new edit');
  replacement.emit('request', message);
  assert.equal(pending.length, 2);
  pending[0].resolve({ success: true, contentItems: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replacement.responses, []);
  await c.cancel();
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve({ success: false, contentItems: [] });
});
test('drafts remain per chat, delayed draft messages keep their origin, and close preserves history without replay', async t => {
  const { c, f, store } = await setup(t);
  await c.newThread();
  await c.setDraft('first draft');
  f.id = 'second-thread';
  await c.newThread();
  assert.equal(c.state.draft, '');
  await c.setDraft('second draft');
  f.id = 'owned-thread';
  await c.openThread('owned-thread');
  assert.equal(c.state.draft, 'first draft');
  await c.setDraft('late second draft', 'second-thread');
  assert.equal(c.state.draft, 'first draft');
  assert.equal(store.get('draft.second-thread', ''), 'late second draft');
  c.state.status = 'unknown';
  await c.closeChat();
  assert.equal(c.state.status, 'offline');
  assert.equal(c.state.threadId, undefined);
  assert.equal(store.get('lastThread', ''), '');
  assert.equal(store.get('draft.owned-thread', ''), 'first draft');
  await assert.rejects(c.send('retry'), /connection and history/);
  assert.equal(
    f.calls.some(call => call.method === 'turn/start'),
    false,
  );
});
test('reviewed history opens without a writer and first Send resumes with the read-only policy', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  f.id = 'second-thread';
  await c.newThread();
  f.id = 'owned-thread';
  await c.openThread(f.id);
  assert.equal(c.state.writable, false);
  assert.equal(f.calls.filter(call => call.method === 'thread/resume').length, 0);
  await c.setDraft('continue seamlessly');
  await c.send('continue seamlessly');
  const resume = f.calls.filter(call => call.method === 'thread/resume');
  assert.equal(resume.length, 1);
  assert.equal(resume[0].params.sandbox, 'read-only');
  assert.equal(resume[0].params.approvalPolicy, 'never');
  assert.equal(c.state.writable, true);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(c.state.draft, '');
});
test('writer refusal on explicit continuation blocks sending and still allows passive history recovery', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  await c.openThread(f.id);
  const request = f.request.bind(f);
  let resumes = 0;
  f.request = async (method, params) => {
    if (method === 'thread/resume') {
      resumes++;
      throw new DeliveryError(
        'rejected',
        method,
        12,
        'Thread has an active writer in another Codex client. Close it before resuming.',
      );
    }
    return request(method, params);
  };
  await assert.rejects(c.continueThread(), /active writer/);
  assert.equal(c.state.writable, false);
  assert.equal(c.state.status, 'unknown');
  await assert.rejects(c.send('must not send'));
  await c.openThread(f.id);
  assert.equal(c.state.status, 'idle');
  assert.equal(c.state.writable, false);
  assert.equal(resumes, 1);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 0);
});
test('a new draft typed while turn/start is pending is never erased by its acknowledgement', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  await c.setDraft('submitted');
  let release!: () => void;
  const paused = new Promise<void>(resolve => {
    release = resolve;
  });
  f.turn = async () => {
    await paused;
    return { turn: { id: 'turn', status: 'inProgress' } };
  };
  const sending = c.send('submitted');
  while (!f.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
  await c.setDraft('next draft');
  release();
  await sending;
  assert.equal(c.state.draft, 'next draft');
});
test('chat identity and draft switch together after persistence, even with delayed draft broadcasts', async t => {
  const { c, f, store } = await setup(t);
  await c.newThread();
  await c.setDraft('A draft');
  f.id = 'second-thread';
  await c.newThread();
  await c.setDraft('B draft');
  f.id = 'owned-thread';
  await c.openThread('owned-thread');
  const update = store.update.bind(store);
  let release!: () => void, reached!: () => void;
  const paused = new Promise<void>(resolve => {
      release = resolve;
    }),
    persisting = new Promise<void>(resolve => {
      reached = resolve;
    });
  store.update = async (key, value) => {
    if (key === 'lastThread' && value === 'second-thread') {
      reached();
      await paused;
    }
    return update(key, value);
  };
  f.id = 'second-thread';
  const opening = c.openThread('second-thread');
  await persisting;
  await c.setDraft('late A draft', 'owned-thread');
  assert.equal(c.state.threadId, 'owned-thread');
  assert.equal(c.state.draft, 'late A draft');
  release();
  await opening;
  assert.equal(c.state.threadId, 'second-thread');
  assert.equal(c.state.draft, 'B draft');
});
test('restart reopens the last selected chat with its unsent draft, without sending a turn', async t => {
  const { c, f, root, store } = await setup(t);
  await c.newThread();
  await c.setDraft('recover draft');
  await c.dispose();
  const reloaded = new Coordinator(
    root,
    store,
    () => {},
    async () => {},
    () => {},
  );
  assert.equal(reloaded.state.threadId, 'owned-thread');
  assert.equal(reloaded.state.draft, 'recover draft');
  const runtime = new Fake(root);
  await reloaded.attach(runtime as unknown as RuntimeClient, '0.152.0');
  try {
    assert.equal(reloaded.state.status, 'idle');
    assert.equal(reloaded.state.draft, 'recover draft');
    assert.equal(
      runtime.calls.some(call => call.method === 'turn/start'),
      false,
    );
    assert.equal(f.connected, false);
  } finally {
    await reloaded.dispose();
  }
});
test('full-text results are scoped to the canonical workspace and older searches cannot replace newer ones', async t => {
  const { c, f, root } = await setup(t);
  await mkdir(join(root, 'foreign'));
  const request = f.request.bind(f);
  const releases = new Map<string, () => void>();
  f.request = async (method, params) => {
    if (method !== 'thread/search') return request(method, params);
    if (params.searchTerm === 'old') await new Promise<void>(resolve => releases.set('old', resolve));
    return {
      data: [
        { thread: { ...f.thread(), name: params.searchTerm }, snippet: 'message result' },
        { thread: { ...f.thread(), id: 'foreign', cwd: join(root, 'foreign') }, snippet: 'exclude' },
      ],
      nextCursor: null,
    };
  };
  const older = c.listSessions(false, 'old', false, true);
  await c.listSessions(false, 'new', true, true);
  releases.get('old')!();
  await older;
  assert.equal(c.state.sessions.length, 1);
  assert.equal(c.state.sessions[0].title, 'new');
  assert.equal(c.state.sessionsArchived, true);
  await c.bookmark('owned-thread');
  assert.equal(c.state.sessions[0].bookmarked, true);
});
test('unknown archive outcomes disable repeat mutation until explicit recovery', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  const request = f.request.bind(f);
  let attempts = 0;
  f.request = async (method, params) => {
    if (method === 'thread/archive') {
      attempts++;
      throw new DeliveryError('unknown', method, 99, 'Unknown archive outcome');
    }
    return request(method, params);
  };
  await assert.rejects(c.archive(), /Unknown archive/);
  assert.equal(c.state.status, 'unknown');
  await assert.rejects(c.archive(), /idle chat/);
  await assert.rejects(c.rename('new name'), /idle chat/);
  assert.equal(attempts, 1);
});
test('sending older text from another view cannot clear a newer unsent draft', async t => {
  const { c } = await setup(t);
  await c.newThread();
  await c.setDraft('new unsent draft');
  await c.send('older visible text');
  assert.equal(c.state.draft, 'new unsent draft');
});
test('send preflight is already busy, so checkpoint confirmation cannot start restoration', async t => {
  let release!: () => void;
  const paused = new Promise<void>(resolve => {
    release = resolve;
  });
  const { c, f } = await setup(t, false, undefined, () => paused);
  await c.newThread();
  const sending = c.send('request');
  assert.equal(c.state.status, 'starting');
  assert.equal(
    f.calls.some(call => call.method === 'turn/start'),
    false,
  );
  release();
  await sending;
});
test('unknown unarchive outcomes cannot be resubmitted before reconciliation', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  await c.listSessions(false, '', true);
  const request = f.request.bind(f);
  let attempts = 0;
  f.request = async (method, params) => {
    if (method === 'thread/unarchive') {
      attempts++;
      throw new DeliveryError('unknown', method, 99, 'Unknown restore outcome');
    }
    return request(method, params);
  };
  await assert.rejects(c.unarchive('owned-thread'), /Unknown restore/);
  await assert.rejects(c.unarchive('owned-thread'), /reconciling/);
  assert.equal(attempts, 1);
});

test('send includes the captured editor selection, identifies its lines and keeps it out of persistent attachments', async t => {
  const { c, f, root } = await setup(t);
  await c.newThread();
  const editor = {
    id: 'editor-one',
    label: 'src/main.ts:2-3',
    uri: `file://${root}/src/main.ts`,
    text: 'selected only',
    version: 4,
    startLine: 2,
    endLine: 3,
    kind: 'selection' as const,
  };
  await c.send('Explain these lines', editor);
  const text = f.calls.find(x => x.method === 'turn/start')!.params.input[0].text;
  assert.match(text, /Selected code: src\/main.ts:2-3/);
  assert.match(text, /selected only/);
  assert.equal(c.state.contexts.length, 0);
});
test('pinned context takes precedence over automatic context for the same canonical file through an alias', async t => {
  const { c, f, root } = await setup(t);
  await c.newThread();
  const base = {
    id: 'pinned',
    path: 'main.ts',
    label: 'main.ts:1-1',
    uri: `file://${root}/main.ts`,
    text: 'explicit pinned selection',
    version: 1,
    startLine: 1,
    endLine: 1,
    kind: 'selection' as const,
  };
  c.state.contexts = [base];
  await c.send('Explain', { ...base, id: 'auto', uri: `file://${root}/alias.ts`, text: 'automatic full file' });
  const text = f.calls.find(x => x.method === 'turn/start')!.params.input[0].text;
  assert.match(text, /explicit pinned selection/);
  assert.doesNotMatch(text, /automatic full file/);
});
test('whole files are sent as path references without their contents', async t => {
  const { c, f, root } = await setup(t);
  await c.newThread();
  const file = {
    id: 'file',
    path: 'src/big.ts',
    label: 'src/big.ts:1-900',
    uri: `file://${root}/src/big.ts`,
    text: '',
    version: 1,
    startLine: 1,
    endLine: 900,
    kind: 'file' as const,
  };
  await c.send('Review this file', file);
  const text = f.calls.find(x => x.method === 'turn/start')!.params.input[0].text;
  assert.match(text, /\[Referenced file: src\/big.ts\]/);
});
test('a restored chat the runtime never persisted starts empty instead of an unknown outcome', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-session-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = new Map<string, unknown>([['lastThread', 'empty-thread']]);
  const store = {
    get: (key: string, fallback: any) => data.get(key) ?? fallback,
    update: async (key: string, value: unknown) => void data.set(key, value),
  };
  const c = new Coordinator(
    root,
    store,
    () => {},
    async () => {},
    () => {},
  );
  t.after(() => c.dispose());
  const f = new Fake(root);
  const request = f.request.bind(f);
  f.request = async (method, params) => {
    if (method === 'thread/read') throw new DeliveryError('rejected', method, 2, THREAD_NOT_FOUND);
    return request(method, params);
  };
  await c.attach(f as unknown as RuntimeClient, '0.152.0');
  assert.equal(c.state.status, 'idle');
  assert.equal(c.state.threadId, undefined);
  assert.equal(data.get('lastThread'), undefined);
  assert.equal(f.connected, true);
  // Any other rejection still fails closed.
  data.set('lastThread', 'other-thread');
  const d = new Coordinator(
    root,
    store,
    () => {},
    async () => {},
    () => {},
  );
  t.after(() => d.dispose());
  const g = new Fake(root);
  g.request = async method => {
    if (method === 'thread/read') throw new DeliveryError('rejected', method, 2, 'Runtime rejected request (-32600)');
    return Fake.prototype.request.call(g, method);
  };
  await assert.rejects(d.attach(g as unknown as RuntimeClient, '0.152.0'));
  assert.equal(d.state.status, 'unknown');
});
test('keystroke drafts never bump the draft epoch; host replacements and chat switches do', async t => {
  const { c } = await setup(t);
  await c.newThread();
  const epoch = () => c.state.draftEpoch ?? 0;
  const opened = epoch();
  await c.setDraft('typed', undefined, true);
  assert.equal(c.state.draft, 'typed');
  assert.equal(epoch(), opened, 'an echo of typing must not replace newer keystrokes in the view');
  await c.setDraft('typed');
  assert.equal(epoch(), opened, 'saving the same text is not a replacement');
  await c.setDraft('');
  assert.equal(epoch(), opened + 1);
  await c.newThread();
  assert.equal(epoch(), opened + 2);
});

test('automatic title is generated through a native tool, persisted and never overwrites a manual title', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  const start = f.calls.find(call => call.method === 'thread/start')!.params;
  assert.ok(start.dynamicTools.some((tool: any) => tool.name === 'set_chat_title'));
  await c.send('这个文件是什么意思？');
  assert.equal(c.state.title, '这个文件是什么意思？');
  assert.equal(f.calls.find(call => call.method === 'turn/start')!.params.summary, 'auto');
  const name = async (id: number, title: unknown, threadId = 'owned-thread') => {
    f.emit('request', {
      id,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: 'turn',
        callId: `call-${id}`,
        tool: 'set_chat_title',
        namespace: null,
        arguments: { title },
      },
    });
    await new Promise(resolve => setImmediate(resolve));
  };
  await name(1001, 'wrong chat', 'other-thread');
  await name(1002, 'invalid\nname');
  assert.equal(f.name, null);
  await name(1003, '解释 Python 断言示例');
  assert.equal(c.state.title, '解释 Python 断言示例');
  assert.equal(f.name, '解释 Python 断言示例');
  await name(1004, 'overwritten');
  assert.equal(f.name, '解释 Python 断言示例');
  f.emit('notification', {
    method: 'turn/completed',
    params: { threadId: f.id, turn: { id: 'turn', status: 'completed' } },
  });
  await c.rename('我的 Python 笔记');
  await c.openThread(f.id);
  assert.equal(c.state.title, '我的 Python 笔记');
  await c.continueThread();
  await c.send('follow-up');
  await name(1005, 'must not replace manual name');
  assert.equal(f.name, '我的 Python 笔记');
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 2, 'naming starts no extra model turn');
});

test('reasoning summaries stream with paragraph boundaries and final items reconcile them', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  await c.send('question');
  const params = { threadId: f.id, turnId: 'turn', itemId: 'reasoning' };
  f.emit('notification', {
    method: 'item/started',
    params: { ...params, item: { type: 'reasoning', id: 'reasoning', summary: [], content: [] } },
  });
  for (const [summaryIndex, delta] of [
    [0, 'Check '],
    [0, 'the input.'],
    [1, 'Verify the result.'],
  ] as const)
    f.emit('notification', { method: 'item/reasoning/summaryTextDelta', params: { ...params, summaryIndex, delta } });
  assert.equal(c.state.items.at(-1)?.text, 'Check the input.\n\nVerify the result.');
  assert.equal(c.state.items.at(-1)?.status, 'inProgress');
  f.emit('notification', {
    method: 'item/completed',
    params: {
      ...params,
      item: { type: 'reasoning', id: 'reasoning', summary: ['Check the input.', 'Verify the result.'], content: [] },
    },
  });
  assert.equal(c.state.items.length, 1);
  assert.equal(c.state.items[0].text, 'Check the input.\nVerify the result.');
  assert.equal(c.state.items[0].status, 'completed');
});

test('a rejected automatic title leaves the running answer and fallback title intact', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  await c.send('Explain assertions');
  const request = f.request.bind(f);
  f.request = async (method, params) => {
    if (method === 'thread/name/set') throw new DeliveryError('unknown', method, 99, 'Timed out');
    return request(method, params);
  };
  f.emit('request', {
    id: 1100,
    method: 'item/tool/call',
    params: {
      threadId: f.id,
      turnId: 'turn',
      callId: 'name',
      namespace: null,
      tool: 'set_chat_title',
      arguments: { title: 'Python assertions' },
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.state.status, 'running');
  assert.equal(c.state.title, 'Explain assertions');
  const response = f.responses.at(-1) as { result: { success: boolean; contentItems: { text: string }[] } };
  assert.equal(response.result.success, false);
  assert.match(response.result.contentItems[0].text, /do not retry/);
});

test('response annotations are scoped, persisted and transmitted without losing edits made during send', async t => {
  const { c, f, store } = await setup(t);
  await c.newThread();
  c.state.items = [{ id: 'answer', turnId: 'previous', type: 'agentMessage', text: 'Quoted answer' }];
  const quote = {
    id: 'quote-1',
    itemId: 'answer',
    turnId: 'previous',
    text: 'Quoted answer',
    comment: 'Explain this',
    start: 0,
    end: 13,
  };
  await assert.rejects(c.annotate('different-thread', 'add', quote), /another chat/);
  await assert.rejects(c.annotate(f.id, 'add', { ...quote, itemId: 'unknown' }), /loaded assistant/);
  await c.annotate(f.id, 'add', quote);
  assert.deepEqual(store.get(`annotations.${f.id}`, []), [quote]);
  await c.openThread(f.id);
  assert.deepEqual(c.state.annotations, [quote], 'opening the chat restores its annotation draft');
  let release!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  f.turn = async params => {
    assert.match(params.input[0].text, /Quoted answer/);
    assert.match(params.input[0].text, /Explain this/);
    assert.match(params.input[0].text, /"itemId":"answer"/);
    await held;
    return { turn: { id: 'turn', status: 'completed' } };
  };
  const sending = c.send('');
  while (!f.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
  await c.annotate(f.id, 'comment', quote.id, 'New comment while sending');
  release();
  await sending;
  assert.equal(c.state.annotations?.[0].comment, 'New comment while sending');
  f.turn = () => ({ turn: { id: 'next', status: 'completed' } });
  await c.send('');
  assert.deepEqual(c.state.annotations, []);
  assert.deepEqual(store.get(`annotations.${f.id}`, ['unexpected']), []);
});

test('failed sends preserve response annotations and remove only the selected entry', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  c.state.items = [{ id: 'answer', turnId: 'previous', type: 'agentMessage', text: 'answer' }];
  const quote = { id: 'q1', itemId: 'answer', turnId: 'previous', text: 'answer', comment: '', start: 0, end: 6 };
  await c.annotate(f.id, 'add', quote);
  await c.annotate(f.id, 'add', { ...quote, id: 'q2' });
  f.turn = () => {
    throw new DeliveryError('rejected', 'turn/start', 12, 'rejected');
  };
  await assert.rejects(c.send('explain'), /rejected/);
  assert.equal(c.state.annotations?.length, 2);
  await c.annotate(f.id, 'remove', 'q1');
  assert.deepEqual(
    c.state.annotations?.map(a => a.id),
    ['q2'],
  );
});

test('startup launches independent reads together and still gates Send until all required reads settle', async t => {
  const { c, root } = await setup(t);
  const f = new Fake(root),
    started: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  const request = f.request.bind(f);
  f.request = async (method, params) => {
    started.push(method);
    if (method === 'model/list') await held;
    if (method === 'permissionProfile/list') return { data: [{ id: ':read-only', allowed: true }], nextCursor: null };
    return request(method, params);
  };
  const attaching = c.attach(f as unknown as RuntimeClient, '0.152.0', {
    profile: ':read-only',
    approval: 'never',
    reviewer: 'user',
    memories: false,
    provider: 'openai',
    mcpServers: [],
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(started.includes('thread/list') && started.includes('permissionProfile/list'));
  await assert.rejects(c.send('premature'), /active operation|connection and history/);
  release();
  await attaching;
});

test('history loads share one request, reject cyclic item pages and discard a disconnected response', async t => {
  const { c, f } = await setup(t);
  await c.newThread();
  const request = f.request.bind(f);
  let release!: () => void,
    calls = 0;
  f.request = async (method, params) => {
    if (method === 'thread/turns/list') {
      calls++;
      await new Promise<void>(resolve => {
        release = resolve;
      });
      return {
        data: [{ id: 'old', itemsView: 'full', items: [{ type: 'agentMessage', id: 'a', text: 'stale' }] }],
        nextCursor: null,
      };
    }
    return request(method, params);
  };
  const a = c.loadHistory(false),
    b = c.loadHistory(false);
  assert.equal(calls, 1);
  await assert.rejects(c.newThread(), /active operation/);
  f.stop();
  release();
  await Promise.all([a, b]);
  assert.deepEqual(c.state.items, []);
  f.connected = true;
  f.request = async (method, params) => {
    if (method === 'thread/turns/list')
      return { data: [{ id: 'old', itemsView: 'summary', items: [] }], nextCursor: null };
    if (method === 'thread/items/list') return { data: [], nextCursor: 'repeated' };
    return request(method, params);
  };
  await assert.rejects(c.loadHistory(false), /pagination/);
  assert.deepEqual(c.state.items, []);
});

test('an uncertain interrupt stops the runtime and keeps restore/configuration blocked until reconciliation', async t => {
  const { c, f, root } = await setup(t);
  await c.newThread();
  await c.send('task');
  const request = f.request.bind(f);
  f.request = async (method, params) => {
    if (method === 'turn/interrupt') throw new DeliveryError('unknown', method, 90, 'timeout');
    return request(method, params);
  };
  await assert.rejects(c.cancel(), /timeout/);
  assert.equal(c.unresolvedWork, true);
  assert.equal(c.state.writable, false);
  assert.equal(f.connected, false);
  await assert.rejects(c.closeChat(), /unresolved task/);
  const replacement = new Fake(root);
  await c.attach(replacement as unknown as RuntimeClient, '0.152.0');
  assert.equal(c.unresolvedWork, false);
  assert.equal(
    replacement.calls.some(call => call.method === 'turn/start'),
    false,
  );
  await c.continueThread();
  await c.send('task');
  const replacementRequest = replacement.request.bind(replacement);
  replacement.request = async (method, params) => {
    if (method === 'turn/interrupt') throw new DeliveryError('rejected', method, 91, 'rejected');
    return replacementRequest(method, params);
  };
  await assert.rejects(c.cancel(), /rejected/);
  assert.equal(c.state.status, 'running');
  assert.equal(replacement.connected, true);
});

for (const childHistory of ['inProgress', 'completed', 'empty'])
  test(`reconnect cannot clear active child work with ${childHistory} history just because its parent is idle`, async t => {
    const { c, f, root } = await setup(t);
    await c.newThread();
    const child = { ...f.thread(), id: 'child', parentThreadId: f.id, status: { type: 'active' } };
    c.agents.notification({ method: 'thread/started', params: { thread: child } });
    assert.equal(c.agents.active, true);
    f.stop();
    assert.equal(c.unresolvedWork, true);
    const replacement = new Fake(root);
    const request = replacement.request.bind(replacement);
    let checked = false;
    replacement.request = async (method, params) => {
      if (method === 'thread/list' && params.ancestorThreadId) {
        checked = true;
        return { data: [child], nextCursor: null };
      }
      if (method === 'thread/read' && params.threadId === 'child') return { thread: child };
      if (method === 'thread/turns/list' && params.threadId === 'child')
        return { data: childHistory === 'empty' ? [] : [{ id: 'child-turn', status: childHistory }], nextCursor: null };
      return request(method, params);
    };
    await assert.rejects(c.attach(replacement as unknown as RuntimeClient, '0.152.0'), /Child tasks/);
    assert.equal(checked, true);
    assert.equal(c.unresolvedWork, true);
    assert.equal(replacement.connected, false);
  });
