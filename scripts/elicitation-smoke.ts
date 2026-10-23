import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeClient } from '../src/runtime/client';
import { Coordinator } from '../src/sessions/coordinator';
import { runtimeSettings } from '../src/runtime/settings';
import { runtimeExecutable } from '../src/runtime/executable';
import type { ThreadReadResponse } from '../src/protocol/v2/ThreadReadResponse';

async function main() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ic-forms-'))),
    root = join(temp, 'workspace'),
    home = join(temp, 'codex');
  await mkdir(root);
  await mkdir(home);
  let fixtureError: unknown,
    calls = 0;
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw),
        output = body.input?.findLast((item: any) => item.type === 'function_call_output');
      const tool = body.tools
        ?.flatMap((tool: any) =>
          tool.type === 'namespace'
            ? tool.tools.map((t: any) => ({ name: t.name, namespace: tool.name }))
            : [{ name: tool.name }],
        )
        .find((t: any) => t.name?.includes('collect'));
      assert.ok(
        tool,
        'Native MCP collect tool missing: ' +
          JSON.stringify({
            url: request.url,
            keys: Object.keys(body),
            tools: body.tools?.map((t: any) => ({ type: t.type, name: t.name })),
          }),
      );
      const item = output
        ? {
            id: 'message-fixture',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: JSON.stringify(output.output), annotations: [] }],
          }
        : { id: 'fc-fixture', type: 'function_call', call_id: 'call-fixture', ...tool, arguments: '{}' };
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (type: string, value: any) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      send('response.created', {
        response: {
          id: `fixture-${++calls}`,
          object: 'response',
          status: 'in_progress',
          model: body.model,
          output: [],
        },
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
  const requests: unknown[] = [];
  const until = async (read: () => boolean, message: string) => {
    const end = Date.now() + 20000;
    while (!read() && !fixtureError && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
    if (fixtureError) throw fixtureError;
    assert.ok(
      read(),
      message +
        ': ' +
        JSON.stringify({
          requests,
          status: coordinator?.state.status,
          notice: coordinator?.state.notice,
          items: coordinator?.state.items,
        }),
    );
  };
  try {
    await writeFile(
      join(home, 'config.toml'),
      `model = "gpt-5.3-codex"\nmodel_provider = "synthetic"\ncli_auth_credentials_store = "file"\n[model_providers.synthetic]\nname = "Synthetic local fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[mcp_servers.fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(resolve('tests/fixtures/elicitation.mjs'))}]\n[features]\nhooks = false\nplugins = false\nmemories = false\nmulti_agent = false\napps = false\n[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`,
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
    await client.request('initialize', {
      clientInfo: { name: 'synthetic_elicitation_acceptance', version: '1' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');
    client.on('request', message => requests.push(message));
    // Test-only alias for the loopback provider. Native MCP calls, decisions and history are real.
    const request = client.request.bind(client);
    const alias = (value: any): any => {
      if (Array.isArray(value)) return value.map(alias);
      if (!value || typeof value !== 'object') return value;
      for (const key of Object.keys(value))
        value[key] = key === 'modelProvider' && value[key] === 'synthetic' ? 'openai' : alias(value[key]);
      return value;
    };
    client.request = async (method, params?: any) =>
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
    client.prependListener('notification', alias);
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
      runtimeSettings({ model: 'gpt-5.3-codex', sandbox_mode: 'read-only', approval_policy: 'on-request' }),
    );
    coordinator.state.account = 'chatgpt';
    coordinator.state.models.push({
      ...coordinator.state.models[0],
      id: 'synthetic-model',
      model: 'gpt-5.3-codex',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Synthetic fixture' }],
    });
    coordinator.state.model = 'gpt-5.3-codex';
    coordinator.state.effort = 'medium';
    for (const action of ['accept', 'decline', 'cancel']) {
      await coordinator.newThread();
      await coordinator.send('Run the synthetic collect tool.');
      await until(() => Boolean(coordinator!.state.decisions[0]?.form), 'Native MCP form did not arrive');
      const d: import('../src/shared').Decision = coordinator.state.decisions[0];
      assert.equal(d.threadId, coordinator.state.threadId);
      assert.equal(d.canAccept, true);
      coordinator.decide(
        d.id,
        d.token,
        undefined,
        action === 'cancel',
        action === 'accept',
        action === 'accept' ? { label: 'SYNTHETIC_FORM', count: 0, confirmed: false } : undefined,
      );
      await until(() => coordinator!.state.status === 'completed', 'Native tool did not resume after MCP ' + action);
      // A completion notification is not a persistence barrier; flush/read this one-turn fixture before export.
      const persisted: ThreadReadResponse = await client.request<ThreadReadResponse>('thread/read', {
        threadId: coordinator.state.threadId!,
        includeTurns: true,
      });
      assert.equal(persisted.thread.turns.length, 1);
      assert.equal(persisted.thread.turns[0].status, 'completed');
      assert.ok(
        persisted.thread.turns[0].items.some(
          item => item.type === 'agentMessage' && item.text.includes('SYNTHETIC_FORM_' + action.toUpperCase()),
        ),
        'Completed MCP result was not persisted in native history',
      );
      const exported = await coordinator.exportConversation(coordinator.state.threadId!);
      assert.ok(exported.includes('SYNTHETIC_FORM_' + action.toUpperCase()));
      assert.ok(exported.includes('Run the synthetic collect tool.'));
      assert.ok(coordinator.state.tokenUsage?.lastTokens != null);
      assert.ok(
        coordinator.state.items.some(
          item => item.type === 'agentMessage' && item.text.includes('SYNTHETIC_FORM_' + action.toUpperCase()),
        ),
        'Native MCP did not receive the decision',
      );
    }
    console.log(
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        nativeMcpForm: true,
        accept: true,
        decline: true,
        cancel: true,
        typedValues: true,
        fullNativeExport: true,
        nativeTokenUsage: true,
        syntheticProvider: true,
        liveEntitlement: false,
      }),
    );
  } finally {
    await coordinator?.dispose();
    await client?.shutdown();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    // Windows may retain child-process directory handles briefly after shutdown.
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
