import * as vscode from 'vscode';
import { realpath, lstat } from 'node:fs/promises';
import { relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ContextEntry } from './shared';

import { within, attachable } from './files';
export { within, attachable } from './files';
export async function editorContext(
  root: string,
  document: vscode.TextDocument,
  selection?: vscode.Range,
): Promise<ContextEntry> {
  if (document.uri.scheme !== 'file') throw new Error('Context must be a real file inside this workspace.');
  const canonical = await realpath(document.uri.fsPath);
  if (!within(root, canonical)) throw new Error('Context must be a real file inside this workspace.');
  if (!attachable(document.uri.fsPath) || !attachable(canonical))
    throw new Error('Credential-like files cannot be attached.');
  if ((await lstat(canonical)).nlink > 1) throw new Error('Hard-linked attachments are unsupported.');
  // Whole files are sent as path references (Codex reads them itself); only selections carry text.
  const selected = selection && !selection.isEmpty;
  const text = selected ? document.getText(selection) : '';
  if (text.length > 60_000 || text.includes('\0')) throw new Error('Attach a text selection under 60,000 characters.');
  const startLine = selection ? selection.start.line + 1 : 1;
  const endLine = selection
    ? selection.end.line + (selection.end.character === 0 && selection.end.line > selection.start.line ? 0 : 1)
    : document.lineCount;
  const path = relative(root, canonical).split('\\').join('/');
  return {
    id: randomUUID(),
    label: `${path}:${startLine}-${endLine}`,
    text,
    uri: document.uri.toString(),
    version: document.version,
    startLine,
    endLine,
    kind: selection && !selection.isEmpty ? 'selection' : 'file',
    path,
  };
}

export async function validateEditorState(root: string, entries: ContextEntry[]) {
  if (!vscode.workspace.isTrusted) throw new Error('Workspace trust was revoked.');
  const folders = vscode.workspace.workspaceFolders;
  // A window without folders runs projectless chats in their own generated folder.
  let present = !folders?.length;
  for (const folder of folders ?? [])
    if (folder.uri.scheme === 'file' && (await realpath(folder.uri.fsPath).catch(() => '')) === root) present = true;
  if (!present) throw new Error('Workspace folder changed. Reopen this chat in the intended folder.');
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme !== 'file' || !document.isDirty) continue;
    let inside = within(root, document.uri.fsPath);
    if (!inside) {
      try {
        inside = within(root, await realpath(document.uri.fsPath));
      } catch {
        /* Missing external files are not workspace context. */
      }
    }
    if (inside)
      throw new Error('Save or discard unsaved workspace files before sending. No files were saved automatically.');
  }
  for (const entry of entries.filter(e => e.kind === 'selection')) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
    if (document.isDirty)
      throw new Error('Save or discard unsaved workspace files before sending. No files were saved automatically.');
    if (document.version !== entry.version || !within(root, await realpath(document.uri.fsPath)))
      throw new Error('Editor context changed. Remove and attach it again.');
  }
}
