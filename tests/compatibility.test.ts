import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeVersion, connect, atLeast, sharedConnection } from '../src/runtime/compatibility';
import { restrictedThreadConfig } from '../src/runtime/settings';
import { RuntimeClient } from '../src/runtime/client';
import { mcpFingerprint } from '../src/integrations';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

test('runtime gate accepts the minimum and newer releases, including prereleases', () => {
  assert.equal(atLeast('0.152.0', '0.152.0'), true);
  assert.equal(atLeast('0.163.0', '0.152.0'), true);
  assert.equal(atLeast('0.162.0-alpha.17.2', '0.152.0'), true);
  assert.equal(atLeast('1.0.0', '0.152.0'), true);
  assert.equal(atLeast('0.151.9', '0.152.0'), false);
  assert.equal(atLeast('nightly', '0.152.0'), false);
});
test('missing runtime fails clearly before login or inference', async () => {
  await assert.rejects(runtimeVersion('/nonexistent/independent-codex-runtime'), /Codex not found/);
  await assert.rejects(runtimeVersion(process.execPath), /Unsupported runtime/);
});
test('final MCP config must still match the exact workspace grant after the probe process restarts', async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ic-connect-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'workspace'),
    home = join(temp, 'runtime-home'),
    executable = join(temp, process.platform === 'win32' ? 'version.exe' : 'version');
  await Promise.all([mkdir(root), mkdir(home)]);
  if (process.platform === 'win32') {
    const source =
      'public class VersionFixture { public static void Main() { System.Console.WriteLine("codex-cli 0.152.0"); } }';
    const script = `Add-Type -TypeDefinition '${source}' -OutputAssembly '${executable.replace(/'/g, "''")}' -OutputType ConsoleApplication`;
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ]);
  } else {
    await writeFile(executable, `#!${process.execPath}\nconsole.log('codex-cli 0.152.0');\n`, { mode: 0o700 });
  }
  const original = RuntimeClient.spawn;
  t.after(() => {
    RuntimeClient.spawn = original;
  });
  const a = { command: '/fixture/a', enabled: true },
    b = { command: '/fixture/b', enabled: true };
  const connections: { stopped: boolean }[] = [],
    reads: unknown[] = [];
  RuntimeClient.spawn = () => {
    const index = connections.length,
      fake = {
        stopped: false,
        notify() {},
        stop() {
          this.stopped = true;
        },
        async request(method: string, params: unknown) {
          if (method === 'config/read') reads.push(params);
          return method === 'initialize'
            ? { codexHome: home }
            : { config: { mcp_servers: { fixture: index === 0 ? a : b } } };
        },
      };
    connections.push(fake);
    return fake as unknown as RuntimeClient;
  };
  await assert.rejects(connect(executable, root, { fixture: mcpFingerprint(a) }), /disable configured MCP/);
  assert.equal(connections.length, 2);
  assert.ok(connections.every(c => c.stopped));
  // Project `.codex/config.toml` servers are only visible with the workspace cwd; they need a grant too.
  assert.ok(reads.length && reads.every(params => (params as { cwd?: string }).cwd === root));
  const unsafeHome = join(root, 'custom-runtime');
  await mkdir(unsafeHome);
  RuntimeClient.spawn = () =>
    ({
      notify() {},
      stop() {},
      async request() {
        return { codexHome: unsafeHome };
      },
    }) as unknown as RuntimeClient;
  await assert.rejects(connect(executable, root), /separate directories/);
});

import { runtimeSettings } from '../src/runtime/settings';
test('empty native configuration keeps the runtime read-only default instead of widening permissions', () => {
  assert.equal(runtimeSettings({}).profile, ':read-only');
  assert.equal(runtimeSettings({ sandbox_mode: 'workspace-write' }).profile, ':workspace');
});
test('a shared configuration connection serves a burst once, closes when idle and replaces a dead one', async () => {
  let opened = 0;
  const made: { client: { connected: boolean; shutdown(): Promise<void> } }[] = [];
  const open = async () => {
    opened++;
    const connection = {
      client: {
        connected: true,
        async shutdown() {
          connection.client.connected = false;
        },
      },
    };
    made.push(connection);
    return connection as any;
  };
  const use = sharedConnection(open, 30);
  await Promise.all([use(async () => 1), use(async () => 2)]);
  await use(async () => {
    throw new Error('ordinary failure');
  }).catch(() => {});
  assert.equal(opened, 1, 'one process for a write and its readback');
  made[0].client.connected = false;
  await use(async () => 3);
  assert.equal(opened, 2, 'a dead connection is replaced');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(made[1].client.connected, false, 'idle connection is shut down');
});
test('restricted thread config switches off each configured MCP server and ignores unsafe names', () => {
  const settings = runtimeSettings({ mcp_servers: { docs: {}, 'a.b': {}, x_1: {} } });
  assert.deepEqual(settings.mcpServers, ['docs', 'x_1']);
  const config = restrictedThreadConfig(settings.mcpServers);
  assert.equal(config['mcp_servers.docs.enabled' as keyof typeof config], false);
  assert.equal(config['features.hooks'], false);
  assert.deepEqual(runtimeSettings({ mcp_servers: 'oops' }).mcpServers, []);
});
