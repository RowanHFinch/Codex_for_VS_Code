import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, realpath, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RuntimeClient } from '../src/runtime/client';

// Exercise the real private host methods without adding test commands to the extension.
function hostFixture(
  root: string,
  runtimeProbe?: () => Promise<string>,
  voice?: { Dictation: unknown; Microphone: unknown },
) {
  const uri = { scheme: 'file', fsPath: root, toString: () => 'file://' + root };
  const vscode: any = {
    workspace: { isTrusted: true, workspaceFolders: [{ uri }], textDocuments: [] },
    env: {},
    commands: {},
    window: {},
    Uri: { parse: (url: string) => url },
  };
  let source = (readFileSync('src/extension.ts', 'utf8') + '\nexport { ChatHost };').replaceAll(
    'await preferredRuntime(',
    runtimeProbe ? 'await __testRuntimeProbe(' : 'await preferredRuntime(',
  );
  if (voice)
    source = source
      .replaceAll('new Dictation(', 'new __testVoice.Dictation(')
      .replaceAll('new Microphone()', 'new __testVoice.Microphone()');
  const compiled = buildSync({
    stdin: { contents: source, resolveDir: join(process.cwd(), 'src'), sourcefile: 'extension.ts', loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
  });
  const module = { exports: {} as any },
    require = createRequire(join(process.cwd(), 'package.json'));
  new Function('require', 'module', 'exports', '__testRuntimeProbe', '__testVoice', compiled.outputFiles[0].text)(
    (name: string) => (name === 'vscode' ? vscode : require(name)),
    module,
    module.exports,
    runtimeProbe,
    voice,
  );
  const host = Object.create(module.exports.ChatHost.prototype);
  Object.assign(host, {
    root,
    workspaceUri: uri.toString(),
    restoring: false,
    managementBusy: false,
    disposed: false,
    channels: new Map(),
    chatReady: new EventEmitter(),
    broadcast() {},
  });
  return { host, vscode };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('manager navigation targets the right chat, preserves independent editors and rejects chat mutations', async () => {
  const { host, vscode } = hostFixture('/fixture');
  const states = new Map(['a', 'b'].map(id => [id, { state: { status: 'idle', locale: 'en', draft: `draft-${id}` } }]));
  host.tabs = {
    active: 'a',
    sessions: states,
    get: (id: string) => states.get(id),
    select: async (id: string) => {
      host.tabs.active = id;
    },
  };
  host.channels.set('a', {});
  host.channels.set('b', {});
  const commands: string[] = [],
    messages: any[] = [];
  vscode.commands.executeCommand = async (id: string) => commands.push(id);
  const view = { postMessage: async (message: any) => messages.push(message) },
    sidebar = {};
  const bound = (surface: string) => ({ surface, channelId: 'a', files: { dispose() {} } });
  const manager = bound('sidebar'),
    chat = bound('chat'),
    editor = bound('editor');
  host.views = new Map([
    [sidebar, manager],
    [view, chat],
    [{}, editor],
  ]);
  await host.action({ type: 'selectTab', id: 'b' }, 'a', sidebar, manager);
  assert.equal(chat.channelId, 'b');
  assert.equal(manager.channelId, 'b');
  assert.equal(editor.channelId, 'a');
  assert.equal(states.get('a')!.state.draft, 'draft-a');
  assert.equal(states.get('b')!.state.draft, 'draft-b');
  assert.deepEqual(commands, ['independentCodex.chat.focus']);
  assert.deepEqual(messages, [{ type: 'showChat' }]);
  host.views.delete(view);
  vscode.commands.executeCommand = async () => {
    setImmediate(() => {
      host.views.set(view, chat);
      host.chatReady.emit('ready', view);
    });
  };
  await host.action({ type: 'selectTab', id: 'b' }, 'b', sidebar, manager);
  assert.equal(messages.length, 2, 'Wait for the async view provider before selecting');

  states.get('b')!.state.draft = '';
  Object.assign(states.get('b')!.state, { contexts: [] });
  await host.action({ type: 'newTab' }, 'b', sidebar, manager);
  assert.equal(messages.length, 3, 'Reusing an empty tab still opens its chat');
  await assert.rejects(host.action({ type: 'send', text: 'wrong surface' }, 'b', sidebar, manager), /not available/);
  Object.assign(states.get('b')!.state, { status: 'offline', threadId: 'saved-thread' });
  let connections = 0;
  host.connectChannel = async (id: string) => {
    assert.equal(id, 'b');
    connections++;
    Object.assign(states.get('b')!.state, { status: 'idle', runtimeVersion: 'fixture' });
  };
  await host.action({ type: 'selectTab', id: 'b' }, 'b', sidebar, manager);
  await host.action({ type: 'selectTab', id: 'b' }, 'b', sidebar, manager);
  assert.equal(connections, 1, 'Restored history connects on first selection, warm selection reuses it');
  states.get('b')!.state.status = 'unknown';
  await host.action({ type: 'selectTab', id: 'b' }, 'b', sidebar, manager);
  assert.equal(connections, 1, 'Unknown outcomes are not automatically reconnected');
  Object.assign(states.get('b')!.state, { status: 'offline', threadId: undefined, runtimeVersion: undefined });
  await host.action({ type: 'newTab' }, 'b', sidebar, manager);
  assert.equal(connections, 2, 'Reusing an uninitialized empty tab connects it');
});

test('closing the last tab connects its replacement without starting a runtime thread', async () => {
  const { host } = hostFixture('/fixture');
  const state = { status: 'idle', locale: 'en' };
  const next = { state: { status: 'offline' }, setError() {} };
  host.tabs = {
    active: 'old',
    get: (id: string) => (id === 'old' ? { state } : next),
    close: async () => {
      host.tabs.active = 'replacement';
    },
  };
  host.closedThreads = [];
  host.channels.set('old', { editor: { dispose() {} }, review: { dispose() {} }, images: { async dispose() {} } });
  const view = {},
    bound = { surface: 'chat', channelId: 'old', files: { dispose() {} } };
  host.views = new Map([[view, bound]]);
  const connections: string[] = [];
  host.connectChannel = async (id: string) => {
    connections.push(id);
  };
  await host.action({ type: 'closeTab', id: 'old' }, 'old', view, bound);
  assert.deepEqual(connections, ['replacement']);
  assert.equal(bound.channelId, 'replacement');
});

test('a visible manager follows the active channel without marking it read', () => {
  const { host, vscode } = hostFixture('/fixture');
  const sent: any[] = [];
  let visible: string[] = [];
  host.tabs = {
    active: 'b',
    sessions: new Map([
      ['a', { state: {} }],
      ['b', { state: {} }],
    ]),
    get: () => ({ state: { contexts: [] } }),
    summary: () => [],
    setVisible: (ids: string[]) => {
      visible = ids;
    },
  };
  for (const id of ['a', 'b']) host.channels.set(id, { editor: { preview() {} }, images: { list: () => [] } });
  vscode.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  vscode.env.language = 'en';
  const manager = { surface: 'sidebar', channelId: 'a', visible: () => true };
  host.views = new Map([[{ postMessage: async (message: any) => sent.push(message) }, manager]]);
  Object.getPrototypeOf(host).flushBroadcast.call(host);
  assert.deepEqual(visible, []);
  assert.equal(manager.channelId, 'b');
  assert.equal(sent[0].state.channelId, 'b');
});
test('opening history never automatically continues and failures stay with the destination chat', async () => {
  const { host } = hostFixture('/fixture');
  let shouldFail = false,
    continued = 0;
  const source: any = {
    state: { locale: 'en', sessions: [{ id: 'history' }] },
    setError(error: unknown) {
      this.state.error = error;
    },
  };
  const target: any = {
    state: { locale: 'en', owned: true, writable: false, nativeReady: true, permission: 'agent' },
    async openThread() {
      if (shouldFail) throw new Error('History unavailable');
    },
    async continueThread() {
      continued++;
    },
    setError(error: Error) {
      this.state.error = error.message;
    },
  };
  host.tabs = {
    get: (id: string) => (id === 'source' ? source : target),
    find: () => undefined,
    add: async () => 'target',
    assignments: {},
  };
  host.channels.set('source', {});
  host.opening = new Set();
  const bound = { surface: 'sidebar', channelId: 'source' };
  host.select = async () => {
    bound.channelId = 'target';
  };
  host.connectChannel = async () => {};
  await host.action({ type: 'open', threadId: 'history' }, 'source', {}, bound);
  assert.equal(continued, 0);
  shouldFail = true;
  bound.channelId = 'source';
  host.connectChannel = async () => {
    bound.channelId = 'third';
  };
  await host.action({ type: 'open', threadId: 'history' }, 'source', {}, bound);
  assert.equal(target.state.error, 'History unavailable');
  assert.equal(source.state.error, undefined);
  assert.equal(host.opening.size, 0);
  host.tabs.find = () => 'target';
  bound.channelId = 'source';
  host.select = async () => {
    bound.channelId = 'third';
    throw new Error('Cold tab connection failed');
  };
  await host.action({ type: 'open', threadId: 'history' }, 'source', {}, bound);
  assert.equal(target.state.error, 'Cold tab connection failed');
  assert.equal(source.state.error, undefined);
});
test('a failed tab selection reports to its captured target even after another selection', async () => {
  const { host, vscode } = hostFixture('/fixture');
  const errors: string[] = [];
  host.context = { extensionUri: {} };
  host.views = new Map();
  host.tabs = {
    active: 'source',
    sessions: new Map([
      ['source', {}],
      ['target', {}],
      ['third', {}],
    ]),
    get: (id: string) => ({ setError: () => errors.push(id) }),
  };
  vscode.Uri.joinPath = () => '/fixture';
  let receive!: (input: unknown) => void;
  const view = {
    asWebviewUri: () => '/fixture',
    onDidReceiveMessage: (listener: typeof receive) => {
      receive = listener;
      return { dispose() {} };
    },
  };
  host.bind(
    view,
    () => ({ dispose() {} }),
    () => true,
    () => ({ dispose() {} }),
    'sidebar',
  );
  host.action = async () => {
    host.views.get(view).channelId = 'third';
    throw new Error('Connection failed');
  };
  receive({ channelId: 'source', action: { type: 'selectTab', id: 'target' } });
  await tick();
  assert.deepEqual(errors, ['target']);
});
test('copy feedback is acknowledged only after clipboard success and keeps the originating chat identity', async () => {
  const { host, vscode } = hostFixture('/fixture');
  const messages: any[] = [];
  const c = {
    state: { locale: 'en', threadId: 'chat', items: [{ id: 'answer', type: 'agentMessage', text: 'Answer' }] },
  };
  host.tabs = { sessions: new Map([['channel', c]]), get: () => c };
  host.channels.set('channel', {});
  let done!: () => void;
  vscode.env.clipboard = {
    writeText: (text: string) => {
      assert.equal(text, 'Answer');
      return new Promise<void>(resolve => {
        done = resolve;
      });
    },
  };
  const webview = { postMessage: (message: any) => messages.push(message) };
  const copying = host.action({ type: 'copy', itemId: 'answer' }, 'channel', webview, { channelId: 'channel' });
  await tick();
  assert.deepEqual(messages, []);
  c.state.threadId = 'other';
  done();
  await copying;
  assert.deepEqual(messages, [{ type: 'copied', channelId: 'channel', threadId: 'chat', itemId: 'answer' }]);
  vscode.env.clipboard.writeText = async () => {
    throw new Error('clipboard unavailable');
  };
  await assert.rejects(
    host.action({ type: 'copy', itemId: 'answer' }, 'channel', webview, { channelId: 'channel' }),
    /clipboard unavailable/,
  );
  assert.equal(messages.length, 1);
});
test('view changes opens the selected turn file and ignores cancelled or switched chats', async () => {
  const { host, vscode } = hostFixture('/fixture');
  const opened: string[] = [];
  host.openTurnFile = async (_c: unknown, turn: string, path: string) => opened.push(`${turn}:${path}`);
  const c = { state: { threadId: 'chat', turnChanges: { turn: [{ path: 'a.ts', added: 1, removed: 0 }] } } };
  await host.openTurnChanges(c, 'turn', false);
  assert.deepEqual(opened, ['turn:a.ts']);
  c.state.turnChanges.turn.push({ path: 'b.ts', added: 2, removed: 1 });
  vscode.window.showQuickPick = async (choices: any[]) => choices[1];
  await host.openTurnChanges(c, 'turn', false);
  assert.deepEqual(opened, ['turn:a.ts', 'turn:b.ts']);
  vscode.window.showQuickPick = async () => undefined;
  await host.openTurnChanges(c, 'turn', false);
  vscode.window.showQuickPick = async (choices: any[]) => {
    c.state.threadId = 'other';
    return choices[0];
  };
  await host.openTurnChanges(c, 'turn', false);
  await host.openTurnChanges(c, 'missing', false);
  assert.equal(opened.length, 2);
});
test('bound integration refresh acknowledges success, read failure and pre-action refusal with its request identity', async () => {
  const { host, vscode } = hostFixture('/fixture'),
    messages: any[] = [];
  let receive!: (value: any) => void, release!: () => void;
  const session = { state: { status: 'idle' }, setError: () => messages.push({ type: 'state', error: true }) };
  host.tabs = { active: 'a', sessions: new Map([['a', session]]), get: () => session };
  host.channels.set('a', {});
  host.context = { extensionUri: {}, subscriptions: [] };
  host.views = new Map();
  vscode.Uri.joinPath = () => ({});
  host.catalog = () => ({
    refresh: () =>
      new Promise<void>(resolve => {
        release = resolve;
      }),
  });
  const disposable = { dispose() {} };
  host.bind(
    {
      asWebviewUri: () => 'fixture',
      postMessage: (message: any) => messages.push(message),
      onDidReceiveMessage: (handler: any) => {
        receive = handler;
        return disposable;
      },
    },
    () => disposable,
    () => true,
    () => disposable,
  );
  const send = (requestId: string) => receive({ channelId: 'a', action: { type: 'refreshIntegrations', requestId } });
  send('older');
  host.managementBusy = true;
  send('latest');
  await tick();
  assert.deepEqual(messages, [
    { type: 'state', error: true },
    { type: 'integrationsRefreshed', channelId: 'a', requestId: 'latest' },
  ]);
  release();
  await tick();
  assert.equal(messages.at(-1)?.requestId, 'older');
  host.managementBusy = false;
  host.catalog = () => ({
    refresh: async () => {
      throw new Error('Synthetic read failure');
    },
  });
  send('failed');
  await tick();
  assert.deepEqual(messages.slice(-2), [
    { type: 'state', error: true },
    { type: 'integrationsRefreshed', channelId: 'a', requestId: 'failed' },
  ]);
});
test('MCP form acceptance passes values to its bound decision without opening a browser', async () => {
  const { host, vscode } = hostFixture('/fixture');
  const decisions: any[] = [];
  const session = {
    state: { status: 'waiting' },
    decision: () => ({ method: 'mcpServer/elicitation/request', form: {} }),
    decide: (...args: any[]) => decisions.push(args),
    authorization() {
      throw new Error('Forms have no authorization URL');
    },
  };
  host.tabs = { get: () => session };
  host.channels.set('a', {});
  vscode.env.openExternal = async () => {
    throw new Error('MCP forms must not open a browser');
  };
  await host.action(
    { type: 'decision', id: 1, token: 'bound', accept: true, content: { count: 0, confirmed: false } },
    'a',
    {},
    { channelId: 'a' },
  );
  assert.deepEqual(decisions, [[1, 'bound', undefined, undefined, true, { count: 0, confirmed: false }, undefined]]);
});
test('pending native confirmations cannot run two checkpoint restorations or release the other restore lock', async () => {
  const { host, vscode } = hostFixture('/fixture');
  const confirms: ((value: string) => void)[] = [],
    restores: string[] = [];
  let finish!: () => void;
  vscode.window.showQuickPick = async (choices: any[]) => choices[0];
  vscode.window.showWarningMessage = () => new Promise(resolve => confirms.push(resolve));
  const session = { state: { locale: 'en', status: 'idle' } };
  host.tabs = {
    active: 'a',
    sessions: new Map([
      ['a', session],
      ['b', session],
    ]),
    get: () => session,
  };
  host.channels = new Map(
    ['a', 'b'].map(id => [
      id,
      {
        review: {
          journal: { list: async () => [{ id, path: 'sample.ts', state: 'applied' }] },
          previewRestore: async () => {},
          restore: () => {
            restores.push(id);
            return new Promise<void>(resolve => {
              finish = resolve;
            });
          },
        },
      },
    ]),
  );
  const a = host.checkpoints('a'),
    b = host.checkpoints('b');
  await tick();
  assert.equal(confirms.length, 2);
  confirms[0]('Restore text');
  await tick();
  assert.deepEqual(restores, ['a']);
  confirms[1]('Restore text');
  await assert.rejects(b, /restoration started/);
  assert.equal(host.restoring, true);
  finish();
  await a;
  assert.equal(host.restoring, false);
});
test('configuration dirty guards canonicalize aliases and run again after a native dialog', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ic-host-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config.toml'),
    alias = join(root, 'alias.toml');
  await writeFile(config, '');
  await symlink(config, alias);
  const { host, vscode } = hostFixture(root);
  const dirty = { uri: { scheme: 'file', fsPath: alias }, isDirty: true };
  vscode.workspace.textDocuments = [dirty];
  await assert.rejects(host.assertConfigClean(config), /Save or discard/);
  vscode.workspace.textDocuments = [];
  let writes = 0;
  const catalog = {
    configPath: config,
    async changeServer() {
      await host.assertConfigClean(config);
      writes++;
    },
  };
  host.catalog = () => catalog;
  host.anyBusy = () => false;
  await assert.rejects(
    host.manage('a', async (c: any) => {
      vscode.workspace.textDocuments = [dirty];
      await c.changeServer();
    }),
    /Save or discard/,
  );
  assert.equal(writes, 0);
  assert.equal(host.managementBusy, false);
});
test('connection inventory and exclusive operations block global management; reconnection never treats a skipped tab as success', async () => {
  const { host } = hostFixture('/fixture');
  const session = { state: { status: 'idle', runtimeVersion: '0.152.0', operationBusy: false } };
  host.tabs = { sessions: new Map([['a', session]]), get: () => session };
  host.channels = new Map([['a', { connecting: true }]]);
  assert.equal(host.anyBusy(), true);
  await assert.rejects(
    host.manage('a', async () => {}),
    /Finish active turns/,
  );
  await assert.rejects(host.reconnectSessions(), /Wait for this chat operation/);
  assert.equal(host.mcpNeedsReconnect, true);
  host.channels.get('a').connecting = false;
  session.state.operationBusy = true;
  assert.equal(host.anyBusy(), true);
  await assert.rejects(host.reconnectSessions(), /Wait for this chat operation/);
  assert.equal(host.mcpNeedsReconnect, true);
});
test('an unresolved ecosystem change blocks both New and New Tab before native activation', async () => {
  const { host } = hostFixture('/fixture');
  let starts = 0;
  const session = {
    state: { status: 'idle', account: 'chatgpt' },
    newThread: async () => {
      starts++;
    },
  };
  host.tabs = {
    get: () => session,
    add: async () => {
      starts++;
      return 'b';
    },
  };
  host.channels = new Map([['a', {}]]);
  host.mcpNeedsReconnect = true;
  for (const type of ['new', 'newTab'])
    await assert.rejects(host.action({ type }, 'a', {}, { channelId: 'a' }), /Reconnect integrations/);
  assert.equal(starts, 0);
});
test('the final shared-config write guard sees tasks that start during a management dialog', async () => {
  const { host } = hostFixture('/fixture');
  let busy = false,
    writes = 0;
  host.anyBusy = () => busy;
  host.catalog = () => ({ configPath: '/fixture/config.toml' });
  host.assertConfigClean = async () => {};
  await assert.rejects(
    host.manage('a', async () => {
      busy = true;
      await host.assertManagementWrite('/fixture/config.toml');
      writes++;
    }),
    /task or connection started/,
  );
  assert.equal(writes, 0);
  assert.equal(host.managementBusy, false);
});
test('MCP sign-in requires the granted active connection and uses configuration scope for reviewed chats', async () => {
  const { host, vscode } = hostFixture('/fixture');
  let flows = 0;
  const config = { url: 'https://fixture.test/mcp', enabled: true },
    server = { name: 'fixture', config };
  const { mcpFingerprint } = await import('../src/integrations');
  let grants: Record<string, string> = {};
  const session = { state: { status: 'idle', permission: 'reviewed', writable: true, threadId: 'reviewed-thread' } };
  const channel = {
    connecting: false,
    enabledMcp: ['fixture'],
    auth: {
      oauth: async (name: string, thread: string | null, fingerprint: string) => {
        flows++;
        assert.equal(name, 'fixture');
        assert.equal(thread, null);
        assert.equal(fingerprint, mcpFingerprint(config));
        return 'https://fixture.test/authorize';
      },
    },
  };
  host.tabs = { sessions: new Map([['a', session]]), get: () => session };
  host.channels.set('a', channel);
  host.catalog = () => ({ configPath: '/fixture/config.toml', server: () => server });
  host.grants = () => grants;
  host.assertConfigClean = async () => {};
  vscode.env.openExternal = async () => true;
  const login = () => host.action({ type: 'mcpLogin', id: 'fixture' }, 'a', {}, { channelId: 'a' });
  await assert.rejects(login(), /Enable and trust/);
  grants.fixture = 'changed';
  await assert.rejects(login(), /Enable and trust/);
  grants.fixture = mcpFingerprint(config);
  config.enabled = false;
  await assert.rejects(login(), /Enable and trust/);
  config.enabled = true;
  channel.enabledMcp = [];
  await assert.rejects(login(), /Enable and trust/);
  channel.enabledMcp = ['fixture'];
  host.mcpNeedsReconnect = true;
  await assert.rejects(login(), /Enable and trust/);
  assert.equal(flows, 0);
  host.mcpNeedsReconnect = false;
  await login();
  assert.equal(flows, 1);
});
test('plans open as editable files and proceed sends exactly the saved revision', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-plan-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { host, vscode } = hostFixture(root);
  host.context = { globalStorageUri: { fsPath: join(root, 'storage') } };
  const opened: string[] = [],
    sent: string[] = [],
    configured: string[] = [];
  let answer: string | undefined = 'Proceed';
  vscode.Uri.file = (path: string) => ({ fsPath: path });
  vscode.window.showTextDocument = async (uri: { fsPath: string }) => opened.push(uri.fsPath);
  vscode.window.showInformationMessage = async () => answer;
  const c: any = {
    state: {
      threadId: 'thread',
      mode: 'plan',
      model: 'm',
      effort: 'low',
      items: [{ id: 'p', turnId: 't', type: 'plan', text: '1. Do A' }],
    },
    configure: async (_m: string, _e: string, mode: string) => configured.push(mode),
    send: async (text: string) => sent.push(text),
  };
  await host.openPlan(c, 'p');
  assert.equal(opened.length, 1);
  assert.equal(readFileSync(opened[0], 'utf8'), '1. Do A');
  await writeFile(opened[0], '1. Do A\n2. Then B');
  await host.openPlan(c, 'p');
  assert.equal(readFileSync(opened[0], 'utf8'), '1. Do A\n2. Then B', 'reopening keeps edits');
  vscode.workspace.textDocuments = [{ uri: { fsPath: opened[0] }, isDirty: true }];
  await assert.rejects(host.proceedPlan(c, 'p', false), /Save the plan/);
  vscode.workspace.textDocuments = [];
  answer = undefined;
  await host.proceedPlan(c, 'p', false);
  assert.equal(sent.length, 0, 'cancel sends nothing');
  answer = 'Proceed';
  await host.proceedPlan(c, 'p', false);
  assert.deepEqual(configured, ['default']);
  assert.match(sent[0], /reviewed plan \(revision [0-9a-f]{8}\)/);
  assert.ok(sent[0].endsWith('1. Do A\n2. Then B'));
  await assert.rejects(host.proceedPlan(c, 'missing', false), /no longer loaded/);
  vscode.window.showInformationMessage = async () => {
    c.state.threadId = 'other';
    return 'Proceed';
  };
  const before = sent.length;
  await assert.rejects(host.proceedPlan(c, 'p', false), /chat changed/);
  assert.equal(sent.length, before, 'a chat switch during confirmation sends nothing');
});

test('passively opened history refreshes configuration without querying an unloaded thread MCP manager', async () => {
  const { host } = hostFixture('/fixture');
  const session = { state: { threadId: 'history', writable: false, status: 'idle', locale: 'en' } };
  host.tabs = { active: 'a', sessions: new Map([['a', session]]), get: () => session };
  host.channels.set('a', {});
  const targets: unknown[] = [];
  host.catalog = () => ({
    refresh: async (threadId?: string) => {
      targets.push(threadId);
    },
  });
  await host.action({ type: 'refreshIntegrations' }, 'a', {}, { channelId: 'a' });
  session.state.writable = true;
  await host.action({ type: 'refreshIntegrations' }, 'a', {}, { channelId: 'a' });
  assert.deepEqual(targets, [undefined, 'history']);
});

test('reopening a closed chat initializes its tab only once', async () => {
  const { host } = hostFixture('/fixture');
  const view = {},
    bound = { surface: 'chat', channelId: 'old', files: { dispose() {} } };
  host.views = new Map([[view, bound]]);
  host.closedThreads = ['saved-thread'];
  const state = { status: 'offline', runtimeVersion: undefined as string | undefined };
  const opened: string[] = [];
  host.tabs = {
    active: 'old',
    find: () => undefined,
    add: async () => 'new',
    get: () => ({ state, openThread: async (id: string) => opened.push(id) }),
    select: async (id: string) => {
      host.tabs.active = id;
    },
  };
  host.channels.set('new', {});
  let connections = 0;
  host.connectChannel = async () => {
    connections++;
    state.status = 'idle';
    state.runtimeVersion = 'fixture';
  };
  await host.reopenClosed();
  assert.equal(connections, 1);
  assert.deepEqual(opened, ['saved-thread']);
});

test('annotation dictation appends to the original comment, never the composer, and discards removed or cancelled targets', async () => {
  for (const scenario of ['append', 'removed', 'switched', 'cancelled', 'closed', 'limit']) {
    const { host } = hostFixture('/fixture');
    let finish!: (text: string) => void;
    const channel: any = {
      dictation: {
        stop: () =>
          new Promise<string>(resolve => {
            finish = resolve;
          }),
      },
      voice: { status: 'recording', annotationId: 'quote' },
      voiceTarget: { threadId: 'thread', annotationId: 'quote' },
    };
    const comments: unknown[] = [],
      messages: unknown[] = [];
    const c = {
      state: { threadId: 'thread', locale: 'en', annotations: [{ id: 'quote', comment: 'typed' }] },
      annotate: async (...args: unknown[]) => {
        comments.push(args);
      },
      setDraft: async () => {
        throw new Error('Wrong destination');
      },
    };
    host.tabs = { get: () => c };
    host.channels.set('a', channel);
    const view = { postMessage: async (message: unknown) => messages.push(message) };
    const bound = { channelId: 'a', surface: 'chat' };
    host.views = new Map([[view, bound]]);
    const stop = host.action({ type: 'voiceStop' }, 'a', view, bound);
    await tick();
    if (scenario === 'removed') c.state.annotations = [];
    if (scenario === 'switched') c.state.threadId = 'other';
    if (scenario === 'closed') host.channels.delete('a');
    if (scenario === 'cancelled') await host.action({ type: 'voiceCancel' }, 'a', view, bound);
    if (scenario === 'limit') c.state.annotations[0].comment = 'x'.repeat(2000);
    finish('spoken');
    await stop;
    assert.deepEqual(comments, scenario === 'append' ? [['thread', 'comment', 'quote', 'typed spoken']] : [], scenario);
    assert.deepEqual(messages, [], 'Annotation speech never becomes a composer transcript');
    if (['removed', 'switched', 'limit'].includes(scenario)) assert.ok(channel.voice.error, scenario);
  }
});

test('voice runtime preflight reserves its annotation target and cancellation prevents late recording', async () => {
  let finish!: (runtime: string) => void;
  const { host, vscode } = hostFixture(
    '/fixture',
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  vscode.workspace.getConfiguration = () => ({ get: () => 'fixture-runtime' });
  const c = { state: { locale: 'en', threadId: 'thread', annotations: [{ id: 'quote', comment: '' }] } };
  const channel: any = {},
    view = {
      postMessage: async () => {
        throw new Error('Cancelled offer must not connect');
      },
    };
  const bound = { surface: 'chat', channelId: 'a' };
  host.tabs = { get: () => c };
  host.channels.set('a', channel);
  const first = host.action(
    { type: 'voiceOffer', sdp: 'v=0', annotationId: 'quote', threadId: 'thread' },
    'a',
    view,
    bound,
  );
  await tick();
  assert.equal(channel.voice.status, 'starting');
  await assert.rejects(host.action({ type: 'voiceOffer', sdp: 'v=0' }, 'a', view, bound), /already recording/);
  assert.equal(channel.voiceTarget.annotationId, 'quote');
  await host.action({ type: 'voiceCancel' }, 'a', view, bound);
  finish('/must-not-launch');
  await first;
  assert.equal(channel.voice.status, 'idle');
  assert.equal(channel.dictation, undefined);
  assert.equal(channel.microphone, undefined);
});

test('cancel during voice answer delivery cannot start or overwrite the next microphone', async () => {
  let delivered!: () => void,
    starts = 0;
  const { host, vscode } = hostFixture('/fixture', async () => 'fixture-runtime', {
    Dictation: class {
      async start() {
        return 'v=0';
      }
      async dispose() {}
    },
    Microphone: class {
      async start() {
        starts++;
      }
      release() {}
    },
  });
  vscode.workspace.getConfiguration = () => ({ get: () => 'fixture-runtime' });
  const channel: any = {};
  host.tabs = { get: () => ({ state: { locale: 'en' } }) };
  host.channels.set('a', channel);
  const view = {
    postMessage: () =>
      new Promise<void>(resolve => {
        delivered = resolve;
      }),
  };
  const bound = { channelId: 'a', surface: 'chat' };
  const first = host.action({ type: 'voiceOffer', sdp: 'v=0' }, 'a', view, bound);
  await tick();
  await host.action({ type: 'voiceCancel' }, 'a', view, bound);
  const nextDictation = {},
    nextMicrophone = {};
  channel.dictation = nextDictation;
  channel.microphone = nextMicrophone;
  channel.voice = { status: 'starting' };
  delivered();
  await first;
  assert.equal(starts, 0, 'Cancelled operation cannot start capture');
  assert.equal(channel.dictation, nextDictation);
  assert.equal(channel.microphone, nextMicrophone);
});

test('annotation cancellation cannot stop a different annotation recording in another view', async () => {
  const { host } = hostFixture('/fixture');
  let disposed = 0;
  const channel: any = {
    voice: { status: 'recording', annotationId: 'a' },
    voiceTarget: { annotationId: 'a', threadId: 'thread' },
    dictation: {
      dispose: async () => {
        disposed++;
      },
    },
  };
  host.tabs = { get: () => ({ state: { locale: 'en', threadId: 'thread' } }) };
  host.channels.set('chat', channel);
  await host.action({ type: 'voiceCancel', annotationId: 'b', threadId: 'thread' }, 'chat', {}, { channelId: 'chat' });
  await host.action({ type: 'voiceCancel', annotationId: 'a', threadId: 'other' }, 'chat', {}, { channelId: 'chat' });
  assert.equal(disposed, 0);
  assert.equal(channel.voice.status, 'recording');
  await host.action({ type: 'voiceCancel', annotationId: 'a', threadId: 'thread' }, 'chat', {}, { channelId: 'chat' });
  assert.equal(disposed, 1);
  assert.equal(channel.voice.status, 'idle');
});

test('state broadcasts coalesce bursts, skip hidden panels and omit unchanged transcripts', async () => {
  const { host, vscode } = hostFixture('/fixture');
  const items = [{ id: 'answer', turnId: 'turn', type: 'agentMessage', text: 'large answer' }];
  const c = { state: { items, contexts: [] } };
  host.tabs = { active: 'a', sessions: new Map([['a', c]]), get: () => c, summary: () => [], setVisible() {} };
  host.channels.set('a', { editor: { preview() {} }, images: { list: () => [] } });
  vscode.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  vscode.env.language = 'en';
  const messages: any[] = [],
    hidden: any[] = [];
  let visible = false,
    deliver = true;
  const bound = { surface: 'chat', channelId: 'a', visible: () => true };
  host.views = new Map([
    [
      {
        postMessage: async (message: any) => {
          messages.push(message);
          return deliver;
        },
      },
      bound,
    ],
    [{ postMessage: async (message: any) => hidden.push(message) }, { ...bound, visible: () => visible }],
  ]);
  host.broadcast = Object.getPrototypeOf(host).broadcast;
  for (let i = 0; i < 200; i++) host.broadcast();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].state.items, items);
  assert.equal(hidden.length, 0);
  host.broadcast();
  visible = true;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(messages[1].state.items, undefined);
  assert.equal(hidden[0].state.items, items, 'revealed views get the current transcript');
  c.state.items = [...items, { ...items[0], id: 'next' }];
  host.broadcast();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(messages[2].state.items.length, 2);
  deliver = false;
  host.broadcast();
  await new Promise(resolve => setTimeout(resolve, 40));
  deliver = true;
  host.broadcast();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(messages[4].state.items, c.state.items, 'failed delivery requires a complete snapshot');
});
