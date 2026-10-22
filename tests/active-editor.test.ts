import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('selection refresh keeps its chip stable but never sends stale or invalid context', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-selection-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'sample.ts');
  await writeFile(path, 'const sample = true;');
  let selected = 'sample',
    selectionChanged!: (event: any) => void;
  const empty = { isEmpty: true };
  const range = (end: number) => ({
    isEmpty: false,
    start: { line: 0, character: 0 },
    end: { line: 0, character: end },
  });
  const editor: any = {
    document: {
      uri: { scheme: 'file', fsPath: path, toString: () => `file://${path}` },
      version: 1,
      lineCount: 1,
      getText: () => selected,
    },
    selections: [empty],
  };
  const subscribe = () => ({ dispose() {} });
  const vscode = {
    window: {
      activeTextEditor: editor,
      visibleTextEditors: [editor],
      onDidChangeActiveTextEditor: subscribe,
      onDidChangeVisibleTextEditors: subscribe,
      onDidChangeTextEditorSelection: (handler: typeof selectionChanged) => {
        selectionChanged = handler;
        return subscribe();
      },
    },
    workspace: { onDidChangeTextDocument: subscribe, getConfiguration: () => ({ get: () => true }) },
  };
  const source = buildSync({
    entryPoints: ['src/active-editor.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
  }).outputFiles[0].text;
  const module = { exports: {} as any },
    require = createRequire(join(process.cwd(), 'package.json'));
  new Function('require', 'module', 'exports', source)(
    (name: string) => (name === 'vscode' ? vscode : require(name)),
    module,
    module.exports,
  );
  const context = new module.exports.ActiveEditorContext(root, () => {});
  t.after(() => context.dispose());
  const settled = async () => {
    for (let i = 0; i < 100 && context.pending; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(context.pending, false);
  };
  const change = (selections: any[]) => {
    editor.selections = selections;
    selectionChanged({ textEditor: editor });
  };
  await settled();
  const original = context.preview([]);
  change([range(6)]);
  assert.equal(context.pending, true);
  assert.deepEqual(context.preview([]), original);
  assert.throws(() => context.capture(original.id, []), /finish updating/);
  await settled();
  const current = context.preview([]);
  assert.notEqual(current.id, original.id);
  assert.equal(context.capture(current.id, []).text, 'sample');
  assert.throws(() => context.capture(original.id, []), /changed/);
  change([range(1), range(2)]);
  assert.equal(context.preview([]), undefined);
  assert.equal(context.unavailable, true);
  selected = 'x'.repeat(60001);
  change([range(60001)]);
  await settled();
  assert.equal(context.preview([]), undefined);
  assert.equal(context.unavailable, true);
  selected = 'new';
  change([range(3)]);
  await settled();
  const beforeDismiss = context.preview([]);
  change([range(4)]);
  context.dismiss(beforeDismiss.id);
  await settled();
  assert.equal(context.preview([]), undefined);
  assert.equal(context.capture(null, []), undefined);
});
