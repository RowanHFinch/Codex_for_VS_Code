import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { annotationContext, splitAnnotations } from '../src/annotations';
import { parseAction } from '../src/bridge';
import { UserMessage } from '../webview/UserMessage';
const annotation = {
  id: 'quote',
  itemId: 'answer',
  turnId: 'turn',
  text: '<script>quoted</script>\nsecond line',
  comment: '解释这个',
  start: 0,
  end: 41,
};
test('annotation bridge enforces limits, source identity and bounded text', () => {
  const action = { type: 'addAnnotation', threadId: 'thread', annotation };
  assert.deepEqual(parseAction(action), action);
  for (const patch of [
    { text: '' },
    { text: 'x'.repeat(8001) },
    { comment: 'x'.repeat(2001) },
    { start: -1 },
    { end: NaN },
    { itemId: '' },
  ])
    assert.throws(() => parseAction({ ...action, annotation: { ...annotation, ...patch } }));
  assert.throws(() => parseAction({ type: 'commentAnnotation', threadId: '../other', id: 'quote', text: '' }));
});
test('quoted context round-trips with source references and renders as escaped collapsible annotations', () => {
  const text = 'Question' + annotationContext([annotation]);
  assert.deepEqual(splitAnnotations(text), { text: 'Question', annotations: [annotation] });
  const html = renderToStaticMarkup(
    React.createElement(UserMessage, { text: text + '\n\n[Referenced file: /workspace/test.ts]' }),
  );
  assert.match(html, /Question/);
  assert.match(html, /1 annotation/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /解释这个/);
  assert.match(html, /test.ts/);
  assert.doesNotMatch(html, /<script>|"itemId"/);
  const malformed = text + ' ordinary text';
  assert.equal(splitAnnotations(malformed).text, malformed);
});

test('annotation placement follows actual size, centers and flips at viewport edges', async () => {
  const { annotationPosition: place } = await import('../webview/annotationPosition');
  const bounds = { left: 12, right: 308, top: 60, bottom: 700 };
  const anchor = { left: 100, right: 220, top: 400, bottom: 420 };
  assert.deepEqual(place(anchor, { width: 100, height: 30 }, bounds), { left: 110, top: 362 });
  assert.deepEqual(place(anchor, { width: 296, height: 40 }, bounds), { left: 12, top: 352 });
  assert.deepEqual(place({ ...anchor, top: 65, bottom: 85 }, { width: 100, height: 30 }, bounds), {
    left: 110,
    top: 93,
  });
  assert.equal(place({ ...anchor, left: 280, right: 308 }, { width: 100, height: 30 }, bounds).left, 208);
});
test('dictation annotation target requires a bounded id and matching thread identity', () => {
  const offer = { type: 'voiceOffer', sdp: 'v=0\nsdp', annotationId: 'quote', threadId: 'thread' };
  assert.deepEqual(parseAction(offer), offer);
  for (const patch of [
    { threadId: undefined },
    { threadId: '../other' },
    { annotationId: '' },
    { annotationId: 'x'.repeat(201) },
  ])
    assert.throws(() => parseAction({ ...offer, ...patch }));
  assert.deepEqual(parseAction({ type: 'voiceOffer', sdp: 'v=0' }), { type: 'voiceOffer', sdp: 'v=0' });
});

test('targeted annotation voice cancellation preserves and validates its destination', () => {
  const action = { type: 'voiceCancel', annotationId: 'quote', threadId: 'thread' };
  assert.deepEqual(parseAction(action), action);
  assert.deepEqual(parseAction({ type: 'voiceCancel' }), { type: 'voiceCancel' });
  assert.throws(() => parseAction({ ...action, threadId: undefined }));
  assert.throws(() => parseAction({ ...action, annotationId: '' }));
});
