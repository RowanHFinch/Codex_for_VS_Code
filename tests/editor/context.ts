import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile, mkdir, symlink, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ActiveEditorContext } from '../../src/active-editor';
import { validateEditorState, editorContext } from '../../src/context';
import { WorkspaceFiles } from '../../src/workspace-files';

export async function fileMentionTests(root: string) {
  const folder = join(root, 'mentions');
  await mkdir(folder);
  await writeFile(join(folder, 'main.ts'), 'export const included = true;\n');
  await writeFile(join(folder, 'name with spaces.ts'), 'export {};\n');
  await writeFile(join(folder, '.env'), 'SYNTHETIC_SECRET=do-not-send');
  await symlink(join(folder, '.env'), join(folder, 'innocent.ts'));
  const outside = join(root, '..', 'outside.ts');
  await writeFile(outside, 'OUTSIDE_FIXTURE');
  await symlink(outside, join(folder, 'outside-link.ts'));
  await writeFile(join(folder, 'hard.ts'), 'HARD_LINK');
  await link(join(folder, 'hard.ts'), join(folder, 'hard-copy.ts'));
  await writeFile(join(folder, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  const catalog = new WorkspaceFiles(root),
    otherView = new WorkspaceFiles(root);
  try {
    const result = (await catalog.search('mentions/'))!;
    assert.ok(result.files.some(file => file.path === 'mentions/main.ts'));
    assert.ok(result.files.some(file => file.path === 'mentions/name with spaces.ts'));
    assert.ok(!result.files.some(file => /env|innocent|outside|hard/.test(file.path)));
    assert.ok(result.files.every(file => !('text' in file) && !('uri' in file)));
    const main = result.files.find(file => file.path === 'mentions/main.ts')!;
    assert.equal((await catalog.resolve(main.id)).fsPath, vscode.Uri.file(join(folder, 'main.ts')).fsPath);
    await assert.rejects(otherView.resolve(main.id), /search changed/);
    await assert.rejects(catalog.resolve('../../.env'), /search changed/);
    const binary = result.files.find(file => file.path.endsWith('binary.bin'))!;
    await assert.rejects(catalog.resolve(binary.id), /valid UTF-8/);
    await catalog.search('mn.ts');
    await assert.rejects(catalog.resolve(main.id), /search changed/);
    const [stale, latest] = await Promise.all([catalog.search('no-match'), catalog.search('main.ts')]);
    assert.equal(stale, undefined);
    assert.ok(latest!.files.some(file => file.path === 'mentions/main.ts'));
    const chosen = latest!.files.find(file => file.path === 'mentions/main.ts')!;
    await unlink(join(folder, 'main.ts'));
    await symlink(outside, join(folder, 'main.ts'));
    await assert.rejects(catalog.resolve(chosen.id), /links/);
    catalog.dispose();
    await assert.rejects(catalog.resolve(chosen.id), /search changed/);
    console.log(
      'EDITOR MENTION PASS: filename/fuzzy matching, spaces, opaque per-view IDs, stale/concurrent searches, binary/private/root/link refusals and changed-path revalidation.',
    );
  } finally {
    catalog.dispose();
    otherView.dispose();
  }
}

export async function activeEditorTests(root: string) {
  await mkdir(join(root, 'context'), { recursive: true });
  const uri = vscode.Uri.file(join(root, 'context', 'main.ts'));
  await writeFile(uri.fsPath, 'first\nsecond\nthird\n');
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(0, 2, 2, 0);
  const tracker = new ActiveEditorContext(root, () => {});
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), 'Active editor state did not settle');
  };
  const settled = () => !tracker.pending;
  try {
    await until(() => settled() && Boolean(tracker.preview([])));
    const preview = tracker.preview([])!;
    assert.equal(preview.path, 'context/main.ts');
    assert.equal(preview.selected, true);
    assert.equal(preview.startLine, 1);
    assert.equal(preview.endLine, 2);
    assert.equal('text' in preview, false);
    assert.equal('uri' in preview, false);
    const captured = tracker.capture(preview.id, [])!;
    assert.equal(captured.text, 'rst\nsecond\n');
    assert.equal(captured.kind, 'selection');
    assert.equal(tracker.preview([captured]), undefined);
    assert.equal(tracker.capture(null, [captured]), undefined);
    await vscode.commands.executeCommand('independentCodex.open');
    assert.equal(tracker.preview([])?.id, preview.id, 'Focusing chat must retain the last visible code selection');
    editor.selection = new vscode.Selection(1, 0, 1, 6);
    assert.throws(() => tracker.capture(preview.id, []), /context changed|finish updating/);
    await until(() => settled() && tracker.preview([])?.startLine === 2);
    const newer = tracker.preview([])!;
    assert.equal(tracker.capture(newer.id, [])?.text, 'second');
    assert.equal(tracker.dismiss(newer.id), true);
    assert.equal(tracker.capture(null, []), undefined);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await until(() => settled() && tracker.preview([])?.selected === false);
    // Whole files are path references; their text is not captured or sent.
    const whole = tracker.capture(tracker.preview([])!.id, [])!;
    assert.equal(whole.kind, 'file');
    assert.equal(whole.text, '');
    assert.equal(tracker.preview([captured]), undefined);
    tracker.dismissFile(captured.uri, captured.path);
    assert.equal(
      tracker.preview([]),
      undefined,
      'Removing a pin must not restore a hidden full-file automatic context',
    );
    assert.equal(tracker.capture(null, []), undefined);
    editor.selection = new vscode.Selection(1, 0, 1, 4);
    await until(() => settled() && Boolean(tracker.preview([])));
    const aliasedPin = { ...captured, uri: vscode.Uri.file(join(root, '..', 'same-file-alias.ts')).toString() };
    assert.equal(
      tracker.preview([aliasedPin]),
      undefined,
      'Canonical aliases must not bypass pinned context precedence',
    );
    tracker.dismissFile(aliasedPin.uri, aliasedPin.path);
    assert.equal(tracker.preview([]), undefined);
    assert.equal(tracker.capture(null, []), undefined);
    editor.selections = [new vscode.Selection(0, 0, 0, 2), new vscode.Selection(1, 0, 1, 2)];
    await until(() => settled() && tracker.unavailable);
    assert.equal(tracker.preview([]), undefined);
    assert.equal(tracker.capture(null, []), undefined);
    editor.selection = new vscode.Selection(0, 0, 0, 2);
    await until(() => settled() && Boolean(tracker.preview([])));
    const beforeEdit = tracker.preview([])!;
    const change = new vscode.WorkspaceEdit();
    change.insert(uri, new vscode.Position(0, 0), '// edited\n');
    await vscode.workspace.applyEdit(change);
    assert.throws(() => tracker.capture(beforeEdit.id, []), /context changed|finish updating/);
    await until(() => settled() && Boolean(tracker.preview([])));
    const unsaved = tracker.capture(tracker.preview([])!.id, [])!;
    assert.equal(unsaved.version, document.version);
    await assert.rejects(validateEditorState(root, [unsaved]), /Save or discard/);
    await document.save();
    for (const name of ['.netrc', '.git-credentials', '.npmrc', '.pypirc']) {
      const privateUri = vscode.Uri.file(join(root, name));
      await writeFile(privateUri.fsPath, 'SYNTHETIC_CREDENTIAL_FIXTURE=never-send');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(privateUri));
      await until(() => settled() && tracker.unavailable);
      assert.equal(tracker.preview([]), undefined, name);
      assert.equal(tracker.capture(null, []), undefined, name);
    }
    await vscode.window.showTextDocument(document);
    const outsideAlias = vscode.Uri.file(join(root, '..', 'context-alias.ts'));
    await symlink(uri.fsPath, outsideAlias.fsPath);
    const aliasDocument = await vscode.workspace.openTextDocument(outsideAlias);
    const aliasEditor = await vscode.window.showTextDocument(aliasDocument);
    const aliasEntry = await editorContext(root, aliasDocument);
    assert.equal(aliasEntry.path, 'context/main.ts');
    await aliasEditor.edit(builder => builder.insert(new vscode.Position(0, 0), '// unsaved alias\n'));
    assert.equal(aliasDocument.isDirty, true);
    await assert.rejects(validateEditorState(root, []), /Save or discard/);
    await assert.rejects(validateEditorState(root, [aliasEntry]), /Save or discard/);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    const alias = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, 'notes.txt')));
    await vscode.window.showTextDocument(alias);
    await until(() => settled() && tracker.unavailable);
    assert.equal(tracker.preview([]), undefined);
    assert.equal(tracker.capture(null, []), undefined);
    await vscode.window.showTextDocument(document);
    await until(() => settled() && Boolean(tracker.preview([])));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await until(() => settled() && tracker.preview([]) === undefined);
    console.log(
      'EDITOR CONTEXT PASS: live path/range, exclusive end-line, webview focus, stale ID refusal, remove, full file, multi-selection refusal, dirty versions, credential alias and closed editor.',
    );
  } finally {
    tracker.dispose();
  }
}
