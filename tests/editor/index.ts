import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { realpath, writeFile, symlink } from 'node:fs/promises';
import { editorContext, validateEditorState } from '../../src/context';
import { editorReviewTests } from './review';
import { liveEditorTest, liveContextTest } from './live';
import { activeEditorTests, fileMentionTests } from './context';
import { resolveLocale } from '../../src/locale';
import { nativeUiTests } from './ui';
import { proposedDiffTests } from './diff';

export async function run() {
  const root = await realpath(vscode.workspace.workspaceFolders![0].uri.fsPath);
  const receiptPath = join(
    root,
    process.env.CODEX_EDITOR_RESTORE === '1' ? 'editor-restore-result.json' : 'editor-test-result.json',
  );
  try {
    const extension = vscode.extensions.getExtension('RowanHuang.independent-codex-vscode');
    assert.ok(extension, 'Development extension must be installed');
    await extension.activate();
    if (process.env.CODEX_EDITOR_RESTORE === '1') {
      const ui = await nativeUiTests(root);
      await writeFile(receiptPath, JSON.stringify({ ok: true, ui }));
      return;
    }
    if (process.env.CODEX_EDITOR_UI === '1') {
      const ui = await nativeUiTests(root);
      await writeFile(receiptPath, JSON.stringify({ ok: true, packaged: Boolean(process.env.CODEX_TEST_VSIX), ui }));
      return;
    }
    assert.equal(extension.isActive, true);
    await proposedDiffTests(root);
    const commands = await vscode.commands.getCommands();
    for (const id of [
      'open',
      'editor',
      'addSelection',
      'logs',
      'instructions',
      'checkpoints',
      'settings',
      'acceptProposedDiff',
      'rejectProposedDiff',
      'reopenClosed',
    ])
      assert.ok(commands.includes(`independentCodex.${id}`));
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, 'sample.ts')));
    const editor = await vscode.window.showTextDocument(doc);
    let timeout: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        Promise.all([
          vscode.commands.executeCommand('independentCodex.open'),
          vscode.commands.executeCommand('independentCodex.editor'),
        ]),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Concurrent sidebar/editor open did not settle in 15 seconds')),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout!);
    }
    await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 6);
    const entry = await editorContext(root, doc, editor.selection);
    assert.equal(entry.text, 'export');
    assert.equal(entry.startLine, 1);
    assert.equal(entry.version, doc.version);
    await vscode.commands.executeCommand('independentCodex.addSelection');
    await vscode.commands.executeCommand('independentCodex.editor');
    const deadline = Date.now() + 3000;
    while (
      !vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'Codex for VS Code')) &&
      Date.now() < deadline
    )
      await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'Codex for VS Code')));
    const config = vscode.workspace.getConfiguration('independentCodex');
    assert.equal(config.get('locale'), 'auto');
    assert.equal(
      resolveLocale(config.get('locale'), vscode.env.language),
      /^zh(?:-|$)/i.test(vscode.env.language) ? 'zh-CN' : 'en',
    );
    await config.update('locale', 'zh-CN', vscode.ConfigurationTarget.Global);
    assert.equal(vscode.workspace.getConfiguration('independentCodex').get('locale'), 'zh-CN');
    await writeFile(join(root, '.env'), 'SYNTHETIC_FIXTURE=do-not-attach');
    await symlink(join(root, '.env'), join(root, 'notes.txt'));
    const alias = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, 'notes.txt')));
    await assert.rejects(editorContext(root, alias), /Credential-like/);
    const dirtyEdit = new vscode.WorkspaceEdit();
    dirtyEdit.insert(doc.uri, new vscode.Position(0, 0), '// unsaved\n');
    await vscode.workspace.applyEdit(dirtyEdit);
    assert.equal(doc.isDirty, true);
    await assert.rejects(validateEditorState(root, []), /Save or discard/);
    await doc.save();
    await assert.rejects(validateEditorState(root, [entry]), /context changed/);
    await activeEditorTests(root);
    await fileMentionTests(root);
    await editorReviewTests(root);
    if (process.env.CODEX_CONTEXT_LIVE === '1') await liveContextTest(root);
    if (process.env.CODEX_EDITOR_LIVE === '1') await liveEditorTest(root);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await config.update('locale', 'auto', vscode.ConfigurationTarget.Global);
    await writeFile(
      receiptPath,
      JSON.stringify({
        ok: true,
        review: true,
        context: true,
        mentions: true,
        contextLive: process.env.CODEX_CONTEXT_LIVE === '1',
        live: process.env.CODEX_EDITOR_LIVE === '1',
        packaged: Boolean(process.env.CODEX_TEST_VSIX),
      }),
    );
    console.log(
      'EDITOR PASS: activation, commands, sidebar/editor surface, exact selection, locale, credential symlink refusal, real dirty-buffer and stale-context send guards',
    );
  } catch (error) {
    await writeFile(
      receiptPath,
      JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : 'Native test failed' }),
    );
    throw error;
  }
}
