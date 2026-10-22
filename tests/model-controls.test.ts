import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

test('model slider preserves catalog values, adapts its stops, and disables empty or single effort catalogs', () => {
  const require = createRequire(join(process.cwd(), 'webview/ModelControls.tsx'));
  const compiled = transformSync(readFileSync('webview/ModelControls.tsx', 'utf8'), {
    loader: 'tsx',
    jsx: 'transform',
    format: 'cjs',
  }).code;
  const module = { exports: {} as any };
  const states: any[] = [];
  let cursor = 0;
  const document = { activeElement: null as any };
  const react = {
    ...require('react'),
    useState: (initial: any) => {
      const index = cursor++;
      if (states[index] === undefined) states[index] = initial;
      return [
        states[index],
        (value: any) => {
          states[index] = value;
        },
      ];
    },
    useRef: () => ({ current: null }),
    useEffect() {},
  };
  new Function('require', 'module', 'exports', 'document', compiled)(
    (name: string) => (name === 'react' ? react : require(name)),
    module,
    module.exports,
    document,
  );
  const flatten = (node: any): any[] =>
    !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(flatten)];
  let selected = '';
  const render = (keys: string[]) => {
    cursor = 0;
    return flatten(
      module.exports.ModelControls({
        modelLabel: 'Select model',
        effortLabel: 'Reasoning',
        models: ['first', 'second'].map(key => ({
          key,
          label: key,
          checked: key === 'first',
          onSelect: () => {
            selected = key;
          },
        })),
        efforts: keys.map(key => ({
          key,
          label: key,
          checked: key === 'xhigh',
          onSelect: () => {
            selected = key;
          },
        })),
      }),
    );
  };
  let nodes = render(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  const slider = nodes.find(node => node.type === 'input').props;
  assert.equal(slider.value, 3);
  assert.equal(slider.max, 5);
  assert.equal(slider['aria-valuetext'], 'xhigh');
  slider.onChange({ target: { value: '3' } });
  slider.onChange({ target: { value: '4' } });
  assert.equal(selected, '', 'dragging previews without overlapping host writes');
  slider.onPointerUp();
  assert.equal(selected, 'max');
  slider.onChange({ target: { value: '5' } });
  slider.onKeyUp();
  assert.equal(selected, 'ultra');
  nodes.find(node => node.props.className === 'model-switch').props.onClick();
  nodes = render(['low', 'high']);
  const menu = nodes.find(node => node.props.role === 'menu');
  const options = nodes.filter(node => node.props.role === 'menuitemradio');
  assert.equal(options.length, 2);
  assert.equal(options[0].props['aria-checked'], true);
  assert.equal(options[1].props['aria-checked'], false);
  const targets = options.map(() => ({
    focus() {
      document.activeElement = this;
    },
    scrollIntoView() {},
  }));
  document.activeElement = targets[0];
  menu.props.onKeyDown({ key: 'End', currentTarget: { querySelectorAll: () => targets }, preventDefault() {} });
  assert.equal(document.activeElement, targets[1]);
  options[1].props.onClick();
  assert.equal(states[1], false, 'selecting a model returns to the slider card');
  assert.equal(selected, 'second');
  nodes = render(['low', 'high']);
  const short = nodes.find(node => node.type === 'input').props;
  assert.equal(short.max, 1);
  short.onChange({ target: { value: '1' } });
  short.onBlur();
  assert.equal(selected, 'high');
  short.onChange({ target: { value: '0' } });
  short.onPointerCancel();
  short.onPointerUp();
  assert.equal(selected, 'high', 'cancelled gestures do not commit');
  for (const keys of [[], ['high']]) {
    const single = render(keys).find(node => node.type === 'input').props;
    assert.equal(single.max, 0);
    assert.equal(single.disabled, true);
  }
});
