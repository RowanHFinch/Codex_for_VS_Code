import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient } from '../src/runtime/client';
import { Coordinator } from '../src/sessions/coordinator';
import { runtimeSettings } from '../src/runtime/settings';
import { runtimeExecutable } from '../src/runtime/executable';

async function main() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ic-agents-'))),
    root = join(temp, 'workspace'),
    home = join(temp, 'codex');
  await mkdir(root);
  await mkdir(home);
  let fixtureError: unknown;
  let calls = 0,
    spawned = false,
    childRequests = 0;
  const hanging = new Set<import('node:http').ServerResponse>();
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw),
        inputs = body.input ?? [];
      const isChild = inputs.some(
        (item: any) => item.role === 'user' && JSON.stringify(item.content).includes('SYNTHETIC_CHILD_TASK'),
      );
      if (isChild) {
        childRequests++;
        hanging.add(response);
        response.on('close', () => hanging.delete(response));
        return;
      }
      calls++;
      const names = (body.tools ?? [])
        .flatMap((tool: any) => (tool.type === 'namespace' ? (tool.tools ?? []).map((t: any) => t.name) : [tool.name]))
        .filter(Boolean);
      assert.ok(names.includes('spawn_agent'), 'Native model must expose its collaboration tool');
      const item: any = !spawned
        ? {
            id: 'fc-fixture',
            type: 'function_call',
            call_id: 'call-fixture',
            name: 'spawn_agent',
            namespace: body.tools?.find(
              (tool: any) => tool.type === 'namespace' && tool.tools?.some((t: any) => t.name === 'spawn_agent'),
            )?.name,
            arguments: JSON.stringify({
              message: 'SYNTHETIC_CHILD_TASK: stay active for a targeted interrupt acceptance test.',
              agent_type: 'default',
              fork_context: false,
            }),
          }
        : {
            id: 'message-fixture',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'SYNTHETIC_PARENT_COMPLETED', annotations: [] }],
          };
      spawned = true;
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (type: string, value: any) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      send('response.created', {
        response: { id: `fixture-${calls}`, object: 'response', status: 'in_progress', model: body.model, output: [] },
      });
      send('response.output_item.added', { output_index: 0, item });
      send('response.output_item.done', { output_index: 0, item });
      send('response.completed', {
        response: {
          id: `fixture-${calls}`,
          object: 'response',
          status: 'completed',
          model: body.model,
          output: [item],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        },
      });
      response.end();
    } catch (error) {
      fixtureError = error;
      response.writeHead(500);
      response.end('Synthetic fixture failed');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let client: RuntimeClient | undefined, coordinator: Coordinator | undefined;
  const deadline = async (read: () => boolean, message: string) => {
    const end = Date.now() + 20000;
    while (!read() && !fixtureError && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
    if (fixtureError) throw fixtureError;
    assert.ok(read(), message);
  };
  try {
    // Isolated loopback provider; no external service or user credentials.
    await writeFile(
      join(home, 'config.toml'),
      `model = "gpt-5.3-codex"\nmodel_provider = "synthetic"\ncli_auth_credentials_store = "file"\n[model_providers.synthetic]\nname = "Synthetic local fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[features]\nmulti_agent = true\nhooks = false\nplugins = false\nmemories = false\napps = false\n[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`,
    );
    client = new RuntimeClient(
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
    const initialized = await client.request<any>('initialize', {
      clientInfo: { name: 'synthetic_agent_acceptance', title: 'Synthetic isolated acceptance', version: '1' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');
    assert.equal(await realpath(initialized.codexHome), home);
    // The test aliases only its loopback provider label at the client boundary. Thread/turn IDs,
    // spawn execution, history and interrupts are real native APIs; this is not an auth/entitlement test.
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
    const data = new Map();
    coordinator = new Coordinator(
      root,
      {
        get: (k, v) => data.get(k) ?? v,
        update: async (k, v) => {
          data.set(k, v);
        },
      },
      () => {},
      async () => {},
      () => {},
    );
    await coordinator.attach(
      client,
      '0.152.0',
      runtimeSettings({
        model: 'gpt-5.3-codex',
        sandbox_mode: 'read-only',
        approval_policy: 'never',
        features: { multi_agent: true },
      }),
    );
    await deadline(() => coordinator!.state.account !== 'unknown', 'Native account read did not settle');
    assert.equal(coordinator.state.account, 'provider');
    coordinator.state.effort = 'medium';
    coordinator.state.models.push({
      ...coordinator.state.models[0],
      id: 'synthetic-model',
      model: 'gpt-5.3-codex',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Synthetic fixture' }],
    });
    coordinator.state.model = 'gpt-5.3-codex';
    await coordinator.newThread();
    await coordinator.send('SYNTHETIC_PARENT_TASK: spawn the synthetic child.');
    await deadline(
      () => childRequests > 0 && coordinator!.state.status === 'completed',
      'Native parent/child execution did not reach the fixture: ' + JSON.stringify(coordinator.state.items),
    );
    await deadline(
      () => coordinator!.agents.state.tasks.length > 0 && coordinator!.agents.active,
      'Native child was not discovered from parent collaboration events',
    );
    await coordinator.agents.refresh();
    const child = coordinator.agents.state.tasks[0];
    assert.ok(child);
    assert.equal(child.parentId, coordinator.state.threadId);
    await coordinator.agents.open(child.id);
    assert.ok(coordinator.agents.state.selected?.items.some(item => item.text.includes('SYNTHETIC_CHILD_TASK')));
    const parent = coordinator.state.threadId;
    await coordinator.stopAgent(child.id);
    await deadline(
      () => coordinator!.agents.state.tasks.find(t => t.id === child.id)?.status === 'interrupted',
      'Native child interrupt completion missing',
    );
    assert.equal(coordinator.state.threadId, parent);
    assert.equal(coordinator.state.status, 'completed');
    console.log(
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        nativeSpawn: true,
        ancestry: true,
        passiveTranscript: true,
        targetedInterrupt: true,
        parentUnchanged: true,
        syntheticProvider: true,
        liveModelEntitlement: false,
      }),
    );
  } finally {
    for (const response of hanging) response.destroy();
    await coordinator?.dispose();
    await client?.shutdown();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
}
void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
