import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { RuntimeClient } from '../src/runtime/client';
import { connect, sharedConnection } from '../src/runtime/compatibility';
import { Integrations, mcpFingerprint } from '../src/integrations';

async function main() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ic-integrations-'))),
    root = join(temp, 'workspace'),
    home = join(temp, 'runtime');
  await Promise.all([mkdir(root), mkdir(home)]);
  const original = RuntimeClient.spawn,
    clients: RuntimeClient[] = [];
  // Only these child processes see the empty test home. No real sign-in or user config is copied.
  RuntimeClient.spawn = (executable, args, cwd) => {
    const client = new RuntimeClient(
      spawn(executable, args, {
        cwd,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: temp,
          USERPROFILE: temp,
          TMPDIR: process.env.TMPDIR,
          CODEX_HOME: home,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    clients.push(client);
    return client;
  };
  const log = join(temp, 'mcp.log'),
    grants: Record<string, string> = {};
  const started = async () => {
    try {
      return (await readFile(log, 'utf8')).split('\n').filter(Boolean);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  };
  let httpCalls = 0;
  const http = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405);
      response.end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    httpCalls++;
    if (message.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'http-fixture', version: '1.0.0' },
          }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'echo_http', description: 'Synthetic fixture', inputSchema: { type: 'object' } }] }
          : {};
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
    const skillDir = join(root, '.agents', 'skills', 'fixture');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: fixture\ndescription: Synthetic isolated integration fixture.\n---\nUse this synthetic fixture only.\n',
    );
    const executable = process.env.CODEX_RUNTIME_PATH || 'codex';
    // The production writer: one configuration runtime shared by each write and its readback.
    const control = sharedConnection(() => connect(executable, root, {}, true));
    const writer = {
      request: <T>(method: string, params?: unknown) => control(c => c.client.request<T>(method, params)),
    };
    let runtime = await connect(executable, root);
    const catalog = new Integrations(
      runtime.client,
      root,
      home,
      () => grants,
      () => {},
      () => {},
    );
    await catalog.refresh();
    const skill = catalog.state.skills.find(s => s.name === 'fixture');
    assert.ok(skill);
    await catalog.addServer('fixture', { command: process.execPath, args: [resolve('tests/fixtures/mcp.mjs'), log] });
    assert.equal(catalog.state.servers[0].enabled, false);
    await writeFile(
      join(home, 'config.toml'),
      'fixture_unrelated = "kept"\n' + (await readFile(join(home, 'config.toml'), 'utf8')),
    );
    await catalog.refresh();
    await catalog.toggleSkill(skill.id, false);
    assert.equal(catalog.skill(skill.id).enabled, false);
    await assert.rejects(catalog.selected([skill.id]), /disabled/);
    await catalog.toggleSkill(skill.id, true);
    assert.equal((await catalog.selected([skill.id]))[0].name, 'fixture');
    await catalog.changeServer(catalog.state.servers[0].id, true);
    assert.deepEqual(await started(), [], 'configuration CRUD must not start an MCP process');
    runtime.client.stop();
    runtime = await connect(executable, root);
    const blocked = new Integrations(
      runtime.client,
      root,
      home,
      () => grants,
      () => {},
      () => {},
    );
    await blocked.refresh();
    const thread: any = await runtime.client.request('thread/start', {
      cwd: root,
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    await blocked.refresh(thread.thread.id);
    assert.deepEqual(await started(), [], 'initial probe, inventory and blocked thread must not launch ungranted MCP');
    const server = blocked.server(blocked.state.servers[0].id);
    grants.fixture = mcpFingerprint(server.config);
    runtime.client.stop();
    runtime = await connect(executable, root, grants);
    assert.deepEqual(runtime.enabledMcp, ['fixture']);
    const allowedThread: any = await runtime.client.request('thread/start', {
      cwd: root,
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    const allowed = new Integrations(
      runtime.client,
      root,
      home,
      () => grants,
      () => {},
      () => {},
      async () => {},
      writer,
    );
    const deadline = Date.now() + 10000;
    do {
      await allowed.refresh(allowedThread.thread.id);
      if (allowed.state.servers[0].tools.includes('echo')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.ok(allowed.state.servers[0].tools.includes('echo'), 'allowed MCP tools must be discovered in the thread');
    assert.ok((await started()).includes('started'));
    assert.ok(!(await started()).includes('called'), 'no tool or model call is needed for configuration tests');
    const before = await readFile(join(home, 'config.toml'), 'utf8');
    assert.ok(before.includes('fixture_unrelated'));
    await allowed.changeServer(allowed.state.servers[0].id, null);
    assert.equal(allowed.state.servers.length, 0);
    assert.ok(
      (await readFile(join(home, 'config.toml'), 'utf8')).includes('fixture_unrelated'),
      'unrelated config must be preserved',
    );
    assert.equal((await runtime.client.request<any>('account/read', {})).account, null);
    runtime.client.stop();
    runtime = await connect(executable, root);
    const httpCatalog = new Integrations(
      runtime.client,
      root,
      home,
      () => grants,
      () => {},
      () => {},
      async () => {},
      writer,
    );
    await httpCatalog.refresh();
    const address = http.address();
    assert.ok(address && typeof address !== 'string');
    await httpCatalog.addServer('http_fixture', { url: `http://127.0.0.1:${address.port}/mcp` });
    await httpCatalog.changeServer(httpCatalog.state.servers[0].id, true);
    assert.equal(httpCalls, 0);
    grants.http_fixture = mcpFingerprint(httpCatalog.server(httpCatalog.state.servers[0].id).config);
    runtime.client.stop();
    runtime = await connect(executable, root, grants);
    assert.equal(httpCalls, 0, 'probe must not contact HTTP MCP');
    const httpThread: any = await runtime.client.request('thread/start', {
      cwd: root,
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    const httpLive = new Integrations(
      runtime.client,
      root,
      home,
      () => grants,
      () => {},
      () => {},
    );
    const httpDeadline = Date.now() + 10000;
    do {
      await httpLive.refresh(httpThread.thread.id);
      if (httpLive.state.servers[0].tools.includes('echo_http')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < httpDeadline);
    assert.ok(httpLive.state.servers[0].tools.includes('echo_http'));
    assert.ok(httpCalls > 0);
    console.log(
      'PASS: isolated Codex 0.152.0 Skills list/toggle/selection; MCP CAS CRUD, unknown-field preservation, ungranted probe/inventory/thread refusal, granted stdio and HTTP tool discovery. No auth copied and no model/tool calls.',
    );
  } finally {
    RuntimeClient.spawn = original;
    await Promise.allSettled(clients.map(c => c.shutdown()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
}
void main().catch(error => {
  console.error(error instanceof Error ? error.stack : 'Integration smoke failed');
  process.exitCode = 1;
});
