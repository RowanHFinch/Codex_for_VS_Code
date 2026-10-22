import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { readWorkspaceText } from '../files';
import { contentHash, proposalFromReplacements, selectedProposal, type Proposal } from './proposals';
import { EditJournal, assertRestoreText } from './journal';
import type { EditReview } from '../shared';
import type { DynamicToolCallParams } from '../protocol/v2/DynamicToolCallParams';
import type { DynamicToolCallResponse } from '../protocol/v2/DynamicToolCallResponse';

const result = (success: boolean, text: string): DynamicToolCallResponse => ({
  success,
  contentItems: [{ type: 'inputText', text }],
});
type Pending = {
  review: EditReview;
  call: DynamicToolCallParams;
  base: string;
  diskIdentity: string;
  version: number;
  document: vscode.TextDocument;
  proposal: Proposal;
  signal: AbortSignal;
  finish: (response: DynamicToolCallResponse) => void;
};

export class EditorReview implements vscode.Disposable {
  readonly journal: EditJournal;
  private pending?: Pending;
  private preparing = false;
  private applying = false;
  private snapshots = new Map<string, string>();
  private changes = new vscode.EventEmitter<vscode.Uri>();
  private scheme = `independent-codex-review-${randomUUID()}`;
  private provider: vscode.Disposable;
  constructor(
    private root: string,
    directory: string,
    private guard: () => void,
    private changed: (review?: EditReview) => void,
  ) {
    this.journal = new EditJournal(directory, root);
    this.provider = vscode.workspace.registerTextDocumentContentProvider(this.scheme, {
      onDidChange: this.changes.event,
      provideTextDocumentContent: uri => {
        const text = this.snapshots.get(uri.toString());
        if (text === undefined) throw new Error('This preview expired. Open a new preview from chat or checkpoints.');
        return text;
      },
    });
  }
  async propose(call: DynamicToolCallParams, signal: AbortSignal): Promise<DynamicToolCallResponse> {
    this.guard();
    if (this.pending || this.preparing || this.applying) throw new Error('Finish the current edit review first.');
    this.preparing = true;
    try {
      const path = (call.arguments as { path?: unknown } | null)?.path;
      if (typeof path !== 'string') throw new Error('Invalid proposal path.');
      const disk = await readWorkspaceText(this.root, path);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(disk.full));
      if (document.isDirty || document.getText() !== disk.text)
        throw new Error(
          'Save or discard changes to this file, then request a new proposal. Only UTF-8 without BOM is supported.',
        );
      const { proposal } = proposalFromReplacements(
        disk.text,
        call.arguments,
        document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
      );
      const review: EditReview = {
        id: randomUUID(),
        path,
        hunks: proposal.hunks.map(h => ({ id: h.id, before: disk.text.slice(h.start, h.end), after: h.text })),
      };
      if (signal.aborted) return result(false, 'Review cancelled before apply.');
      return new Promise(resolve => {
        const abort = () =>
          finish(
            result(
              false,
              'Review cancelled. Do not assume any edits were applied; inspect the editor and checkpoints if cancellation raced with an approved apply.',
            ),
          );
        const finish = (response: DynamicToolCallResponse) => {
          signal.removeEventListener('abort', abort);
          if (this.pending?.review.id === review.id) {
            this.pending = undefined;
            this.changed();
          }
          resolve(response);
        };
        this.pending = {
          review,
          call,
          base: disk.text,
          diskIdentity: disk.identity,
          version: document.version,
          document,
          proposal,
          signal,
          finish,
        };
        signal.addEventListener('abort', abort, { once: true });
        this.changed(review);
      });
    } finally {
      this.preparing = false;
    }
  }
  private current(id: string) {
    const p = this.pending;
    if (!p || p.review.id !== id || p.signal.aborted) throw new Error('This edit proposal expired.');
    this.guard();
    return p;
  }
  private async unchanged(p: Pending) {
    this.current(p.review.id);
    const disk = await readWorkspaceText(this.root, p.review.path);
    if (
      disk.text !== p.base ||
      disk.identity !== p.diskIdentity ||
      p.document.isDirty ||
      p.document.version !== p.version ||
      p.document.getText() !== p.base
    )
      throw new Error(
        'Edit conflict: the file or buffer changed after the proposal. No edit was applied. Request a fresh proposal.',
      );
    this.current(p.review.id);
  }
  async preview(id: string, accepted: string[]) {
    const p = this.current(id),
      after = selectedProposal(p.base, p.proposal, accepted);
    await this.unchanged(p);
    await this.diff(id, p.base, after, `${p.review.path} · Proposed edits`);
  }
  private async diff(id: string, before: string, after: string, title: string) {
    if (this.snapshots.size > 80) this.snapshots.clear();
    const base = vscode.Uri.parse(`${this.scheme}:/${id}/before`),
      proposed = vscode.Uri.parse(`${this.scheme}:/${id}/selected`);
    this.snapshots.set(base.toString(), before);
    this.snapshots.set(proposed.toString(), after);
    this.changes.fire(proposed);
    await vscode.commands.executeCommand('vscode.diff', base, proposed, title, { preview: true });
  }
  async previewRestore(id: string) {
    this.guard();
    if (this.pending || this.preparing || this.applying)
      throw new Error('Finish the active edit review before previewing a restore.');
    const record = await this.journal.read(id),
      disk = await readWorkspaceText(this.root, record.path);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(disk.full));
    assertRestoreText(record, document.getText(), disk.text);
    await this.diff(id, document.getText(), record.before, `${record.path} · Restore previous text`);
  }
  /** Resolves to where the accepted text landed, or 'declined' when nothing was written. */
  async apply(id: string, accepted: string[]): Promise<'declined' | 'buffer' | 'saved' | undefined> {
    if (this.applying) throw new Error('An editor change is already in progress.');
    const p = this.current(id),
      after = selectedProposal(p.base, p.proposal, accepted);
    if (!accepted.length || after === p.base) {
      p.finish(result(false, 'User declined the proposal before apply. No editor or file changes were made.'));
      return 'declined';
    }
    this.applying = true;
    try {
      await this.unchanged(p);
      const editor = await vscode.window.showTextDocument(p.document, { preview: false, preserveFocus: true });
      const record = await this.journal.prepare({
        path: p.review.path,
        before: p.base,
        after,
        threadId: p.call.threadId,
        turnId: p.call.turnId,
        callId: p.call.callId,
      });
      await this.unchanged(p);
      const applied = await editor.edit(
        builder => {
          this.current(id);
          if (p.document.version !== p.version || p.document.getText() !== p.base)
            throw new Error('Editor version changed before apply.');
          for (const h of p.proposal.hunks.filter(h => accepted.includes(h.id)))
            builder.replace(new vscode.Range(p.document.positionAt(h.start), p.document.positionAt(h.end)), h.text);
        },
        { undoStopBefore: true, undoStopAfter: true },
      );
      if (!applied)
        throw new Error(
          'VS Code refused the edit because the document changed. Checkpoint retained; no retry was made.',
        );
      if (p.document.getText() !== after) {
        p.finish(result(false, `Editor text changed while applying. Inspect checkpoint ${record.id}; do not retry.`));
        throw new Error(
          `Editor outcome differs from the approved text. Checkpoint ${record.id} retained; no content was overwritten to recover.`,
        );
      }
      try {
        await this.journal.mark(record, 'applied');
      } catch {
        p.finish(
          result(
            false,
            `The editor accepted the edit, but the checkpoint receipt could not be updated. Inspect checkpoint ${record.id} and the editor. Do not retry.`,
          ),
        );
        throw new Error(
          `Editor changed; checkpoint ${record.id} is still prepared. Inspect it before continuing. No retry was made.`,
        );
      }
      p.finish(
        result(
          true,
          JSON.stringify({
            path: p.review.path,
            accepted,
            rejected: p.proposal.hunks.filter(h => !accepted.includes(h.id)).map(h => h.id),
            editorText: after,
            checkpointId: record.id,
            saved: !p.document.isDirty,
            message:
              'Only selected replacements were applied to the VS Code buffer. The user or configured editor autosave controls disk saving. Read the returned editorText rather than assuming disk is current.',
          }),
        ),
      );
      return p.document.isDirty ? 'buffer' : 'saved';
    } finally {
      this.applying = false;
    }
  }
  async restore(id: string) {
    this.guard();
    if (this.pending || this.preparing || this.applying)
      throw new Error('Finish the active edit review before restoring a checkpoint.');
    this.applying = true;
    try {
      const record = await this.journal.read(id),
        disk = await readWorkspaceText(this.root, record.path);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(disk.full));
      assertRestoreText(record, document.getText(), disk.text);
      const version = document.version,
        editor = await vscode.window.showTextDocument(document, { preview: false });
      const latest = await readWorkspaceText(this.root, record.path);
      assertRestoreText(record, document.getText(), latest.text);
      this.guard();
      if (latest.identity !== disk.identity || document.version !== version)
        throw new Error('Restore conflict: file identity or editor version changed.');
      const applied = await editor.edit(
        builder => {
          this.guard();
          if (document.version !== version || contentHash(document.getText()) !== contentHash(record.after))
            throw new Error('Restore conflict: editor changed.');
          builder.setEndOfLine(record.before.includes('\r\n') ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF);
          builder.replace(
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
            record.before,
          );
        },
        { undoStopBefore: true, undoStopAfter: true },
      );
      if (!applied) throw new Error('VS Code refused the restore because the document changed. No retry was made.');
      if (document.getText() !== record.before)
        throw new Error(
          'Restored text differs from the checkpoint. The recovery receipt was not marked complete; inspect the editor before continuing.',
        );
      await this.journal.mark(record, 'restored');
    } finally {
      this.applying = false;
    }
  }
  dispose() {
    this.pending?.finish(result(false, 'Editor client closed. No further edit is authorized.'));
    this.provider.dispose();
    this.changes.dispose();
    this.snapshots.clear();
  }
}
