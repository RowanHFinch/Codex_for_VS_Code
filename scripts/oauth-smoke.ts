import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeClient } from '../src/runtime/client';
import { NativeAuth } from '../src/runtime/auth';
import { connect } from '../src/runtime/compatibility';
import { mcpFingerprint } from '../src/integrations';

async function main() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ic-oauth-'))),
    home = join(temp, 'runtime'),
    root = join(temp, 'workspace');
  await mkdir(home);
  await mkdir(root);
  let challenge: string | null = null;
  let base = '',
    tokenExchanges = 0,
    registrations = 0,
    authorizedMcp = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, base);
    const json = (value: unknown, code = 200) => {
      response.writeHead(code, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return json({ resource: base + '/mcp', authorization_servers: [base], scopes_supported: ['fixture.read'] });
    if (
      url.pathname.startsWith('/.well-known/oauth-authorization-server') ||
      url.pathname.startsWith('/.well-known/openid-configuration')
    )
      return json({
        issuer: base,
        authorization_endpoint: base + '/authorize',
        token_endpoint: base + '/token',
        registration_endpoint: base + '/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    let body = '';
    for await (const chunk of request) body += chunk;
    if (url.pathname === '/register') {
      registrations++;
      const data = JSON.parse(body);
      return json({ ...data, client_id: 'native-fixture-client', client_id_issued_at: 1 });
    }
    if (url.pathname === '/authorize') {
      challenge = url.searchParams.get('code_challenge');
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', url.searchParams.get('state')!);
      if (url.searchParams.get('deny')) {
        callback.searchParams.set('error', 'access_denied');
        callback.searchParams.set('error_description', 'SYNTHETIC_PRIVATE_ERROR');
      } else callback.searchParams.set('code', 'fixture-code');
      response.writeHead(302, { Location: callback.toString() });
      response.end();
      return;
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(body);
      assert.equal(params.get('code'), 'fixture-code');
      assert.ok(params.get('code_verifier'));
      assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), challenge);
      tokenExchanges++;
      return json({
        access_token: 'synthetic-local-access',
        refresh_token: 'synthetic-local-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'fixture.read',
      });
    }
    if (url.pathname === '/mcp') {
      if (request.headers.authorization !== 'Bearer synthetic-local-access') {
        response.setHeader(
          'WWW-Authenticate',
          `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        );
        return json({ error: 'invalid_token' }, 401);
      }
      authorizedMcp++;
      if (request.method !== 'POST') {
        response.writeHead(405);
        response.end();
        return;
      }
      const message = JSON.parse(body);
      if (message.id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      return json({
        jsonrpc: '2.0',
        id: message.id,
        result:
          message.method === 'initialize'
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'oauth-fixture', version: '1' },
              }
            : message.method === 'tools/list'
              ? { tools: [] }
              : {},
      });
    }
    json({}, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  const config = { url: base + '/mcp', enabled: true },
    original = RuntimeClient.spawn,
    clients: RuntimeClient[] = [],
    auths: NativeAuth[] = [];
  RuntimeClient.spawn = (executable, args, cwd) => {
    const client = new RuntimeClient(
      spawn(executable, args, {
        cwd,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: temp,
          USERPROFILE: temp,
          CODEX_HOME: home,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
    clients.push(client);
    return client;
  };
  async function waitFor(auth: NativeAuth, status: string) {
    const deadline = Date.now() + 15000;
    while (auth.state?.status === 'pending' && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(auth.state?.status, status, 'Native auth completion/readback');
  }
  try {
    await writeFile(
      join(home, 'config.toml'),
      `cli_auth_credentials_store = "file"\nmcp_oauth_credentials_store = "file"\n[mcp_servers.fixture]\nurl = "${base}/mcp"\n[features]\nhooks = false\nplugins = false\nmemories = false\nmulti_agent = false\napps = false\n`,
    );
    const executable = process.env.CODEX_RUNTIME_PATH || 'codex';
    const probe = await connect(executable, root);
    const observed = await probe.client.request<any>('config/read', {});
    const blockedAuth = new NativeAuth(probe.client, () => {}, 10);
    auths.push(blockedAuth);
    await assert.rejects(
      blockedAuth.oauth('fixture', null, mcpFingerprint(observed.config.mcp_servers.fixture)),
      /Could not start/,
    );
    assert.equal(registrations, 0);
    assert.equal(tokenExchanges, 0);
    const grants = { fixture: mcpFingerprint(observed.config.mcp_servers.fixture) };
    await probe.client.shutdown();
    const runtime = await connect(executable, root, grants);
    assert.deepEqual(runtime.enabledMcp, ['fixture']);
    const auth = new NativeAuth(runtime.client, () => {}, 10);
    auths.push(auth);
    const url = await auth.oauth('fixture', null, grants.fixture);
    const parsed = new URL(url);
    assert.equal(parsed.origin, base);
    assert.ok(parsed.searchParams.get('state'));
    assert.ok(parsed.searchParams.get('code_challenge'));
    await fetch(url);
    await waitFor(auth, 'success');
    assert.equal(tokenExchanges, 1);
    assert.equal(registrations, 1);
    assert.ok(authorizedMcp > 0);
    assert.equal(JSON.stringify(auth.state).includes('synthetic-local-access'), false);
    await runtime.client.shutdown();
    const denied = await connect(executable, root, grants);
    const denyAuth = new NativeAuth(denied.client, () => {}, 10);
    auths.push(denyAuth);
    const denyUrl = new URL(await denyAuth.oauth('fixture', null, grants.fixture));
    denyUrl.searchParams.set('deny', '1');
    await fetch(denyUrl);
    await waitFor(denyAuth, 'failed');
    assert.equal(JSON.stringify(denyAuth.state).includes('SYNTHETIC_PRIVATE_ERROR'), false);
    assert.equal(tokenExchanges, 1);
    await denied.client.shutdown();
    const timed = await connect(executable, root, grants);
    const timedAuth = new NativeAuth(timed.client, () => {}, 1);
    auths.push(timedAuth);
    await timedAuth.oauth('fixture', null, grants.fixture);
    await waitFor(timedAuth, 'failed');
    await timed.client.shutdown();
    console.log(
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        nativeMcpOAuth: true,
        disabledServerRefused: true,
        pkce: true,
        completionReadback: true,
        providerDenied: true,
        nativeTimeout: true,
        redacted: true,
        tokenExchanges,
        syntheticOnly: true,
      }),
    );
  } finally {
    for (const auth of auths) auth.dispose();
    for (const client of clients) await client.shutdown();
    RuntimeClient.spawn = original;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
}
void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
