import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NativeAuth, authorizationUrl } from '../src/runtime/auth';
import { mcpFingerprint } from '../src/integrations';
import type { RuntimeClient } from '../src/runtime/client';
import { windowsRuntimeCandidates, windowsTarget } from '../src/runtime/executable';
class Client extends EventEmitter {
  calls: any[] = [];
  status = 'oAuth';
  fail = false;
  enabled = true;
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (this.fail) throw new Error('https://private.example/?token=DO_NOT_EXPOSE');
    if (method === 'config/read')
      return { config: { mcp_servers: { fixture: { url: 'http://127.0.0.1:1234/mcp', enabled: this.enabled } } } };
    if (method === 'mcpServer/oauth/login')
      return { authorizationUrl: 'http://127.0.0.1:1234/authorize?state=private' };
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'fixture', authStatus: this.status }] };
    return {};
  }
  event(method: string, params: any) {
    this.emit('notification', { method, params });
  }
}
const fingerprint = mcpFingerprint({ url: 'http://127.0.0.1:1234/mcp' });
const tick = () => new Promise(resolve => setImmediate(resolve));
test('MCP OAuth scopes completion to the server/parent and readback; a connection cannot reuse an uncorrelated flow', async t => {
  const c = new Client(),
    auth = new NativeAuth(c as unknown as RuntimeClient, () => {});
  t.after(() => auth.dispose());
  await auth.oauth('fixture', 'parent', fingerprint);
  c.event('mcpServer/oauthLogin/completed', { name: 'fixture', threadId: 'other', success: true });
  assert.equal(auth.state?.status, 'pending');
  await assert.rejects(auth.oauth('other', 'parent', fingerprint), /Finish sign-in/);
  c.event('mcpServer/oauthLogin/completed', { name: 'fixture', threadId: 'parent', success: true });
  await tick();
  assert.equal(auth.state?.status, 'success');
  await assert.rejects(auth.oauth('fixture', 'parent', fingerprint), /Reconnect/);
});
test('MCP OAuth disconnect, unconfirmed readback and errors stay bounded and redacted', async t => {
  const c = new Client(),
    auth = new NativeAuth(c as unknown as RuntimeClient, () => {});
  t.after(() => auth.dispose());
  c.fail = true;
  await assert.rejects(
    auth.oauth('fixture', null, fingerprint),
    error => error instanceof Error && !error.message.includes('DO_NOT_EXPOSE'),
  );
  assert.equal(auth.state?.status, 'unknown');
  await assert.rejects(auth.oauth('other', null, fingerprint), /reconnect/);
  const f = new Client(),
    other = new NativeAuth(f as unknown as RuntimeClient, () => {});
  t.after(() => other.dispose());
  await other.oauth('fixture', null, fingerprint);
  f.status = 'notLoggedIn';
  f.event('mcpServer/oauthLogin/completed', { name: 'fixture', threadId: null, success: true });
  await tick();
  assert.equal(other.state?.status, 'unknown');
  const g = new Client(),
    last = new NativeAuth(g as unknown as RuntimeClient, () => {});
  t.after(() => last.dispose());
  await last.oauth('fixture', null, fingerprint);
  g.emit('disconnect');
  assert.equal(last.state?.status, 'unknown');
});
test('authorization URLs and Windows launch targets never turn shell input into execution', () => {
  for (const url of [
    'file:///etc/passwd',
    'command:test',
    'https://user:password@example.test',
    'http://remote.test',
    'javascript:alert(1)',
  ])
    assert.throws(() => authorizationUrl(url));
  assert.match(authorizationUrl('http://127.0.0.1:12000/auth'), /127.0.0.1/);
  assert.equal(windowsTarget('arm64').triple, 'aarch64-pc-windows-msvc');
  assert.throws(() => windowsTarget('ia32'));
  const paths = windowsRuntimeCandidates('C:\\Program Files\\Codex', 'x64');
  assert.equal(paths.length, 2);
  assert.ok(paths.every(path => path.endsWith('bin\\codex.exe') && path.startsWith('C:\\Program Files\\Codex\\')));
});

test('disabled native MCP configuration cannot start OAuth or create a global status manager', async t => {
  const c = new Client(),
    auth = new NativeAuth(c as unknown as RuntimeClient, () => {});
  t.after(() => auth.dispose());
  c.enabled = false;
  await assert.rejects(auth.oauth('fixture', null, fingerprint), /Could not start/);
  assert.deepEqual(
    c.calls.map(call => call.method),
    ['config/read'],
  );
});

test('MCP OAuth checks the workspace-trusted fingerprint against fresh native configuration before starting', async t => {
  const c = new Client(),
    auth = new NativeAuth(c as unknown as RuntimeClient, () => {});
  t.after(() => auth.dispose());
  await assert.rejects(
    auth.oauth('fixture', null, mcpFingerprint({ url: 'https://previously-trusted.test/mcp' })),
    /Could not start/,
  );
  assert.deepEqual(
    c.calls.map(call => call.method),
    ['config/read'],
  );
});
