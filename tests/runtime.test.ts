import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { JsonLines, RuntimeClient, DeliveryError } from '../src/runtime/client';
import { appendDelta, timelineItem, upsertItem, turnErrorMessage } from '../src/runtime/events';
import { activityState, activityLabel } from '../webview/Activity';
import en from '../locales/en.json';
import type { ThreadItem } from '../src/protocol/v2/ThreadItem';

test('fragmented UTF-8 and multiple JSONL frames preserve identities and text', () => {
  const messages: unknown[] = [];
  const parser = new JsonLines(m => messages.push(m));
  const data = Buffer.from('{"id":1,"result":"中文"}\n\n{"method":"future/event","params":{}}\r\n');
  for (const byte of data) parser.push(Buffer.from([byte]));
  assert.deepEqual(messages, [
    { id: 1, result: '中文' },
    { method: 'future/event', params: {} },
  ]);
});
test('malformed and oversized runtime input fails closed', () => {
  for (const line of ['null\n', '[]\n', '{}\n', '{"id":{}}\n', 'oops\n'])
    assert.throws(() => new JsonLines(() => {}).push(Buffer.from(line)));
  assert.throws(() => new JsonLines(() => {}, 20).push(Buffer.alloc(21, 'x')));
});
function runtime(timeout = 500) {
  return new RuntimeClient(
    spawn(process.execPath, ['tests/fixtures/runtime.cjs'], { stdio: ['pipe', 'pipe', 'pipe'] }),
    timeout,
  );
}
test('the native runtime inherits declared editor environment without projecting its contents', async () => {
  const previous = process.env.CODEX_VSCODE_SYNTHETIC_ENV;
  process.env.CODEX_VSCODE_SYNTHETIC_ENV = 'fixture-only';
  const client = RuntimeClient.spawn(process.execPath, ['tests/fixtures/runtime.cjs'], process.cwd());
  try {
    assert.deepEqual(await client.request('syntheticEnv'), { inherited: true });
  } finally {
    await client.shutdown();
    if (previous === undefined) delete process.env.CODEX_VSCODE_SYNTHETIC_ENV;
    else process.env.CODEX_VSCODE_SYNTHETIC_ENV = previous;
  }
});
test('requests correlate out of order and errors never echo provider detail', async t => {
  const client = runtime();
  t.after(() => client.stop());
  assert.deepEqual(await Promise.all([client.request('reverse', 1), client.request('reverse', 2)]), [1, 2]);
  await assert.rejects(
    client.request('error'),
    e => e instanceof DeliveryError && e.delivery === 'rejected' && !e.message.includes('private-token'),
  );
});
test('server requests keep the original string identity', async t => {
  const client = runtime();
  t.after(() => client.stop());
  const received = once(client, 'request');
  await client.request('request');
  assert.equal((await received)[0].id, 'server-1');
});
test('timeout and exit are unknown outcomes and never automatically replay', async t => {
  const client = runtime(100);
  t.after(() => client.stop());
  await assert.rejects(client.request('hang'), e => e instanceof DeliveryError && e.delivery === 'unknown');
  const disconnected = once(client, 'disconnect', { signal: AbortSignal.timeout(5000) });
  await assert.rejects(client.request('exit'), e => e instanceof DeliveryError && e.delivery === 'unknown');
  await disconnected;
  await assert.rejects(client.request('echo'), e => e instanceof DeliveryError && e.delivery === 'not-sent');
});
test('malformed stream closes transport', async t => {
  const client = runtime();
  t.after(() => client.stop());
  await assert.rejects(client.request('malformed'));
  assert.equal(client.connected, false);
});
test('stdout EOF rejects pending work while the runtime is still alive and prevents new sends', async t => {
  const child = spawn(process.execPath, ['tests/fixtures/runtime.cjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new RuntimeClient(child, 5000);
  t.after(() => client.shutdown());
  await assert.rejects(
    client.request('closeOutput'),
    e => e instanceof DeliveryError && e.delivery === 'unknown' && /output pipe closed/.test(e.message),
  );
  assert.equal(child.exitCode, null, 'EOF must be handled before the runtime exits');
  assert.equal(client.connected, false);
  await assert.rejects(client.request('echo'), e => e instanceof DeliveryError && e.delivery === 'not-sent');
});
test('a complete final response is preserved when stdout closes immediately after it', async t => {
  const client = runtime(5000);
  t.after(() => client.shutdown());
  const disconnected = once(client, 'disconnect', { signal: AbortSignal.timeout(5000) });
  assert.deepEqual(await client.request('replyAndClose', { text: 'final 中文' }), { text: 'final 中文' });
  await disconnected;
  assert.equal(client.connected, false);
});
test('pipe errors reject pending delivery without an unhandled stream error', async t => {
  const process = spawn(globalThis.process.execPath, ['tests/fixtures/runtime.cjs'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new RuntimeClient(process);
  t.after(() => client.stop());
  const pending = client.request('hang');
  process.stdin.emit('error', new Error('EPIPE with private diagnostic'));
  await assert.rejects(
    pending,
    e => e instanceof DeliveryError && e.delivery === 'unknown' && !e.message.includes('private'),
  );
  assert.equal(client.connected, false);
});
test('stream deltas assemble once and final items replace partial content', () => {
  let items = appendDelta([], 't', 'i', 'agentMessage', 'Hello');
  items = appendDelta(items, 't', 'i', 'agentMessage', ' world');
  items = upsertItem(
    items,
    timelineItem(
      { id: 'i', type: 'agentMessage', text: 'Hello world', phase: null, memoryCitation: null, delivery: null },
      't',
    ),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'Hello world');
  items = appendDelta(items, 'other', 'i', 'agentMessage', 'separate');
  assert.equal(items.length, 2);
});
test('large output is explicitly marked truncated and retains that marker through streaming', () => {
  let items = appendDelta([], 't', 'i', 'agentMessage', 'x'.repeat(200001));
  items = appendDelta(items, 't', 'i', 'agentMessage', 'end');
  assert.equal(items[0].text.length, 200000);
  assert.equal(items[0].truncated, true);
});

test('tool presentation preserves runtime command identity and metadata through streaming', () => {
  const command: ThreadItem = {
    type: 'commandExecution',
    id: 'cmd',
    command: 'cat src/main.ts',
    cwd: '/workspace',
    status: 'inProgress',
    commandActions: [{ type: 'read', command: 'cat src/main.ts', path: 'src/main.ts', name: 'main.ts' }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    pluginId: null,
    scriptPath: null,
    processId: null,
    source: 'agent',
  };
  const started = timelineItem(command, 'turn');
  const streamed = appendDelta([started], 'turn', 'cmd', 'commandExecution', 'export const n = 1;')[0];
  assert.equal(streamed.title, 'read');
  assert.equal(streamed.detail, command.command);
  assert.equal(activityLabel(streamed, en), 'Read file');
  assert.equal(activityState(streamed), 'running');
  assert.equal(activityState(streamed, false), 'stopped');
  const failed = timelineItem(
    { ...command, status: 'completed', exitCode: 1, durationMs: 325, aggregatedOutput: 'not found' },
    'turn',
  );
  assert.equal(activityState(failed), 'failed');
  assert.equal(activityState({ ...failed, status: 'declined', exitCode: undefined }), 'declined');
  assert.equal(activityLabel(failed, en), 'Read');
  assert.equal(failed.durationMs, 325);
  assert.match(failed.text, /not found/);
});
test('MCP text results are visible without leaking opaque metadata or turning content into HTML', () => {
  const item: ThreadItem = {
    type: 'mcpToolCall',
    id: 'mcp',
    server: 'fixture',
    tool: 'search',
    status: 'completed',
    arguments: {},
    appContext: null,
    pluginId: null,
    readOnlyHint: true,
    durationMs: 100,
    error: null,
    result: {
      content: [
        { type: 'text', text: '<script>plain-text</script>' },
        { type: 'image', data: 'excluded-image' },
      ],
      structuredContent: { private: 'excluded-structure' },
      _meta: { private: 'excluded-meta' },
    },
  };
  const row = timelineItem(item, 'turn');
  assert.equal(row.title, 'search');
  assert.equal(row.detail, 'fixture');
  assert.match(row.text, /<script>plain-text<\/script>/);
  assert.doesNotMatch(row.text, /excluded/);
  assert.equal(activityState(row), 'completed');
  assert.equal(activityState(timelineItem({ ...item, error: { message: 'private-error-detail' } }, 'turn')), 'failed');
  assert.doesNotMatch(
    timelineItem({ ...item, error: { message: 'private-error-detail' } }, 'turn').text,
    /private-error/,
  );
});

test('failed turns expose only known error codes, never provider text, headers or arbitrary strings', () => {
  assert.match(
    turnErrorMessage({
      codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      message: 'SYNTHETIC_PRIVATE_TOKEN',
    }),
    /HTTP 429/,
  );
  assert.match(
    turnErrorMessage({ codexErrorInfo: 'rateLimitExceeded', message: 'SYNTHETIC_PRIVATE_TOKEN' }),
    /rateLimitExceeded/,
  );
  assert.match(
    turnErrorMessage({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } }),
    /responseStreamDisconnected/,
  );
  for (const error of [
    { message: 'SYNTHETIC_PRIVATE_TOKEN', additionalDetails: 'private' },
    { codexErrorInfo: 'SYNTHETIC_PRIVATE_TOKEN' },
    { codexErrorInfo: { SYNTHETIC_PRIVATE_TOKEN: true } },
    null,
  ])
    assert.equal(turnErrorMessage(error), 'The runtime turn failed. Request was not replayed.');
  assert.match(turnErrorMessage({ codexErrorInfo: 'unauthorized', message: 'SYNTHETIC_PRIVATE_TOKEN' }), /codex login/);
});
test('shutdown returns when the runtime exits even if its background processes keep stdio open', async () => {
  const script =
    "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000);";
  const client = RuntimeClient.spawn(process.execPath, ['-e', script], process.cwd());
  await new Promise(resolve => setTimeout(resolve, 300));
  const started = Date.now();
  await client.shutdown();
  assert.ok(Date.now() - started < 3500, `shutdown took ${Date.now() - started} ms`);
});
test('whole-rollout reads get a longer timeout than ordinary requests', async t => {
  const client = runtime(100);
  t.after(() => client.stop());
  const started = Date.now();
  await assert.rejects(client.request('hang'), e => e instanceof DeliveryError && e.delivery === 'unknown');
  assert.ok(Date.now() - started < 300);
  const slow = Date.now();
  await assert.rejects(
    client.request('thread/turns/list'),
    e => e instanceof DeliveryError && e.delivery === 'unknown',
  );
  assert.ok(Date.now() - slow >= 350);
});
