import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { elicitationFields, validateElicitation } from '../src/runtime/elicitation';
import { parseAction } from '../src/bridge';
import { McpForm } from '../webview/McpForm';
import en from '../locales/en.json';
import zh from '../locales/zh-CN.json';

const schema = {
  type: 'object',
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 10, title: 'Label' },
    count: { type: 'integer', minimum: 0, maximum: 3, default: 0 },
    confirmed: { type: 'boolean' },
    priority: {
      type: 'string',
      oneOf: [
        { const: 'low', title: 'Low priority' },
        { const: 'high', title: 'High priority' },
      ],
    },
    tags: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: {
        anyOf: [
          { const: 'a', title: 'Tag A' },
          { const: 'b', title: 'Tag B' },
        ],
      },
    },
  },
  required: ['label', 'count', 'confirmed', 'priority', 'tags'],
};
test('MCP forms preserve types, defaults, titles and constraints, including false and zero', () => {
  const fields = elicitationFields(schema),
    values = { label: 'fixture', count: 0, confirmed: false, priority: 'low', tags: ['a'] };
  assert.deepEqual(validateElicitation(fields, values), values);
  assert.equal(fields[1].default, 0);
  assert.equal(fields[3].options?.[0].label, 'Low priority');
  for (const patch of [
    { confirmed: undefined },
    { count: '0' },
    { count: 0.5 },
    { count: 4 },
    { label: '' },
    { label: 'too long a label' },
    { tags: [] },
    { tags: ['a', 'a'] },
    { tags: ['c'] },
    { priority: 'unknown' },
    { extra: 'injected' },
  ]) {
    const value: any = { ...values, ...patch };
    if (value.confirmed === undefined) delete value.confirmed;
    assert.throws(() => validateElicitation(fields, value), /No answers were sent/);
  }
  assert.doesNotThrow(() =>
    validateElicitation(elicitationFields({ type: 'object', properties: { optional: { type: 'string' } } }), {}),
  );
  const unicode = elicitationFields({
    type: 'object',
    properties: { text: { type: 'string', maxLength: 1 } },
    required: ['text'],
  });
  assert.doesNotThrow(() => validateElicitation(unicode, { text: '😀' }));
  assert.doesNotThrow(() => validateElicitation(unicode, { text: '' }));
});
test('MCP schema parsing fails closed on unknown constraints, invalid defaults, nesting and excess data', () => {
  for (const field of [
    { type: 'string', pattern: '.*' },
    { type: 'string', format: 'password' },
    { type: 'object', properties: {} },
    { type: 'string', minLength: 4, maxLength: 1 },
    { type: 'integer', default: 1.5 },
    { type: 'string', enum: ['a', 'a'] },
    { type: 'string', enum: ['a'], enumNames: [] },
    { type: 'array', items: { type: 'string' } },
  ])
    assert.throws(() => elicitationFields({ type: 'object', properties: { input: field } }));
  assert.throws(() => elicitationFields({ type: 'object', properties: JSON.parse('{"__proto__":{"type":"string"}}') }));
  assert.throws(() => elicitationFields({ type: 'object', properties: {}, required: ['missing'] }));
  assert.throws(() => elicitationFields({ type: 'object', properties: {}, additionalProperties: true }));
  assert.throws(() =>
    elicitationFields({
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [i, { type: 'string' }])),
    }),
  );
  const legacy = elicitationFields({
    type: 'object',
    properties: {
      legacy: { type: 'string', enum: ['value'], enumNames: ['Label'] },
      multi: { type: 'array', items: { type: 'string', enum: ['a'] } },
    },
  });
  assert.equal(legacy[0].options?.[0].label, 'Label');
  assert.deepEqual(validateElicitation(legacy, { multi: ['a'] }), { multi: ['a'] });
});
test('MCP formatted strings validate calendar dates, absolute URIs, emails and time zones', () => {
  const cases = {
    date: ['2024-02-29', '2025-02-29'],
    'date-time': ['2024-02-29T10:20:30+08:00', '2025-02-29T10:20:30Z'],
    email: ['a@example.test', 'not-an-email'],
    uri: ['https://example.test/path', '/relative'],
  };
  for (const [format, [yes, no]] of Object.entries(cases)) {
    const fields = elicitationFields({ type: 'object', properties: { value: { type: 'string', format } } });
    assert.doesNotThrow(() => validateElicitation(fields, { value: yes }));
    assert.throws(() => validateElicitation(fields, { value: no }));
  }
  const uri = elicitationFields({ type: 'object', properties: { value: { type: 'string', format: 'uri' } } });
  for (const value of [
    'https://example.test/a b',
    '\nhttps://example.test/',
    'https://example.test/%xx',
    'https://example.test/路径',
    'https://example.test/#a#b',
    'https://example.test/a[b]',
    'https://u[s]@example.test/',
    'https://one@two@example.test/',
  ])
    assert.throws(() => validateElicitation(uri, { value }));
  for (const value of ['https://[::1]/path?x=%20#fragment', 'mailto:fixture@example.test', 'urn:example:fixture'])
    assert.doesNotThrow(() => validateElicitation(uri, { value }));
});
test('form UI escapes untrusted labels, has explicit submission and localized secret-data guidance', () => {
  for (const t of [en, zh]) {
    const html = renderToStaticMarkup(
      React.createElement(McpForm, {
        decision: {
          id: 1,
          token: 'token',
          kind: 'approval',
          method: 'mcpServer/elicitation/request',
          threadId: 'thread',
          turnId: 'turn',
          itemId: 'server',
          canAccept: true,
          form: { serverName: 'fixture', message: '<script>injected()</script>', fields: elicitationFields(schema) },
        },
        t,
        post: () => {
          throw new Error('No submission while rendering');
        },
      }),
    );
    assert.ok(html.includes(t.mcpFormHelp));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<script>'));
    assert.match(html, /type="submit" disabled/);
    assert.match(html, /for="token-0"/);
  }
});
test('form bridge refuses nested/oversized/nonfinite content and conflicting actions', () => {
  const action = {
    type: 'decision',
    id: 1,
    token: '00000000-0000-4000-a000-000000000001',
    accept: true,
    content: { confirmed: false, count: 0, tags: ['a'] },
  };
  assert.deepEqual((parseAction(action) as any).content, action.content);
  for (const content of [{ nested: {} }, { value: Infinity }, { value: 'a'.repeat(10_001) }, { tags: [false] }])
    assert.throws(() => parseAction({ ...action, content }));
  assert.throws(() => parseAction({ ...action, cancel: true }));
});
test('a required empty string can be submitted when the native schema permits only that value', () => {
  const fields = elicitationFields({
    type: 'object',
    properties: { empty: { type: 'string', maxLength: 0 } },
    required: ['empty'],
  });
  const html = renderToStaticMarkup(
    React.createElement(McpForm, {
      decision: {
        id: 1,
        token: 'token',
        kind: 'approval',
        method: 'mcpServer/elicitation/request',
        threadId: 'thread',
        turnId: 'turn',
        itemId: 'server',
        canAccept: true,
        form: { serverName: 'fixture', message: 'Explicit empty parameter', fields },
      },
      t: en,
      post: () => {},
    }),
  );
  assert.match(html, /<button type="submit">/);
  assert.doesNotMatch(html, /<button type="submit" disabled/);
});
