import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { accountUsage, tokenUsage } from '../src/runtime/usage';
import { Usage } from '../webview/Usage';
import type { ViewState } from '../src/shared';
import en from '../locales/en.json';
import zh from '../locales/zh-CN.json';
test('usage projection prefers native multi-bucket values and never exposes account metadata', () => {
  const raw = {
    accountId: 'PRIVATE_ACCOUNT',
    rateLimitUpsell: { private: 'PRIVATE_BANNER' },
    rateLimits: { limitName: 'legacy' },
    rateLimitsByLimitId: {
      codex: {
        limitName: 'Codex',
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1800000000 },
        secondary: { usedPercent: null, windowDurationMins: null, resetsAt: null },
        credits: { balance: 'PRIVATE_BALANCE' },
      },
    },
  };
  const value = accountUsage(raw);
  assert.equal(value.buckets.length, 1);
  assert.equal(value.buckets[0].name, 'Codex');
  assert.equal(value.buckets[0].windows[0].usedPercent, 0);
  assert.equal(value.buckets[0].windows[1].usedPercent, null);
  assert.ok(!JSON.stringify(value).includes('PRIVATE_'));
  assert.equal(accountUsage({}).unavailable, true);
  assert.equal(accountUsage({ rateLimits: { limitId: 'codex' } }).buckets[0].windows.length, 0);
  const tokens = tokenUsage({
    total: { inputTokens: 0, cachedInputTokens: null, outputTokens: -1, reasoningOutputTokens: NaN },
    last: { totalTokens: 10 },
    modelContextWindow: 400000,
  });
  assert.deepEqual(tokens, {
    total: { input: 0, cached: null, output: null, reasoning: null },
    lastTokens: 10,
    contextWindow: 400000,
  });
});
test('usage UI distinguishes absent windows from zero usage, overages and unknown context', () => {
  for (const t of [en, zh]) {
    const state = {
      locale: t === en ? 'en' : 'zh-CN',
      status: 'idle',
      account: 'chatgpt',
      usage: accountUsage({
        rateLimits: { limitId: 'codex', primary: { usedPercent: 0 }, secondary: { usedPercent: 120 } },
      }),
    } as ViewState;
    const html = renderToStaticMarkup(
      React.createElement(Usage, {
        state,
        t,
        post: () => {
          throw new Error('Rendering must not request usage');
        },
      }),
    );
    assert.ok(html.includes(`100% ${t.remaining}`));
    assert.ok(html.includes(`0% ${t.remaining}`));
    assert.ok(html.includes(t.usageUnavailable));
    assert.ok(!html.includes('undefined'));
    assert.ok(html.includes(t.contextUsageHelp));
  }
});
test('usage waiting for account metadata shows checking instead of a false unavailable result', () => {
  const state = { status: 'idle', runtimeVersion: 'fixture', account: 'unknown' } as ViewState;
  const render = () => renderToStaticMarkup(React.createElement(Usage, { state, t: en, post: () => {} }));
  assert.ok(render().includes(en.cliChecking));
  state.accountReadFailed = true;
  assert.ok(!render().includes(en.cliChecking));
  assert.ok(render().includes(en.usageUnavailable));
});
test('usage labels the weekly limit, counts down to reset and fills the remaining quota', test => {
  const now = 1800000000000;
  test.mock.method(Date, 'now', () => now);
  for (const t of [en, zh]) {
    const locale = t === en ? 'en' : 'zh-CN';
    const state = {
      locale,
      status: 'idle',
      account: 'chatgpt',
      usage: accountUsage({
        rateLimits: {
          primary: {
            usedPercent: 9,
            windowDurationMins: 10080,
            resetsAt: now / 1000 + (6 * 24 + 23) * 3600,
          },
        },
      }),
    } as ViewState;
    const render = () => renderToStaticMarkup(React.createElement(Usage, { state, t, post: () => {} }));
    const html = render();
    assert.ok(html.includes(t.weeklyLimit));
    assert.ok(!html.includes('10,080') && !html.includes('10080'));
    assert.ok(html.includes(`91% ${t.remaining}`));
    assert.match(html, /<meter[^>]*value="91"/);
    const time = ['day', 'hour']
      .map((unit, i) =>
        new Intl.NumberFormat(locale, {
          style: 'unit',
          unit,
          unitDisplay: 'narrow',
        }).format(i ? 23 : 6),
      )
      .join(' ');
    assert.ok(html.includes(t.resetsIn.replace('{time}', time)));
    const window = state.usage!.buckets[0].windows[0];
    window.durationMins = 300;
    window.resetsAt = now / 1000;
    assert.ok(render().includes(t.fiveHourLimit));
    assert.ok(render().includes(t.resetPending));
    window.resetsAt = null;
    assert.ok(render().includes(`${t.resetsAt}: ${t.usageUnavailable}`));
  }
});
