import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAction } from '../src/bridge';
import { EventEmitter } from 'node:events';
import { Dictation } from '../src/voice';
import { RuntimeClient } from '../src/runtime/client';

test('voice offers must be bounded SDP; recording and transcription are owned by the webview call', () => {
  const sdp = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n';
  assert.deepEqual(parseAction({ type: 'voiceOffer', sdp }), { type: 'voiceOffer', sdp });
  assert.throws(() => parseAction({ type: 'voiceOffer', sdp: 'not sdp' }));
  assert.throws(() => parseAction({ type: 'voiceOffer', sdp: 'v=0' + 'x'.repeat(100_000) }));
  assert.deepEqual(parseAction({ type: 'voiceStop' }), { type: 'voiceStop' });
});

test('stopping dictation waits past the first quiet interval for the final transcript', async t => {
  const client = new EventEmitter() as EventEmitter & { request: Function; notify: Function; shutdown: Function };
  let closed = false;
  client.request = async (method: string) => {
    if (method === 'thread/start') return { thread: { id: 'voice-fixture' } };
    if (method === 'thread/realtime/start')
      client.emit('notification', {
        method: 'thread/realtime/sdp',
        params: { threadId: 'voice-fixture', sdp: 'answer' },
      });
    return {};
  };
  client.notify = () => {};
  client.shutdown = async () => {
    closed = true;
  };
  t.mock.method(RuntimeClient, 'spawn', () => client as unknown as RuntimeClient);
  const dictation = new Dictation(process.execPath, process.cwd());
  await dictation.start('offer');
  const delta = (text: string) =>
    client.emit('notification', {
      method: 'thread/realtime/transcript/delta',
      params: { threadId: 'voice-fixture', role: 'user', delta: text },
    });
  delta('今天测试中文');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopped = dictation.stop(10);
  t.mock.timers.tick(10);
  await Promise.resolve();
  assert.equal(closed, false);
  delta('输入');
  t.mock.timers.tick(10);
  await Promise.resolve();
  assert.equal(closed, false);
  t.mock.timers.tick(10);
  assert.equal(await stopped, '今天测试中文输入');
  assert.equal(closed, true);
});
