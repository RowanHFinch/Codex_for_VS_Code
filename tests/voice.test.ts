import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAction } from '../src/bridge';

test('voice offers must be bounded SDP; recording and transcription are owned by the webview call', () => {
  const sdp = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n';
  assert.deepEqual(parseAction({ type: 'voiceOffer', sdp }), { type: 'voiceOffer', sdp });
  assert.throws(() => parseAction({ type: 'voiceOffer', sdp: 'not sdp' }));
  assert.throws(() => parseAction({ type: 'voiceOffer', sdp: 'v=0' + 'x'.repeat(100_000) }));
  assert.deepEqual(parseAction({ type: 'voiceStop' }), { type: 'voiceStop' });
});
