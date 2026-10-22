import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EditorReview } from '../../src/review/editor';
import { EditJournal } from '../../src/review/journal';
import type { EditReview } from '../../src/shared';

export async function editorReviewTests(root: string) {
  let visible: EditReview | undefined;
  const directory = join(root, 'test-records');
  const service = new EditorReview(
    root,
    directory,
    () => {
      assert.equal(vscode.workspace.isTrusted, true);
    },
    value => {
      visible = value;
    },
  );
  const call = (path: string) => ({
    threadId: 'thread',
    turnId: 'turn',
    callId: 'call',
    namespace: null,
    tool: 'propose_text_edits',
    arguments: {
      path,
      replacements: [
        { oldText: '甲', newText: '乙' },
        { oldText: 'second', newText: 'changed' },
      ],
    },
  });
  const stage = async (path: string, input = call(path)) => {
    const controller = new AbortController(),
      done = service.propose(input, controller.signal);
    const deadline = Date.now() + 5000;
    while (!visible && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(visible, 'Review must become visible');
    return { controller, done, review: visible! };
  };
  const base = '甲\r\nsecond\r\n',
    after = '乙\r\nsecond\r\n';
  const waitText = async (document: vscode.TextDocument, expected: string) => {
    const deadline = Date.now() + 3000;
    while (document.getText() !== expected && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(
      document.getText(),
      expected,
      JSON.stringify({
        windowFocused: vscode.window.state.focused,
        activeDocument: vscode.window.activeTextEditor?.document.uri.toString(),
        activeTab: vscode.window.tabGroups.activeTabGroup.activeTab?.label,
      }),
    );
  };
  try {
    const uri = vscode.Uri.file(join(root, 'review-文.txt'));
    await writeFile(uri.fsPath, base);
    const document = await vscode.workspace.openTextDocument(uri);
    const concurrent = service.propose(call('review-文.txt'), new AbortController().signal);
    await assert.rejects(service.propose(call('review-文.txt'), new AbortController().signal), /Finish the current/);
    const deadline = Date.now() + 5000;
    while (!visible && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(visible);
    await service.apply(visible!.id, []);
    assert.equal((await concurrent).success, false);
    let staged = await stage('review-文.txt');
    assert.equal(document.getText(), base);
    assert.equal(await readFile(uri.fsPath, 'utf8'), base);
    await service.preview(staged.review.id, [staged.review.hunks[0].id]);
    const diff = vscode.window.tabGroups.all
      .flatMap(g => g.tabs)
      .find(
        t =>
          t.input instanceof vscode.TabInputTextDiff && t.input.original.scheme.startsWith('independent-codex-review-'),
      )?.input as vscode.TabInputTextDiff | undefined;
    assert.ok(diff);
    assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), base);
    assert.equal((await vscode.workspace.openTextDocument(diff.modified)).getText(), after);
    await service.apply(staged.review.id, [staged.review.hunks[0].id]);
    assert.equal((await staged.done).success, true);
    assert.equal(document.getText(), after);
    assert.equal(document.isDirty, true);
    assert.equal(await readFile(uri.fsPath, 'utf8'), base, 'No hidden save');
    const reopened = new EditJournal(directory, root),
      records = await reopened.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'applied');
    assert.equal(records[0].before, base);
    assert.equal(records[0].after, after);
    const editor = await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    await waitText(document, base);
    await vscode.commands.executeCommand('redo');
    await waitText(document, after);
    await editor.edit(b => b.insert(new vscode.Position(0, 0), 'manual '));
    await assert.rejects(service.restore(records[0].id), /conflict/);
    assert.ok(document.getText().startsWith('manual '));
    await editor.edit(b =>
      b.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), after),
    );
    await service.previewRestore(records[0].id);
    await service.restore(records[0].id);
    assert.equal(document.getText(), base);
    assert.equal((await reopened.read(records[0].id)).state, 'restored');
    await document.save();

    staged = await stage('review-文.txt');
    const manualEditor = await vscode.window.showTextDocument(document);
    await manualEditor.edit(b => b.insert(new vscode.Position(0, 0), 'manual '));
    await assert.rejects(service.apply(staged.review.id, [staged.review.hunks[0].id]), /conflict/);
    await service.apply(staged.review.id, []);
    assert.equal((await staged.done).success, false);
    assert.ok(document.getText().startsWith('manual '));
    assert.equal(await readFile(uri.fsPath, 'utf8'), base);
    await assert.rejects(service.propose(call('review-文.txt'), new AbortController().signal), /Save or discard/);
    await manualEditor.edit(b =>
      b.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), base),
    );
    await document.save();

    staged = await stage('review-文.txt');
    staged.controller.abort();
    assert.equal((await staged.done).success, false);
    await assert.rejects(service.apply(staged.review.id, [staged.review.hunks[0].id]), /expired/);
    assert.equal(document.getText(), base);

    staged = await stage('review-文.txt');
    const prepare = service.journal.prepare.bind(service.journal);
    let release!: () => void, reached!: () => void;
    const paused = new Promise<void>(resolve => {
        release = resolve;
      }),
      preparing = new Promise<void>(resolve => {
        reached = resolve;
      });
    service.journal.prepare = async data => {
      const record = await prepare(data);
      reached();
      await paused;
      return record;
    };
    const applying = service.apply(staged.review.id, [staged.review.hunks[0].id]);
    await preparing;
    staged.controller.abort();
    release();
    await assert.rejects(applying, /expired/);
    assert.equal((await staged.done).success, false);
    assert.equal(document.getText(), base);
    service.journal.prepare = prepare;
    const eolUri = vscode.Uri.file(join(root, 'review-eol.txt'));
    await writeFile(eolUri.fsPath, base);
    const eolCall = call('review-eol.txt');
    eolCall.arguments.replacements = [{ oldText: '甲', newText: '乙\nline' }];
    const eolStage = await stage('review-eol.txt', eolCall);
    await service.apply(
      eolStage.review.id,
      eolStage.review.hunks.map(h => h.id),
    );
    assert.equal((await eolStage.done).success, true);
    const eolDocument = await vscode.workspace.openTextDocument(eolUri);
    assert.equal(eolDocument.getText(), '乙\r\nline\r\nsecond\r\n');
    const eolRecord = (await service.journal.list()).find(r => r.path === 'review-eol.txt')!;
    assert.equal(eolRecord.after, eolDocument.getText());
    await service.restore(eolRecord.id);
    await eolDocument.save();
    const singleCall = call('review-eol.txt');
    singleCall.arguments.replacements = [{ oldText: base, newText: 'single line' }];
    const single = await stage('review-eol.txt', singleCall);
    await service.apply(
      single.review.id,
      single.review.hunks.map(h => h.id),
    );
    await single.done;
    const singleRecord = (await service.journal.list()).find(
      r => r.path === 'review-eol.txt' && r.state === 'applied',
    )!;
    const singleEditor = await vscode.window.showTextDocument(eolDocument);
    await singleEditor.edit(b => b.setEndOfLine(vscode.EndOfLine.LF));
    await service.restore(singleRecord.id);
    assert.equal(eolDocument.getText(), base);
    await eolDocument.save();
    console.log(
      'EDITOR REVIEW PASS: true pre-apply hold, native diff, selected replacement, unsaved buffer, durable receipt, manual-edit/dirty conflicts, restoration, cancellation during checkpoint capture',
    );
  } finally {
    service.dispose();
  }
}
