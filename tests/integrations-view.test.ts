import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { IntegrationPanel } from '../webview/Integrations';
import { Hub } from '../webview/Hub';
import { FileInput } from '../webview/FileInput';
import en from '../locales/en.json';
import zh from '../locales/zh-CN.json';

test('only the latest refresh acknowledgement from this channel unlocks the actual Chat pane', () => {
  // Replay the component's handlers without adding test hooks to the packaged webview.
  const source = readFileSync('webview/index.tsx', 'utf8') + '\nexport { Chat };';
  const compiled = transformSync(source, { loader: 'tsx', jsx: 'transform', format: 'cjs' }).code;
  const require = createRequire(join(process.cwd(), 'webview/index.tsx')),
    module = { exports: {} as any };
  const slots: any[] = [],
    handlers = new Set<(event: any) => void>(),
    actions: any[] = [];
  let cursor = 0;
  const react = {
    ...require('react'),
    useCallback: (fn: any) => fn,
    useRef: (value: any) => ({ current: value }),
    useState(initial: any) {
      const key = cursor++;
      if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[key],
        (value: any) => {
          slots[key] = typeof value === 'function' ? value(slots[key]) : value;
        },
      ];
    },
    useEffect: (effect: () => void) => effect(),
    useLayoutEffect: (effect: () => void) => effect(),
  };
  const window = {
    addEventListener: (_: string, fn: any) => handlers.add(fn),
    removeEventListener: (_: string, fn: any) => handlers.delete(fn),
  };
  const document = {
    documentElement: { lang: '' },
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  const api = { postMessage: (message: any) => actions.push(message), getState: () => undefined };
  new Function('require', 'module', 'exports', 'window', 'document', 'acquireVsCodeApi', compiled)(
    (name: string) =>
      name.endsWith('.css')
        ? {}
        : name === 'react'
          ? react
          : name === 'react-dom/client'
            ? { createRoot: () => ({ render() {} }) }
            : require(name),
    module,
    module.exports,
    window,
    document,
    () => api,
  );
  const state = {
    channelId: 'a',
    locale: 'en',
    status: 'idle',
    account: 'chatgpt',
    runtimeVersion: '0.152.0',
    models: [],
    draft: '',
    decisions: [],
    items: [],
    contexts: [],
    integrations: { loading: false, uncertain: false, skills: [], servers: [] },
  };
  const render = () => {
    cursor = 0;
    handlers.clear();
    return module.exports.Chat({ state });
  };
  const find = (element: any, match: (value: any) => boolean): any => {
    if (!element || typeof element !== 'object') return;
    if (match(element)) return element;
    for (const child of [element.props?.children].flat(Infinity)) {
      const found = find(child, match);
      if (found) return found;
    }
  };
  const pane = () => find(render(), element => element.type === IntegrationPanel).props;
  const ack = (channelId: string, requestId: string) => {
    for (const handler of handlers) handler({ data: { type: 'integrationsRefreshed', channelId, requestId } });
  };
  find(
    render(),
    element => element.type === 'button' && element.props['aria-label'] === en.moreActions,
  ).props.onClick();
  find(
    render(),
    element => element.props?.role === 'menuitem' && element.props.children === en.hubTitle,
  ).props.onClick();
  find(render(), element => element.type === Hub).props.open('skills');
  const first = actions.at(-1).action.requestId;
  assert.equal(pane().pending, true);
  pane().refresh();
  const latest = actions.at(-1).action.requestId;
  assert.notEqual(first, latest);
  ack('a', first);
  assert.equal(pane().pending, true);
  ack('other', latest);
  assert.equal(pane().pending, true);
  ack('a', latest);
  assert.equal(pane().pending, false);

  find(render(), element => element.props?.['aria-label'] === en.backToHub).props.onClick();
  find(render(), element => element.props?.['aria-label'] === en.backToChat).props.onClick();
  find(render(), element => element.type === FileInput).props.command('history');
  assert.equal(actions.at(-1).action.type, 'refresh');
  Object.assign(state, {
    locale: 'zh-CN',
    sessions: [{ id: 'recent', title: 'Recent', updatedAt: Date.now() / 1000 - 300 }],
  });
  assert.equal(find(render(), element => element.props?.className === 'session-time').props.children, '5分钟前');
  find(render(), element => element.props?.['aria-label'] === zh.backToChat).props.onClick();
  state.status = 'offline';
  const before = actions.length;
  find(render(), element => element.type === FileInput).props.command('history');
  assert.equal(actions.length, before, 'offline history does not issue a runtime refresh');
  assert.ok(find(render(), element => element.props?.className === 'history'));
});
