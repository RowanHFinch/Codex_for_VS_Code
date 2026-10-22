import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient } from '../src/runtime/client';
import { Coordinator } from '../src/sessions/coordinator';
import { runtimeSettings } from '../src/runtime/settings';
import { runtimeExecutable } from '../src/runtime/executable';
import { NativeEdits } from '../src/review/native-edits';

// Real codex app-server + synthetic local Responses provider: pre-apply file review,
// edit records, undo, the diagnostics dynamic tool and thread/revert. No account is used.
async function main() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ic-native-edit-'))),
    root = join(temp, 'workspace'),
    home = join(temp, 'codex');
  await mkdir(root);
  await mkdir(home);
  await writeFile(join(root, 'a.txt'), 'alpha\n');
  await writeFile(join(root, 'c.txt'), 'keep me\nsecond line\n');
  const patch =
    '*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+beta\n*** Add File: b.txt\n+new\n*** End Patch\n';
  const script: any[] = [
    {
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: `apply_patch <<'EOF'\n${patch}EOF\n` }),
    },
    { type: 'message', text: 'EDIT_DONE' },
    { type: 'function_call', name: 'get_diagnostics', arguments: '{}' },
    { type: 'message', text: 'DIAGNOSTICS_DONE' },
    {
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify({
        cmd: `apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+gamma\n*** Delete File: c.txt\n*** End Patch\nEOF\n`,
      }),
    },
    { type: 'message', text: 'AUTO_DONE' },
    { type: 'function_call', name: 'set_chat_title', arguments: '{"title":"Review example file changes"}' },
    { type: 'message', text: 'TITLE_DONE' },
  ];
  let calls = 0,
    toolOutput = '';
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    for (const item of body.input ?? [])
      if (item.type === 'function_call_output' && item.call_id === 'call-3') toolOutput = JSON.stringify(item.output);
    const step = script[calls++] ?? { type: 'message', text: 'EXTRA' };
    const item =
      step.type === 'message'
        ? {
            id: `m${calls}`,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: step.text, annotations: [] }],
          }
        : {
            id: `fc${calls}`,
            type: 'function_call',
            call_id: `call-${calls}`,
            name: step.name,
            arguments: step.arguments,
          };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (type: string, value: any) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    send('response.created', {
      response: { id: `r${calls}`, object: 'response', status: 'in_progress', model: body.model, output: [] },
    });
    send('response.output_item.added', { output_index: 0, item });
    send('response.output_item.done', { output_index: 0, item });
    send('response.completed', {
      response: {
        id: `r${calls}`,
        object: 'response',
        status: 'completed',
        model: body.model,
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  await writeFile(
    join(home, 'config.toml'),
    `model = "gpt-5.3-codex"\nmodel_provider = "synthetic"\nsandbox_mode = "workspace-write"\n[model_providers.synthetic]\nname = "Synthetic"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[features]\nhooks = false\nplugins = false\nmemories = false\napps = false\nmulti_agent = false\n[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`,
  );
  const client = new RuntimeClient(
    spawn(runtimeExecutable(process.env.CODEX_RUNTIME_PATH || 'codex'), ['app-server', '--listen', 'stdio://'], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: temp,
        USERPROFILE: temp,
        CODEX_HOME: home,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
  let coordinator: Coordinator | undefined;
  try {
    await client.request('initialize', {
      clientInfo: { name: 'native_edit_acceptance', title: 'Synthetic isolated acceptance', version: '1' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');
    // Test-only provider alias, as in agents-smoke: the loopback provider is reported as openai.
    const request = client.request.bind(client);
    const alias = (value: any): any => {
      if (Array.isArray(value)) return value.map(alias);
      if (!value || typeof value !== 'object') return value;
      for (const key of Object.keys(value))
        value[key] = key === 'modelProvider' && value[key] === 'synthetic' ? 'openai' : alias(value[key]);
      return value;
    };
    client.request = async (method: string, params?: any): Promise<any> =>
      alias(
        await request(
          method,
          method === 'thread/start'
            ? { ...params, modelProvider: 'synthetic' }
            : params?.modelProviders
              ? { ...params, modelProviders: ['synthetic'] }
              : params,
        ),
      );
    client.prependListener('notification', message => alias(message));
    const edits = new NativeEdits(join(temp, 'records'), root);
    // When set, item starts are dropped, as when an auto-approved patch lands before its pre-image is read.
    let missStarts = false;
    const settled: string[] = [],
      approvals: string[] = [];
    const data = new Map();
    coordinator = new Coordinator(
      root,
      { get: (k, v) => data.get(k) ?? v, update: async (k, v) => void data.set(k, v) },
      () => {},
      async () => {},
      () => {},
      undefined,
      undefined,
      {
        fileChange: (phase, threadId, turnId, item) =>
          void (phase === 'started'
            ? missStarts || edits.started(threadId, turnId, item.id, item.changes)
            : edits.completed(item.id, item.status, { threadId, turnId, changes: item.changes })),
        settled: token => settled.push(token),
        fileApproval: (_id, token) => approvals.push(token),
        diagnostics: async () => 'src/x.ts:1:1 error: SYNTHETIC_DIAGNOSTIC',
      },
    );
    await coordinator.attach(
      client,
      '0.152.0',
      runtimeSettings({ model: 'gpt-5.3-codex', sandbox_mode: 'workspace-write', approval_policy: 'untrusted' }),
    );
    coordinator.state.account = 'chatgpt';
    coordinator.state.effort = 'medium';
    coordinator.state.models.push({
      ...coordinator.state.models[0],
      id: 'synthetic',
      model: 'gpt-5.3-codex',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Synthetic' }],
    });
    const until = async (read: () => boolean, message: string) => {
      const end = Date.now() + 20000;
      while (!read() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(read(), message + ' ' + JSON.stringify(coordinator!.state.decisions ?? coordinator!.state.items));
    };
    await coordinator.newThread();
    assert.equal(coordinator.state.approval, 'untrusted');
    await coordinator.send('Edit the files');
    await until(
      () => coordinator!.state.decisions.some(d => d.method === 'item/fileChange/requestApproval'),
      'No file approval',
    );
    const decision = coordinator.state.decisions.find(d => d.method === 'item/fileChange/requestApproval')!;
    assert.deepEqual(
      decision.changes?.map(c => [c.path, c.kind, c.added, c.removed]),
      [
        ['a.txt', 'update', 1, 1],
        ['b.txt', 'add', 1, 0],
      ],
    );
    assert.ok(decision.options?.includes('acceptForSession'));
    assert.equal(coordinator.pendingChanges(decision.id, decision.token).length, 2);
    await until(() => approvals.includes(decision.token), 'Diff preview hook not called');
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'alpha\n', 'Nothing may be written before acceptance');
    coordinator.decide(decision.id, decision.token, undefined, false, true);
    assert.ok(settled.includes(decision.token));
    await until(() => coordinator!.state.status === 'completed', 'Edit turn did not complete');
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'beta\n');
    assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'new\n');
    const editTurn = coordinator.state.items.find(i => i.type === 'userMessage')!.turnId;
    await until(() => Boolean(coordinator!.state.turnChanges?.[editTurn]?.length), 'No turn diff');
    assert.deepEqual(coordinator.state.turnChanges![editTurn].map(f => f.path).sort(), ['a.txt', 'b.txt']);
    await until(() => true, '');
    await new Promise(resolve => setTimeout(resolve, 200));
    const records = await edits.list(coordinator.state.threadId);
    assert.deepEqual(records.map(r => r.path).sort(), ['a.txt', 'b.txt'], 'Edit records missing');

    await coordinator.send('Check problems');
    await until(
      () => coordinator!.state.items.some(i => i.text.includes('DIAGNOSTICS_DONE')),
      'Diagnostics turn did not finish',
    );
    assert.match(toolOutput, /SYNTHETIC_DIAGNOSTIC/, 'Dynamic diagnostics tool output did not reach the model');
    await until(() => coordinator!.state.status === 'completed', 'Diagnostics turn did not complete');

    // Rewind to before the first message: files restored, history emptied.
    const turns = coordinator.turnsFrom(editTurn);
    assert.equal(turns.length, 2);
    await coordinator.revert(editTurn, async () => {
      await edits.restore(
        (await edits.list(coordinator!.state.threadId)).filter(r => turns.includes(r.turnId)),
        () => false,
      );
    });
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'alpha\n');
    await assert.rejects(readFile(join(root, 'b.txt')), { code: 'ENOENT' });
    assert.equal(coordinator.state.items.length, 0, 'Reverted history still shows turns');

    // Auto-approved update + delete with no captured pre-image: the update is recovered from its diff and
    // undone exactly; the delete is not guessed (its old file may have been a link or not text).
    missStarts = true;
    await coordinator.configurePolicy(coordinator.state.profile, 'never', 'user');
    await coordinator.send('Edit without asking');
    await until(
      () => coordinator!.state.items.some(i => i.text.includes('AUTO_DONE')),
      'Auto edit turn did not finish',
    );
    await until(() => coordinator!.state.status === 'completed', 'Auto edit turn did not complete');
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'gamma\n');
    await assert.rejects(readFile(join(root, 'c.txt')), { code: 'ENOENT' });
    await new Promise(resolve => setTimeout(resolve, 200));
    const autoTurn = coordinator.state.items.find(i => i.type === 'userMessage')!.turnId;
    const derived = (await edits.list(coordinator.state.threadId)).filter(r => r.turnId === autoTurn);
    assert.deepEqual(
      derived.map(r => r.path),
      ['a.txt'],
      'Only the update may be recovered from its diff',
    );
    await edits.restore(derived, () => false);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'alpha\n');
    await assert.rejects(readFile(join(root, 'c.txt')), { code: 'ENOENT' });
    await coordinator.send('Give this chat a concise title');
    await until(() => coordinator!.state.status === 'completed', 'Title turn did not complete');
    assert.equal(coordinator.state.title, 'Review example file changes');
    const named = await client.request<any>('thread/read', {
      threadId: coordinator.state.threadId,
      includeTurns: false,
    });
    assert.equal(named.thread.name, 'Review example file changes', 'Generated title must persist in native history');
    console.log(
      'Native edit acceptance passed: pre-apply review, records, diagnostics tool, undo, rewind, diff-derived undo and persisted title tool.',
    );
  } finally {
    await coordinator?.dispose();
    await client.shutdown().catch(() => {});
    server.close();
    await rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error(error);
  process.exit(1);
});
