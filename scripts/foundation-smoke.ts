import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient } from '../src/runtime/client';
import { connect } from '../src/runtime/compatibility';
import { Integrations } from '../src/integrations';
import { restrictedConfig } from '../src/runtime/settings';

async function main() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ic-foundation-'))),
    root = join(temp, 'workspace'),
    home = join(temp, 'codex'),
    osHome = join(temp, 'os-home');
  await Promise.all([mkdir(root), mkdir(home), mkdir(osHome)]);
  const original = RuntimeClient.spawn,
    clients: RuntimeClient[] = [];
  let syntheticApiKey = false;
  RuntimeClient.spawn = (executable, args, cwd) => {
    const c = new RuntimeClient(
      spawn(executable, args, {
        cwd,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TMPDIR: process.env.TMPDIR,
          HOME: osHome,
          USERPROFILE: osHome,
          CODEX_HOME: home,
          ...(syntheticApiKey ? { OPENAI_API_KEY: 'sk-synthetic-not-a-secret' } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    clients.push(c);
    return c;
  };
  const log = join(temp, 'hook.log');
  const count = async () => {
    try {
      return (await readFile(log, 'utf8')).split('\n').filter(Boolean).length;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw e;
    }
  };
  const wait = async (check: () => Promise<boolean>) => {
    const end = Date.now() + 5000;
    while (!(await check()) && Date.now() < end) await new Promise(r => setTimeout(r, 25));
    assert.ok(await check(), 'Synthetic hook did not execute');
  };
  try {
    await writeFile(
      join(temp, 'hook.cjs'),
      `require('node:fs').appendFileSync(process.argv[2], 'started\\n');process.stdout.write('{"continue":true}');`,
    );
    const command = [process.execPath, join(temp, 'hook.cjs'), log].map(v => JSON.stringify(v)).join(' ');
    await writeFile(
      join(home, 'hooks.json'),
      JSON.stringify({
        hooks: { SessionStart: [{ matcher: 'startup|resume|fork', hooks: [{ type: 'command', command }] }] },
      }),
    );
    await writeFile(
      join(home, 'config.toml'),
      `model = "gpt-5.6-sol"\nmodel_reasoning_effort = "max"\nsandbox_mode = "workspace-write"\napproval_policy = "on-request"\nfixture_unrelated = "preserved"\n[features]\nhooks = true\nplugins = true\nmemories = true\nmulti_agent = true\n[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`,
    );
    const plugin = join(root, 'plugins', 'native-fixture'),
      market = join(root, '.agents', 'plugins');
    await Promise.all([mkdir(join(plugin, '.codex-plugin'), { recursive: true }), mkdir(market, { recursive: true })]);
    await writeFile(
      join(plugin, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'native-fixture',
        version: '1.0.0',
        description: 'Synthetic offline plugin acceptance fixture.',
      }),
    );
    await writeFile(
      join(market, 'marketplace.json'),
      JSON.stringify({
        name: 'native-fixture-market',
        plugins: [
          {
            name: 'native-fixture',
            source: { source: 'local', path: './plugins/native-fixture' },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Productivity',
          },
        ],
      }),
    );
    const runtime = await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root),
      writer = runtime.client;
    assert.equal(runtime.settings.model, 'gpt-5.6-sol');
    assert.equal(runtime.settings.effort, 'max');
    assert.equal(runtime.settings.profile, ':workspace');
    assert.equal((await writer.request<any>('account/read', {})).account, null);
    const catalog = new Integrations(
      writer,
      root,
      home,
      () => ({}),
      () => {},
      () => {},
    );
    await catalog.refresh();
    await catalog.refreshEcosystem();
    console.log(
      'Synthetic ecosystem counts:',
      JSON.stringify({
        hooks: catalog.ecosystem.hooks.length,
        features: catalog.ecosystem.features,
        plugins: catalog.ecosystem.plugins.length,
      }),
    );
    assert.equal(catalog.ecosystem.hooks.length, 1);
    const h = catalog.ecosystem.hooks[0];
    assert.equal(h.trust, 'untrusted');
    let active = writer;
    const start = async (restricted = false, expectedHook = false) => {
      active = (await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root)).client;
      const started = await active.request<any>('thread/start', {
        cwd: root,
        ephemeral: false,
        sessionStartSource: 'startup',
        permissions: ':workspace',
        approvalPolicy: 'on-request',
        ...(restricted ? { config: restrictedConfig } : {}),
      });
      // SessionStart is lazy in 0.152; interrupt this empty-auth turn after local startup.
      let startedTurn = false,
        terminal = false;
      const finished = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Unauthenticated local turn did not stop')), 15000);
        active.on('notification', m => {
          const p = m.params as any;
          if (p?.threadId !== started.thread.id) return;
          if (m.method === 'turn/started') startedTurn = true;
          if (m.method === 'turn/completed') {
            terminal = true;
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const turn = await active.request<any>('turn/start', {
        threadId: started.thread.id,
        effort: 'low',
        input: [{ type: 'text', text: 'Unauthenticated local hook fixture.', text_elements: [] }],
      });
      await wait(async () => startedTurn || terminal);
      if (expectedHook) await wait(async () => (await count()) === 1);
      else await new Promise(r => setTimeout(r, 250));
      if (!terminal) await active.request('turn/interrupt', { threadId: started.thread.id, turnId: turn.turn.id });
      await finished;
      return started;
    };
    await start();
    assert.equal(await count(), 0, 'Untrusted hook must not execute');
    await catalog.changeHook(h.id, true, true);
    assert.equal(catalog.ecosystem.hooks[0].trust, 'trusted');
    const trusted = await start(false, true);
    await wait(async () => (await count()) === 1);
    await active.request('thread/memoryMode/set', { threadId: trusted.thread.id, mode: 'disabled' });
    await start(true);
    await new Promise(r => setTimeout(r, 250));
    assert.equal(await count(), 1, 'Reviewed thread must disable trusted SessionStart hooks');
    await catalog.changeHook(catalog.ecosystem.hooks[0].id, false);
    const idle = await start();
    await new Promise(r => setTimeout(r, 250));
    assert.equal(await count(), 1, 'Disabled hook must not execute');
    const queued = await active.request<any>('thread/queue/add', {
      threadId: idle.thread.id,
      clientUserMessageId: '00000000-0000-4000-a000-000000000001',
      input: [{ type: 'text', text: 'Synthetic durable queue fixture.', text_elements: [] }],
    });
    assert.ok(
      (await active.request<any>('thread/queue/list', { threadId: idle.thread.id, limit: 100 })).data.some(
        (q: any) => q.id === queued.queuedSubmission.id,
      ),
    );
    await active.request('thread/queue/delete', {
      threadId: idle.thread.id,
      queuedSubmissionId: queued.queuedSubmission.id,
    });
    assert.equal(
      (await active.request<any>('thread/queue/list', { threadId: idle.thread.id, limit: 100 })).data.length,
      0,
    );
    const other = (await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root)).client;
    await assert.rejects(
      other.request('thread/resume', {
        threadId: idle.thread.id,
        cwd: root,
        permissions: ':workspace',
        excludeTurns: true,
      }),
      /active writer/,
    );
    await active.request('thread/unsubscribe', { threadId: idle.thread.id });
    await active.shutdown(); // Unsubscribe alone does not release the 0.152 writer lease.
    const resumed = await other.request<any>('thread/resume', {
      threadId: idle.thread.id,
      cwd: root,
      permissions: ':workspace',
      excludeTurns: true,
    });
    assert.equal(resumed.thread.id, idle.thread.id);
    const forked = await other.request<any>('thread/fork', {
      threadId: idle.thread.id,
      cwd: root,
      permissions: ':workspace',
      excludeTurns: true,
    });
    assert.notEqual(forked.thread.id, idle.thread.id);
    const agent = await catalog.addAgent('synthetic_reviewer');
    assert.match(await readFile(agent, 'utf8'), /developer_instructions/);
    assert.equal(catalog.ecosystem.agents[0].name, 'synthetic_reviewer');
    await assert.rejects(catalog.addAgent('synthetic_reviewer'), /EEXIST/);
    await assert.rejects(catalog.addAgent('../invalid'), /agent name/);
    const available = (await catalog.availablePlugins()).find((p: any) => p.pluginName === 'native-fixture');
    assert.ok(available, 'Repo marketplace must be discoverable');
    await catalog.installPlugin({
      pluginName: available.pluginName,
      marketplacePath: available.marketplacePath,
      remoteMarketplaceName: available.remoteMarketplaceName,
    });
    const p = catalog.ecosystem.plugins.find(p => p.name === 'native-fixture');
    assert.ok(p?.installed);
    await catalog.changePlugin(p.id, false);
    assert.equal(catalog.ecosystem.plugins.find(v => v.id === p.id)?.enabled, false);
    await catalog.changePlugin(p.id, true);
    assert.equal(catalog.ecosystem.plugins.find(v => v.id === p.id)?.enabled, true);
    await catalog.removePlugin(p.id);
    assert.equal(
      catalog.ecosystem.plugins.some(v => v.id === p.id && v.installed),
      false,
    );
    assert.match(await readFile(join(home, 'config.toml'), 'utf8'), /fixture_unrelated/);
    syntheticApiKey = true;
    const keyRuntime = (await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root)).client;
    assert.notEqual(
      (await keyRuntime.request<any>('account/read', {})).account?.type,
      'chatgpt',
      'An API key alone must never appear as a ChatGPT session',
    );
    console.log(
      'PASS: isolated native config/Max inheritance; hook trust/toggles/reviewed isolation; memory setter; native queue add/list/delete, writer refusal, unsubscribe/resume/fork; agent create/no-overwrite; plugin discovery/install/toggle/remove; synthetic API-key account refusal. Empty isolated auth; unauthenticated local turns, no successful inference or external tools.',
    );
  } finally {
    RuntimeClient.spawn = original;
    await Promise.allSettled(clients.map(c => c.shutdown()));
    await rm(temp, { recursive: true, force: true });
  }
}
void main().catch(error => {
  console.error(error instanceof Error ? error.stack : 'Foundation smoke failed');
  process.exitCode = 1;
});
