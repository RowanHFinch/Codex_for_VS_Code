import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextMeter } from '../webview/ContextMeter';
import en from '../locales/en.json';

test('context meter distinguishes unavailable, zero, tiny and full usage without exceeding its ring', () => {
  const render = (lastTokens: number | null, contextWindow: number | null) =>
    renderToStaticMarkup(
      React.createElement(ContextMeter, {
        usage: { lastTokens, contextWindow, total: { input: null, cached: null, output: null, reasoning: null } },
        t: en,
      }),
    );
  assert.equal(render(null, 400000), '');
  assert.equal(render(0, null), '');
  assert.equal(render(100, 0), '');
  assert.match(render(0, 400000), />0%<\/small>/);
  assert.match(render(130, 400000), /&lt;1%/);
  assert.match(render(500000, 400000), /stroke-dasharray="100 100"/);
  assert.match(render(360000, 400000), /context-meter high/);
  assert.match(render(28000, 400000), /<button[^>]+aria-label="Context window"/);
  assert.doesNotMatch(render(28000, 400000), /title=|role="img"/);
});
