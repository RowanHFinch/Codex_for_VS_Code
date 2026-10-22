import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CliSignIn } from '../webview/SignIn';
import type { ViewState } from '../src/shared';
import en from '../locales/en.json';
import zh from '../locales/zh-CN.json';

const render = (state: Partial<ViewState>, t = en) =>
  renderToStaticMarkup(
    React.createElement(CliSignIn, {
      state: state as ViewState,
      t,
      post: () => {
        throw new Error('Rendering must not start authentication');
      },
    }),
  );
test('CLI onboarding shows no actions before a confirmed signed-out account', () => {
  for (const state of [
    { status: 'offline', account: 'unknown' },
    { status: 'connecting', account: 'unavailable', runtimeVersion: '0.152.0' },
    { status: 'idle', account: 'unknown', runtimeVersion: '0.152.0' },
    { status: 'unknown', account: 'unavailable', runtimeVersion: '0.152.0' },
    { status: 'idle', account: 'unavailable', runtimeVersion: '0.152.0', integrationBusy: true },
    { status: 'running', account: 'unavailable', runtimeVersion: '0.152.0' },
  ] as Partial<ViewState>[])
    assert.ok(!render(state).includes('<button'));
});
test('signed-in CLI users see the reused sign-in mode and no buttons in both locales', () => {
  for (const t of [en, zh]) {
    const html = render({ status: 'idle', account: 'chatgpt', runtimeVersion: '0.152.0' }, t);
    assert.ok(html.includes(t.account));
    assert.ok(!html.includes('<button'));
    assert.ok(render({ status: 'idle', account: 'apiKey', runtimeVersion: '0.152.0' }, t).includes(t.accountApiKey));
  }
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});
test('confirmed signed-out CLI points to codex login and offers only a recheck', () => {
  const html = render({ status: 'idle', account: 'unavailable', runtimeVersion: '0.152.0' });
  assert.ok(html.includes('codex login'));
  assert.ok(html.includes(en.recheckLogin));
  assert.equal(html.match(/<button/g)?.length, 1);
});

test('background account lookup is checking, and failure is neither signed-out nor still checking', () => {
  for (const t of [en, zh]) {
    const state: Partial<ViewState> = { status: 'idle', account: 'unknown', runtimeVersion: 'fixture' };
    assert.ok(render(state, t).includes(t.cliChecking));
    const failed = render({ ...state, accountReadFailed: true }, t);
    assert.ok(failed.includes(t.accountReadFailed));
    assert.ok(!failed.includes(t.cliChecking) && !failed.includes('codex login'));
    assert.ok(failed.includes(`<button`) && failed.includes(t.reconnect));
    for (const busy of [{ operationBusy: true }, { integrationBusy: true }, { status: 'running' as const }])
      assert.ok(!render({ ...state, accountReadFailed: true, ...busy }, t).includes('<button'));
  }
});
