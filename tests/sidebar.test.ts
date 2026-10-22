import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sidebar } from '../webview/Sidebar';
import type { ViewState } from '../src/shared';
import en from '../locales/en.json';
import zh from '../locales/zh-CN.json';
import manifest from '../package.json';

test('management and chat have separate native containers using the original logo', () => {
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, 'independentCodexManager');
  assert.equal(manifest.contributes.viewsContainers.secondarySidebar[0].id, 'independentCodex');
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, 'media/icon.svg');
  assert.match(manifest.contributes.viewsContainers.activitybar[0].id, /^[a-zA-Z0-9_-]+$/);
});

test('manager renders localized account, open and historical chats without duplicating open history or the composer', () => {
  for (const t of [en, zh]) {
    const state: ViewState = {
      sendKey: 'enter',
      models: [],
      model: 'fixture',
      effort: 'low',
      mode: 'default',
      owned: false,
      title: '',
      permission: 'read-only',
      items: [],
      sessionsCursor: null,
      historyCursor: null,
      decisions: [],
      contexts: [],
      draft: '',
      sessionsArchived: false,
      locale: t === en ? 'en' : 'zh-CN',
      account: 'chatgpt',
      status: 'idle',
      runtimeVersion: 'fixture',
      channelId: 'a',
      sessionsSearch: '',
      tabs: [{ id: 'a', threadId: 'opened', title: 'Current draft', status: 'idle', unread: false }],
      sessions: [
        { id: 'opened', title: 'Duplicate title', updatedAt: 1800000000, bookmarked: false, owned: true },
        { id: 'older', title: 'Older chat', updatedAt: 1800000000, bookmarked: false, owned: true },
      ],
      usage: { buckets: [], unavailable: true, loading: false },
    };
    const html = renderToStaticMarkup(React.createElement(Sidebar, { state, t, post() {} }));
    assert.ok(html.includes(t.accountAndUsage.replace('&', '&amp;')));
    assert.ok(html.includes(t.sessionManager));
    assert.ok(html.includes('Current draft') && html.includes('Older chat'));
    assert.ok(html.includes('aria-current="true"'));
    assert.ok(!html.includes('Duplicate title') && !html.includes('<textarea'));
    assert.ok(!html.includes(t.contextUsageHelp));
    assert.ok(html.includes(t.usageUnavailable));
    const tab = state.tabs![0];
    state.sessions = [];
    for (const status of ['idle', 'offline', 'completed', 'interrupted'] as const) {
      tab.status = status;
      const normal = renderToStaticMarkup(React.createElement(Sidebar, { state, t, post() {} }));
      assert.ok(!normal.includes('<small>'), `${status} should use one row`);
    }
    for (const status of [
      'connecting',
      'starting',
      'running',
      'waiting',
      'interrupting',
      'failed',
      'unknown',
    ] as const) {
      tab.status = status;
      assert.ok(
        renderToStaticMarkup(React.createElement(Sidebar, { state, t, post() {} })).includes(
          `<small>${t[status]}</small>`,
        ),
      );
    }
    Object.assign(tab, { status: 'idle', error: true, unread: true });
    const failed = renderToStaticMarkup(React.createElement(Sidebar, { state, t, post() {} }));
    assert.ok(failed.includes(`<small>${t.failed}</small>`));
    assert.ok(failed.includes(`aria-label="${t.unread}"`));
  }
});
