import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAction, parseMessage } from '../src/bridge';
import { truncate } from '../src/shared';
import { shouldSend, mentionAt, composerTrigger } from '../webview/input';
import en from '../locales/en.json';
import zh from '../locales/zh-CN.json';
import manifest from '../package.json';

test('UI bridge rejects arbitrary commands, file URIs, credential URLs and oversized prompts', () => {
  for (const action of [
    { type: 'shell', command: 'rm' },
    { type: 'link', url: 'command:workbench.action' },
    { type: 'link', url: 'file:///etc/passwd' },
    { type: 'link', url: 'https://user:secret@example.com' },
    { type: 'send', text: 'x'.repeat(100001) },
    { type: 'open', threadId: '../../auth.json' },
    { type: 'decision', id: 1, answers: { a: { answers: [123] } } },
  ])
    assert.throws(() => parseAction(action));
  assert.deepEqual(parseAction({ type: 'link', url: 'https://example.com' }), {
    type: 'link',
    url: 'https://example.com/',
  });
});
test('pasted images accept only bounded base64 raster data URLs', () => {
  const data = 'data:image/png;base64,iVBORw0KGgo=';
  assert.deepEqual(parseAction({ type: 'pasteImage', id: 'img-1', name: 'image.png', data, threadId: null }), {
    type: 'pasteImage',
    id: 'img-1',
    name: 'image.png',
    data,
    threadId: null,
  });
  assert.throws(() => parseAction({ type: 'pasteImage', id: 'img-1', name: 'image.png', data }));
  for (const bad of [
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:text/html;base64,PGI+',
    'data:image/png;base64,<script>',
    'https://example.com/a.png',
    'data:image/png;base64,' + 'A'.repeat(14_000_100),
  ])
    assert.throws(() => parseAction({ type: 'pasteImage', id: 'img-1', name: 'image.png', data: bad, threadId: null }));
  assert.throws(() => parseAction({ type: 'pasteImage', id: '../x', name: 'image.png', data, threadId: null }));
  assert.deepEqual(parseAction({ type: 'removeImage', id: 'img-1' }), { type: 'removeImage', id: 'img-1' });
});
test('truncation never leaves a lone surrogate that the runtime would reject', () => {
  const text = 'a'.repeat(499) + '\u{1F600}tail';
  assert.equal(truncate(text, 500), 'a'.repeat(499));
  assert.equal(truncate(text, 501), 'a'.repeat(499) + '\u{1F600}');
  assert.equal(truncate('short', 500), 'short');
  assert.doesNotThrow(() => encodeURIComponent(truncate(text, 500)));
});
test('English and Chinese catalogs have complete matching keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const value of Object.values(zh)) assert.ok(value.length > 0);
});
test('chat and review actions retain bounded identities instead of accepting stale unscoped sends', () => {
  assert.throws(() => parseAction({ type: 'send', text: 'hello' }));
  assert.deepEqual(parseAction({ type: 'send', threadId: 'chat-one', text: 'hello', contextId: null }), {
    type: 'send',
    threadId: 'chat-one',
    text: 'hello',
    contextId: null,
  });
  assert.deepEqual(parseAction({ type: 'draft', threadId: null, text: 'new draft' }), {
    type: 'draft',
    threadId: null,
    text: 'new draft',
  });
  assert.throws(() => parseAction({ type: 'reviewApply', id: 'proposal', accepted: ['A', 'A'] }));
  assert.throws(() => parseAction({ type: 'permission', value: 'full-access' }));
});
test('inline rename carries a bounded, non-blank title', () => {
  assert.deepEqual(parseAction({ type: 'rename', threadId: 't-1', title: 'Fix parser' }), {
    type: 'rename',
    threadId: 't-1',
    title: 'Fix parser',
  });
  for (const title of [undefined, '   ', 'x'.repeat(201), 42])
    assert.throws(() => parseAction({ type: 'rename', threadId: 't-1', title }));
});
test('Enter sends by default and IME never sends, including the keyCode 229 compatibility path', () => {
  assert.equal(manifest.contributes.configuration.properties['independentCodex.sendKey'].default, 'enter');
  const enter = { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false };
  assert.equal(shouldSend(enter, 'enter'), true);
  assert.equal(shouldSend(enter, 'modEnter'), false);
  assert.equal(shouldSend({ ...enter, ctrlKey: true }, 'modEnter'), true);
  assert.equal(shouldSend({ ...enter, isComposing: true, metaKey: true }, 'modEnter'), false);
  assert.equal(shouldSend({ ...enter, keyCode: 229 }, 'enter'), false);
  assert.equal(shouldSend({ ...enter, shiftKey: true }, 'enter'), false);
});

test('editor context identity is required on send; native settings replaces webview language writes', () => {
  assert.throws(() => parseAction({ type: 'send', threadId: 'chat-one', text: 'hello' }));
  assert.throws(() =>
    parseAction({ type: 'send', threadId: 'chat-one', text: 'hello', contextId: { path: '/etc/passwd' } }),
  );
  assert.deepEqual(parseAction({ type: 'send', threadId: 'chat-one', text: 'hello', contextId: 'context-id' }), {
    type: 'send',
    threadId: 'chat-one',
    text: 'hello',
    contextId: 'context-id',
  });
  assert.deepEqual(parseAction({ type: 'settings', query: 'untrusted' }), { type: 'settings' });
  assert.throws(() => parseAction({ type: 'locale', value: 'zh-CN' }));
});

test('file references accept bounded opaque identities and caret mentions without treating email as a trigger', () => {
  assert.deepEqual(mentionAt('Explain @src/fi after', 15), { query: 'src/fi', start: 8, end: 15 });
  assert.deepEqual(mentionAt('@', 1), { query: '', start: 0, end: 1 });
  assert.equal(mentionAt('user@example.com', 16), undefined);
  assert.equal(mentionAt('value @done more', 16), undefined);
  assert.deepEqual(parseAction({ type: 'findFiles', requestId: 'view-1', query: 'src/fi' }), {
    type: 'findFiles',
    requestId: 'view-1',
    query: 'src/fi',
  });
  assert.deepEqual(parseAction({ type: 'attachFile', id: 'host-issued', threadId: null }), {
    type: 'attachFile',
    id: 'host-issued',
    threadId: null,
  });
  for (const action of [
    { type: 'attachFile', id: '../../.env', threadId: null },
    { type: 'attachFile', path: '/etc/passwd', threadId: null },
    { type: 'findFiles', requestId: 'view-1', query: 'x'.repeat(201) },
  ])
    assert.throws(() => parseAction(action));
});
test('all state-changing view messages require a bounded channel envelope', () => {
  assert.deepEqual(parseMessage({ channelId: 'tab-a', action: { type: 'cancel' } }), {
    channelId: 'tab-a',
    action: { type: 'cancel' },
  });
  for (const message of [
    { type: 'cancel' },
    { channelId: null, action: { type: 'cancel' } },
    { channelId: '../tab', action: { type: 'new' } },
    { channelId: 'tab', action: { type: 'mcpToggle', id: '../config', enabled: true } },
  ])
    assert.throws(() => parseMessage(message));
  assert.equal(composerTrigger('Use $fixture', 12)?.trigger, '$');
  assert.equal(composerTrigger('/skills', 7)?.trigger, '/');
  assert.equal(composerTrigger('@src/main.ts', 12)?.trigger, '@');
});

test('integration refresh acknowledgements retain a bounded request identity', () => {
  assert.deepEqual(parseAction({ type: 'refreshIntegrations', requestId: 'view-request-2' }), {
    type: 'refreshIntegrations',
    requestId: 'view-request-2',
  });
  for (const requestId of [undefined, '', '../request', 'x'.repeat(101), 2])
    assert.throws(() => parseAction({ type: 'refreshIntegrations', requestId }));
});

test('native review actions are bounded and session approval requires acceptance', () => {
  const token = '11111111-1111-1111-1111-111111111111';
  assert.deepEqual(parseAction({ type: 'openChange', id: 7, token, path: 'src/a.ts' }), {
    type: 'openChange',
    id: 7,
    token,
    path: 'src/a.ts',
  });
  assert.throws(() => parseAction({ type: 'openChange', id: 7, token: 'short', path: 'a' }));
  assert.throws(() => parseAction({ type: 'openTurnFile', turnId: 'bad turn', path: 'a' }));
  assert.throws(() => parseAction({ type: 'openTurnChanges', turnId: 'bad turn' }));
  assert.deepEqual(parseAction({ type: 'openTurnChanges', turnId: 'turn-1' }), {
    type: 'openTurnChanges',
    turnId: 'turn-1',
  });
  assert.deepEqual(parseAction({ type: 'rewind', turnId: 'turn-1' }), { type: 'rewind', turnId: 'turn-1' });
  assert.deepEqual(parseAction({ type: 'decision', id: 1, token, accept: true, session: true }), {
    type: 'decision',
    id: 1,
    token,
    cancel: undefined,
    accept: true,
    answers: undefined,
    content: undefined,
    session: true,
  });
  assert.throws(() => parseAction({ type: 'decision', id: 1, token, session: true }));
  assert.deepEqual(parseAction({ type: 'permissionMode', value: 'ask' }), { type: 'permissionMode', value: 'ask' });
  assert.throws(() => parseAction({ type: 'permissionMode', value: 'never' }));
});
