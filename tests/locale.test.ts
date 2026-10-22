import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocale } from '../src/locale';
import manifest from '../package.json';
import en from '../package.nls.json';
import zh from '../package.nls.zh-cn.json';

test('locale follows VS Code by default and native overrides are independent of the model', () => {
  for (const lang of ['zh-cn', 'zh-CN', 'zh-hans', 'zh-Hant', 'zh']) assert.equal(resolveLocale('auto', lang), 'zh-CN');
  for (const lang of ['en', 'en-US', 'de', 'fr', '']) assert.equal(resolveLocale('auto', lang), 'en');
  assert.equal(resolveLocale('en', 'zh-cn'), 'en');
  assert.equal(resolveLocale('zh-CN', 'en'), 'zh-CN');
  assert.equal(resolveLocale(undefined, 'zh-cn'), 'zh-CN');
  assert.equal(manifest.contributes.configuration.properties['independentCodex.locale'].default, 'auto');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});
test('chat contributes a Secondary Side Bar container and a native editor-title entry', () => {
  assert.equal(manifest.displayName, 'Codex for VS Code');
  assert.equal(manifest.engines.vscode, '^1.142.0');
  assert.ok(manifest.contributes.viewsContainers.secondarySidebar.some(c => c.id === 'independentCodex'));
  assert.ok(
    manifest.contributes.menus['editor/title'].some(
      c => c.command === 'independentCodex.open' && c.group.startsWith('navigation'),
    ),
  );
  assert.ok(manifest.contributes.commands.find(c => c.command === 'independentCodex.open')?.icon);
});
