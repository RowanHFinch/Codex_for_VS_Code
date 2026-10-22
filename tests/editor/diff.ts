import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { ProposedDiffs, PROPOSED_SCHEME } from '../../src/review/proposed-diff';

// Runs before the chat host exists, so this instance owns the proposed-diff scheme.
export async function proposedDiffTests(root: string) {
  const file = join(root, 'diff-target.txt');
  await writeFile(file, 'alpha\nbeta\n');
  const diffs = new ProposedDiffs(root);
  try {
    const owner = { channelId: 'c', id: 1, token: '11111111-1111-1111-1111-111111111111' };
    const changes = [
      {
        path: file,
        kind: { type: 'update' as const, move_path: null },
        diff: '@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n',
      },
    ];
    await diffs.open(owner, changes, 'diff-target.txt');
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputTextDiff, 'A native diff tab must open');
    const input = tab.input as vscode.TabInputTextDiff;
    assert.equal(input.original.fsPath, vscode.Uri.file(file).fsPath);
    assert.equal(input.modified.scheme, PROPOSED_SCHEME);
    assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), 'alpha\ngamma\n');
    assert.equal(await readFile(file, 'utf8'), 'alpha\nbeta\n', 'Opening a proposed diff must not write the file');
    assert.deepEqual(diffs.activeOwner(), owner, 'The editor-title accept/reject must bind to this request');
    await diffs.settle(owner.token);
    assert.ok(
      !vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.input instanceof vscode.TabInputTextDiff)),
      'Settling a request closes its diff tabs',
    );
    assert.equal(diffs.activeOwner(), undefined);
  } finally {
    diffs.dispose();
  }
}
