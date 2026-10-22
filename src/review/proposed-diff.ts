import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { FileUpdateChange } from '../protocol/v2/FileUpdateChange';
import { proposedContent, workspacePath } from './patch';

export const PROPOSED_SCHEME = 'codex-proposed';
export type DiffOwner = { channelId: string; id: string | number; token: string };

/**
 * Shows Codex file changes in VS Code's native diff editor. The right side is a read-only
 * virtual document; nothing is written until the native approval is accepted.
 */
export class ProposedDiffs implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private documents = new Map<string, string>();
  private owners = new Map<string, DiffOwner>();
  private byToken = new Map<string, Set<string>>();
  private changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;
  private subscriptions: vscode.Disposable[];
  constructor(private root: string) {
    this.subscriptions = [
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this),
      vscode.window.onDidChangeActiveTextEditor(() => this.syncContext()),
      this.changeEmitter,
    ];
  }
  provideTextDocumentContent(uri: vscode.Uri) {
    return this.documents.get(uri.toString()) ?? '';
  }
  private syncContext() {
    void vscode.commands.executeCommand('setContext', 'independentCodex.viewingProposedDiff', Boolean(this.activeOwner()));
  }
  /** Owner of the proposed diff in the active editor, if any. */
  activeOwner() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === PROPOSED_SCHEME ? this.owners.get(uri.toString()) : undefined;
  }
  private uri(owner: DiffOwner, path: string, side: 'before' | 'after') {
    return vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: '/' + path, query: `${owner.token}&${side}` });
  }
  private full(path: string) {
    const full = isAbsolute(path) ? path : resolve(this.root, path),
      rel = relative(this.root, full);
    return !rel || rel.startsWith('..') || isAbsolute(rel) ? undefined : full;
  }
  /** Opens one file of a pending change; `path` is workspace-relative or absolute as summarized. */
  async open(owner: DiffOwner, changes: FileUpdateChange[], path: string, preserveFocus = false) {
    const change = changes.find(c => workspacePath(this.root, c.path) === path);
    if (!change) throw new Error('This change is no longer pending.');
    const full = this.full(change.path);
    if (!full) throw new Error('This change targets a file outside the workspace; review it in the chat card.');
    let current: string | null = null;
    try {
      current = await readFile(full, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const after = proposedContent(change, current) ?? '';
    const right = this.uri(owner, path, 'after');
    this.documents.set(right.toString(), after);
    this.owners.set(right.toString(), owner);
    this.changeEmitter.fire(right);
    const known = this.byToken.get(owner.token) ?? new Set<string>();
    this.byToken.set(owner.token, known.add(right.toString()));
    let left: vscode.Uri;
    if (current === null) {
      left = this.uri(owner, path, 'before');
      this.documents.set(left.toString(), '');
      known.add(left.toString());
    } else left = vscode.Uri.file(full);
    const label = change.kind.type === 'add' ? 'new file' : change.kind.type === 'delete' ? 'deleted' : 'proposed';
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path} (${label}) ↔ Codex`, {
      preview: true,
      preserveFocus,
    });
    this.syncContext();
  }
  /** Shows what Codex changed: the recorded pre-image on the left, the file on disk on the right. */
  async openSnapshot(path: string, before: string | null, full: string) {
    const left = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: '/' + path, query: 'snapshot' });
    this.documents.set(left.toString(), before ?? '');
    this.changeEmitter.fire(left);
    await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(full), `${path} (before Codex) ↔ now`, {
      preview: true,
    });
  }
  /** Closes diff tabs and forgets documents for a settled request. */
  async settle(token: string) {
    const stale = [...(this.byToken.get(token) ?? [])];
    this.byToken.delete(token);
    if (!stale.length) return;
    const tabs = vscode.window.tabGroups.all
      .flatMap(group => group.tabs)
      .filter(tab => tab.input instanceof vscode.TabInputTextDiff && stale.includes(tab.input.modified.toString()));
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true).then(undefined, () => false);
    for (const uri of stale) {
      this.owners.delete(uri);
      this.documents.delete(uri);
    }
    this.syncContext();
  }
  dispose() {
    for (const s of this.subscriptions) s.dispose();
  }
}
