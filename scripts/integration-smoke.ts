import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { DeliveryError, JsonLines, RuntimeClient } from '../src/runtime/client';
import { connect, sharedConnection } from '../src/runtime/compatibility';
import { Integrations, mcpFingerprint } from '../src/integrations';

async function main() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ic-integrations-'))),
    root = join(temp, 'workspace'),
    home = join(temp, 'runtime');
  await Promise.all([mkdir(root), mkdir(home)]);
  const contexts = new Map([[root, { home, label: 'integration' }]]);
  const original = RuntimeClient.spawn,
    clients: RuntimeClient[] = [];
  // Only these child processes see the empty test home. No real sign-in or user config is copied.
  RuntimeClient.spawn = (executable, args, cwd) => {
    const context = contexts.get(cwd)!;
    const child = spawn(executable, args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: temp,
        USERPROFILE: temp,
        TMPDIR: process.env.TMPDIR,
        CODEX_HOME: context.home,
        ...(process.env.CODEX_STARTUP_DIAGNOSTICS === '1'
          ? { RUST_LOG: 'codex_app_server=debug,codex_state=debug,sqlx=warn' }
          : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = new RuntimeClient(child);
    if (process.env.CODEX_STARTUP_DIAGNOSTICS === '1') {
      // This fixture always uses an empty home and synthetic services; never trace a user's runtime.
      const index = clients.length + 1,
        started = Date.now();
      const trace = (event: string, detail: unknown = {}) =>
        console.log(
          JSON.stringify({
            startup: index,
            scenario: context.label,
            pid: child.pid,
            scriptMs: Math.round(process.uptime() * 1000),
            ms: Date.now() - started,
            event,
            detail,
          }),
        );
      let stderr = '';
      let stdoutBytes = 0;
      const pipeState = () => ({
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        stdinQueued: child.stdin.writableLength,
        stdinDestroyed: child.stdin.destroyed,
        stdoutEnded: child.stdout.readableEnded,
        stdoutBytes,
      });
      const snapshot = async () => {
        trace('slow-startup', pipeState());
        const files = await readdir(context.home).catch(() => []);
        trace(
          'home-files',
          await Promise.all(
            files.map(async name => {
              const info = await stat(join(context.home, name)).catch(() => undefined);
              return { name, size: info?.size, modified: info?.mtime.toISOString() };
            }),
          ),
        );
        try {
          const { DatabaseSync } = await import('node:sqlite');
          const db = new DatabaseSync(join(context.home, 'state_5.sqlite'), { readOnly: true });
          try {
            trace(
              'backfill-state',
              db.prepare('SELECT status, updated_at, last_success_at FROM backfill_state WHERE id=1').get(),
            );
          } finally {
            db.close();
          }
        } catch {
          trace('backfill-state-unavailable');
        }
        if (process.platform !== 'win32' || !child.pid) return;
        try {
          const { stdout } = await promisify(execFile)(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `$p=Get-Process -Id ${child.pid} -ErrorAction Stop; ` +
                '$p | Select-Object Id,CPU,HandleCount,WorkingSet64,@{n="Threads";e={@($_.Threads | ' +
                'Select-Object Id,ThreadState,@{n="WaitReason";e={if($_.ThreadState -eq "Wait"){$_.WaitReason}}})}} | ConvertTo-Json -Depth 4 -Compress',
            ],
            { timeout: 5000, maxBuffer: 65536, windowsHide: true },
          );
          trace('windows-process', JSON.parse(stdout));
        } catch (error) {
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          trace('windows-process-unavailable', {
            code: failure.code,
            killed: failure.killed,
            signal: failure.signal,
          });
        }
      };
      const frames: unknown[] = [];
      const parsed = new JsonLines(message => {
        frames.push({ id: message.id, method: message.method, result: 'result' in message, error: 'error' in message });
        if (frames.length > 8) frames.shift();
      });
      child.stderr.on('data', data => {
        stderr = (stderr + data.toString()).slice(-32768);
      });
      child.once('spawn', () => trace('spawn'));
      child.stdout.once('data', () => trace('first-stdout'));
      child.stdout.on('data', data => {
        stdoutBytes += data.length;
        try {
          parsed.push(data);
        } catch {
          trace('malformed-output');
        }
      });
      child.stdout.once('end', () => trace('stdout-end'));
      child.stdout.once('close', () => trace('stdout-close'));
      child.once('exit', (code, signal) => trace('exit', { code, signal }));
      const request = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        const at = Date.now();
        const slow = method === 'initialize' ? setTimeout(() => void snapshot(), 5000) : undefined;
        try {
          const pending = request<T>(method, params);
          if (method === 'initialize') {
            trace('initialize-written', pipeState());
            child.stdin.write('', error => trace('initialize-flushed', { failed: Boolean(error) }));
          }
          const result = await pending;
          if (method === 'initialize') trace('initialized', { durationMs: Date.now() - at });
          return result;
        } catch (error) {
          trace('request-failed', { method, durationMs: Date.now() - at, ...pipeState(), frames, stderr });
          if (method === 'initialize' && error instanceof DeliveryError && error.message.includes('Timed out')) {
            await snapshot();
            // Keep the failed request failed; observe a late native error without resending it.
            await new Promise(resolve => setTimeout(resolve, 10000));
            trace('after-deadline', { ...pipeState(), frames, stderr });
          }
          throw error;
        } finally {
          clearTimeout(slow);
        }
      };
    }
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
    if (process.env.CODEX_STARTUP_CONCURRENT === '1') {
      // Several editor surfaces can connect to the same native home at once.
      let failed = 0;
      for (const shared of [false, true]) {
        const roots: string[] = [];
        for (let i = 0; i < 8; i++) {
          const workspace = join(temp, `workspace-${shared}-${i}`);
          const codexHome = join(temp, `runtime-${shared}-${shared ? 0 : i}`);
          await Promise.all([mkdir(workspace), mkdir(codexHome, { recursive: true })]);
          contexts.set(workspace, { home: codexHome, label: '' });
          roots.push(workspace);
        }
        for (const phase of ['cold', 'warm']) {
          const label = `${shared ? 'shared' : 'separate'}-${phase}`;
          for (const workspace of roots) contexts.set(workspace, { ...contexts.get(workspace)!, label });
          const connections = await Promise.allSettled(
            roots.map(workspace => connect(executable, workspace, {}, true)),
          );
          const failures = connections.filter(c => c.status === 'rejected');
          console.log(
            JSON.stringify({ scenario: label, passed: connections.length - failures.length, failed: failures.length }),
          );
          for (const c of connections) if (c.status === 'fulfilled') await c.value.client.shutdown();
          failed += failures.length;
        }
      }
      assert.equal(failed, 0, 'all cold/warm startup cases must succeed without retries');
    }
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
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
void main().catch(error => {
  console.error(error instanceof Error ? error.stack : 'Integration smoke failed');
  process.exitCode = 1;
});
