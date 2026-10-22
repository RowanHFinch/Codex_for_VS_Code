import { authorizationUrl } from '../src/runtime/auth';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Integrations, mcpFingerprint } from '../src/integrations';
import { DeliveryError } from '../src/runtime/client';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntegrationPanel } from '../webview/Integrations';
import type { ViewState } from '../src/shared';
import en from '../locales/en.json';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ic-catalog-'))),
    file = join(home, 'config.toml');
  await writeFile(file, '# fixture');
  t.after(() => rm(home, { recursive: true, force: true }));
  let version = 'v1',
    enabled = true,
    outcome = '',
    writes = 0,
    checks = 0,
    authorizationUrl = 'https://auth.example.test/authorize';
  const servers: Record<string, any> = {
    fixture: {
      command: '/fixture/node',
      args: ['fixture'],
      env: { PRIVATE: 'SYNTHETIC_PRIVATE_TOKEN' },
      enabled: false,
    },
  };
  const calls: { method: string; params: any }[] = [];
  const rpc = {
    async request<T>(method: string, params: any = {}): Promise<T> {
      calls.push({ method, params });
      let result: any;
      if (method === 'config/read' && outcome === 'read-failed') throw new Error('Synthetic configuration read failed');
      if (method === 'skills/list')
        result = {
          data: [
            {
              cwd: home,
              errors: [],
              skills: [
                {
                  name: 'fixture',
                  path: join(home, 'SKILL.md'),
                  description: 'Fixture instruction',
                  scope: 'repo',
                  enabled,
                },
              ],
            },
          ],
        };
      else if (method === 'config/read')
        result = {
          config: { mcp_servers: servers },
          layers: [
            {
              name: { type: 'user', file, profile: null },
              version,
              config: { mcp_servers: servers },
              disabledReason: null,
            },
          ],
        };
      else if (method === 'mcpServerStatus/list')
        result = {
          data: [{ name: 'fixture', runtimeStatus: 'ready', tools: { echo: {} }, authStatus: 'notLoggedIn' }],
          nextCursor: params.cursor ? 'same' : 'same',
        };
      else if (method === 'mcpServer/oauth/login') result = { authorizationUrl };
      else if (method === 'skills/config/write' || method === 'config/value/write') {
        writes++;
        if (outcome === 'unknown') throw new DeliveryError('unknown', method, 1, 'Uncertain synthetic write');
        if (method === 'skills/config/write') {
          enabled = params.enabled;
          result = { effectiveEnabled: enabled };
        } else {
          if (params.expectedVersion !== version)
            throw new DeliveryError('rejected', method, 1, 'Stale fixture version');
          servers.fixture.enabled = params.value;
          result = {};
        }
      } else throw new Error(method);
      return result as T;
    },
  };
  const catalog = new Integrations(
    rpc,
    home,
    home,
    () => ({}),
    () => {},
    () => {},
    async () => {
      checks++;
      if (outcome === 'dirty') throw new Error('Dirty config');
    },
  );
  await catalog.refresh();
  return {
    catalog,
    calls,
    servers,
    get writes() {
      return writes;
    },
    get checks() {
      return checks;
    },
    outcome(value: string) {
      outcome = value;
    },
    version(value: string) {
      version = value;
    },
    authorization(value: string) {
      authorizationUrl = value;
    },
  };
}
test('catalog projection hides raw MCP config and unscoped inventory cannot start the global MCP manager', async t => {
  const f = await fixture(t);
  assert.equal(
    f.calls.some(c => c.method === 'mcpServerStatus/list'),
    false,
  );
  assert.equal(JSON.stringify(f.catalog.state).includes('SYNTHETIC_PRIVATE_TOKEN'), false);
  assert.equal(JSON.stringify(f.catalog.state).includes('/fixture/node'), false);
  await assert.rejects(f.catalog.refresh('thread'), /pagination did not advance/);
  assert.equal(f.calls.filter(c => c.method === 'mcpServerStatus/list').length, 2);
  assert.equal(
    mcpFingerprint({ b: 1, a: { enabled: true } }),
    mcpFingerprint({ enabled: true, a: { enabled: true }, b: 1 }),
  );
  assert.notEqual(mcpFingerprint({ a: { enabled: true } }), mcpFingerprint({ a: { enabled: false } }));
});
test('unknown integration writes cannot be replayed, refresh reconciles, and disabled selected skills stop delivery', async t => {
  const f = await fixture(t),
    skill = f.catalog.state.skills[0].id;
  f.outcome('unknown');
  await assert.rejects(f.catalog.toggleSkill(skill, false), /Uncertain/);
  assert.equal(f.catalog.state.uncertain, true);
  await assert.rejects(f.catalog.toggleSkill(skill, false), /Refresh integrations/);
  assert.equal(f.writes, 1);
  f.outcome('');
  await f.catalog.refresh();
  await f.catalog.toggleSkill(skill, false);
  assert.equal(f.catalog.state.skills[0].enabled, false);
  await assert.rejects(f.catalog.selected([skill]), /disabled/);
  await assert.rejects(f.catalog.selected(['forged-id']), /inventory changed/);
});
test('config changes use CAS, recheck dirty state immediately before write, and OAuth stays on a validated host URL', async t => {
  const f = await fixture(t),
    server = f.catalog.state.servers[0].id;
  f.outcome('dirty');
  await assert.rejects(f.catalog.changeServer(server, true), /Dirty config/);
  assert.equal(f.writes, 0);
  f.outcome('');
  f.version('v2');
  await assert.rejects(f.catalog.changeServer(server, true), /Stale fixture version/);
  assert.equal(f.writes, 1);
  assert.equal(f.catalog.state.uncertain, false);
  await f.catalog.refresh();
  await f.catalog.changeServer(f.catalog.state.servers[0].id, true);
  assert.equal(f.catalog.state.servers[0].enabled, true);
  assert.ok(f.checks >= 3);
  assert.equal(authorizationUrl('https://auth.example.test/authorize'), 'https://auth.example.test/authorize');
  for (const url of ['javascript:alert(1)', 'https://private@example.test/', 'http://remote.example.test/']) {
    assert.throws(() => authorizationUrl(url), /Unsupported authorization URL/);
  }
});
test('failed refresh locks mutations until explicit reconciliation', async t => {
  const f = await fixture(t);
  f.outcome('read-failed');
  await assert.rejects(f.catalog.refresh(), /read failed/);
  assert.equal(f.catalog.state.loading, false);
  assert.equal(f.catalog.state.uncertain, true);
  await assert.rejects(f.catalog.changeServer(f.catalog.state.servers[0].id, true), /Refresh integrations/);
  assert.equal(f.writes, 0);
  f.outcome('');
  await f.catalog.refresh();
  assert.equal(f.catalog.state.uncertain, false);
});
test('an older refresh cannot clear loading while a newer request is still pending', async () => {
  const completions: ((value: any) => void)[] = [];
  const rpc = {
    request: async <T>(method: string) =>
      (method === 'skills/list' ? { data: [] } : await new Promise(resolve => completions.push(resolve))) as T,
  };
  const catalog = new Integrations(
    rpc,
    '.',
    '.',
    () => ({}),
    () => {},
    () => {},
  );
  const first = catalog.refresh(),
    latest = catalog.refresh();
  completions[0]({ config: {}, layers: [] });
  await first;
  assert.equal(catalog.state.loading, true);
  completions[1]({ config: {}, layers: [] });
  await latest;
  assert.equal(catalog.state.loading, false);
});
test('pending pane refresh disables mutations immediately while explicit Refresh remains recoverable', async t => {
  const f = await fixture(t);
  const html = renderToStaticMarkup(
    React.createElement(IntegrationPanel, {
      state: { status: 'idle', integrations: f.catalog.state } as ViewState,
      t: en,
      kind: 'mcp',
      pending: true,
      post: () => {
        throw new Error('Render must not change native configuration');
      },
      back: () => {},
      refresh: () => {},
    }),
  );
  assert.match(html, /type="checkbox"[^>]*disabled/);
  assert.match(html, /<button class="secondary">Refresh<\/button>/);
});

test('a refresh delayed inside realpath cannot overwrite a newer authoritative snapshot', async () => {
  const compiled = buildSync({
    entryPoints: ['src/integrations.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['node:fs/promises'],
    write: false,
  });
  const require = createRequire(join(process.cwd(), 'package.json')),
    module = { exports: {} as any };
  let release!: () => void,
    entered!: () => void,
    reads = 0,
    version = 'v1';
  const waiting = new Promise<void>(resolve => {
    entered = resolve;
  });
  const fs = {
    ...require('node:fs/promises'),
    async realpath(path: string) {
      if (++reads === 1) {
        entered();
        await new Promise<void>(resolve => {
          release = resolve;
        });
      }
      return path;
    },
  };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
    (name: string) => (name === 'node:fs/promises' ? fs : require(name)),
    module,
    module.exports,
  );
  const rpc = {
    async request(method: string) {
      if (method === 'skills/list')
        return {
          data: [
            {
              cwd: '/fixture',
              errors: [],
              skills: [
                {
                  name: version,
                  path: `/fixture/${version}/SKILL.md`,
                  description: version,
                  scope: 'repo',
                  enabled: true,
                },
              ],
            },
          ],
        };
      assert.equal(method, 'config/read');
      return {
        config: { mcp_servers: { fixture: { command: 'fixture' } } },
        layers: [
          {
            name: { type: 'user', file: '/home/config.toml', profile: null },
            version,
            config: { mcp_servers: { fixture: {} } },
          },
        ],
      };
    },
  };
  const catalog = new module.exports.Integrations(
    rpc,
    '/fixture',
    '/home',
    () => ({}),
    () => {},
    () => {},
  );
  const older = catalog.refresh();
  await waiting;
  version = 'v2';
  await catalog.refresh();
  const latest = structuredClone(catalog.state);
  release();
  await older;
  assert.deepEqual(catalog.state, latest);
  assert.equal(catalog.state.loading, false);
  assert.equal(catalog.state.uncertain, false);
  assert.equal(catalog.skill(latest.skills[0].id).name, 'v2');
  assert.equal(catalog.server(latest.servers[0].id).version, 'v2');
  assert.equal(catalog.user.version, 'v2');
});
