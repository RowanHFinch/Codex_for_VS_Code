import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

test('picker waits for visibility, navigates enabled choices, and restores focus after selection or Escape', () => {
  const require = createRequire(join(process.cwd(), 'webview/Picker.tsx'));
  const compiled = transformSync(readFileSync('webview/Picker.tsx', 'utf8'), {
    loader: 'tsx',
    jsx: 'transform',
    format: 'cjs',
  }).code;
  const module = { exports: {} as any },
    states: any[] = [true, { visibility: 'hidden' }];
  const effects: (() => void)[] = [],
    layoutEffects: (() => void)[] = [],
    listeners = new Map<string, (event: any) => void>();
  const window = {
    innerWidth: 320,
    innerHeight: 820,
    addEventListener() {},
    removeEventListener() {},
  };
  const document = {
    activeElement: null as any,
    addEventListener: (name: string, handler: any) => listeners.set(name, handler),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  const trigger = {
    getBoundingClientRect: () => ({ left: 180, right: 308, top: 778 }),
    focus: () => {
      document.activeElement = trigger;
    },
  };
  let options: any[] = [],
    stateCursor = 0,
    refCursor = 0,
    selected = '';
  const popup = {
    focus: () => {
      document.activeElement = popup;
    },
    getBoundingClientRect: () => ({ width: Math.min(350, window.innerWidth - 16) }),
    querySelectorAll: () => options.filter(item => !item.disabled),
    querySelector: (selector: string) =>
      selector.startsWith('input') ? trigger : options.find(item => item.checked && !item.disabled),
  };
  const refs = [{ current: { contains: () => false } }, { current: trigger }, { current: popup }];
  const react = {
    ...require('react'),
    useId: () => 'picker-test',
    useRef: () => refs[refCursor++],
    useState: () => {
      const index = stateCursor++;
      return [
        states[index],
        (value: any) => {
          states[index] = typeof value === 'function' ? value(states[index]) : value;
        },
      ];
    },
    useLayoutEffect: (effect: () => void) => layoutEffects.push(effect),
    useEffect: (effect: () => void) => effects.push(effect),
  };
  new Function('require', 'module', 'exports', 'document', 'window', compiled)(
    (name: string) => (name === 'react' ? react : require(name)),
    module,
    module.exports,
    document,
    window,
  );
  const flatten = (node: any): any[] =>
    !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(flatten)];
  const keys = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const render = (disabled = false, children?: any) => {
    stateCursor = refCursor = 0;
    effects.length = 0;
    layoutEffects.length = 0;
    const tree = module.exports.Picker({
      label: 'Fixture',
      ariaLabel: 'Model',
      disabled,
      children,
      sections: [
        {
          title: 'Reasoning',
          segmented: true,
          items: keys.map(key => ({
            key,
            label: key,
            checked: key === 'high',
            disabled: key === 'medium',
            onSelect: () => {
              selected = key;
            },
          })),
        },
        { items: [{ key: 'action', label: 'Action', onSelect() {} }] },
      ],
    });
    const nodes = flatten(tree);
    options = nodes
      .filter(node => node.props.className?.startsWith('picker-item ') || node.props.className === 'picker-item')
      .map(node => ({
        ...node.props,
        checked: node.props['aria-checked'],
        focus() {
          document.activeElement = this;
        },
        scrollIntoView() {},
      }));
    for (const effect of effects) effect();
    return nodes;
  };
  render();
  assert.equal(document.activeElement, null, 'a hidden popover must not receive focus');
  states[1] = { position: 'fixed' };
  let nodes = render();
  assert.equal(document.activeElement, options[2], 'the selected option receives focus');
  layoutEffects[0]();
  assert.equal(states[1].left, 8, 'a 320px panel keeps an 8px margin on both sides');
  window.innerWidth = 260;
  layoutEffects[0]();
  assert.equal(states[1].left, 8, 'resizing cannot push the popup offscreen');
  assert.equal(options.length, 7, 'all catalog efforts and action items remain available');
  assert.equal(options.at(-1).role, 'menuitem');
  const menu = nodes.find(node => node.props.role === 'menu');
  const key = (value: string) => menu.props.onKeyDown({ key: value, currentTarget: popup, preventDefault() {} });
  key('ArrowUp');
  assert.equal(document.activeElement, options[0], 'disabled choices are skipped');
  key('End');
  assert.equal(document.activeElement, options.at(-1));
  key('ArrowRight');
  assert.equal(document.activeElement, options[0], 'navigation wraps');
  key('Home');
  assert.equal(document.activeElement, options[0]);
  options[4].onClick();
  assert.equal(selected, 'max');
  assert.equal(states[0], false);
  assert.equal(document.activeElement, trigger);
  states[0] = true;
  render();
  listeners.get('keydown')!({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(states[0], false);
  assert.equal(document.activeElement, trigger);
  states[0] = true;
  nodes = render(false, react.createElement('input', { type: 'range' }));
  assert.equal(
    document.activeElement,
    popup,
    'custom dialog receives initial focus without highlighting its form fields',
  );
  const dialog = nodes.find(node => node.props.role === 'dialog');
  let intercepted = false;
  dialog.props.onKeyDown({
    key: 'ArrowRight',
    preventDefault() {
      intercepted = true;
    },
  });
  assert.equal(intercepted, false, 'native slider arrow keys must remain native');
  assert.equal(nodes.find(node => node.props['aria-haspopup'])?.props['aria-haspopup'], 'dialog');
  nodes = render(true);
  assert.equal(states[0], false, 'a newly disabled picker closes');
  nodes[0].props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
  assert.equal(states[0], false);
});
