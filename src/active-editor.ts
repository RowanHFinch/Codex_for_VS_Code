import * as vscode from 'vscode';
import { relative } from 'node:path';
import { editorContext } from './context';
import type { ActiveEditor, ContextEntry } from './shared';

// Keep the last visible text editor when focus moves into the chat webview.
export class ActiveEditorContext implements vscode.Disposable {
  private editor?: vscode.TextEditor;
  private entry?: ContextEntry;
  private key = '';
  private revision = 0;
  private dismissedFiles = new Set<string>();
  private subscriptions: vscode.Disposable[];
  pending = false;
  unavailable = false;
  constructor(
    private root: string,
    private changed: () => void,
  ) {
    this.subscriptions = [
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) this.editor = editor;
        else if (this.editor && !vscode.window.visibleTextEditors.includes(this.editor)) this.editor = undefined;
        this.refresh();
      }),
      vscode.window.onDidChangeVisibleTextEditors(editors => {
        if (this.editor && !editors.includes(this.editor)) {
          this.editor = vscode.window.activeTextEditor;
          this.refresh();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection(event => {
        if (event.textEditor === this.editor || event.textEditor === vscode.window.activeTextEditor) {
          this.editor = event.textEditor;
          this.refresh();
        }
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === this.editor?.document) this.refresh();
      }),
    ];
    this.editor = vscode.window.activeTextEditor;
    this.refresh();
  }
  private signature() {
    const editor = this.editor;
    if (!editor || editor.document.isClosed) return '';
    return JSON.stringify([
      editor.document.uri.toString(),
      editor.document.version,
      editor.selections
        .filter(s => !s.isEmpty)
        .map(s => [s.start.line, s.start.character, s.end.line, s.end.character]),
    ]);
  }
  private refresh() {
    const key = this.signature();
    if (key === this.key) return;
    this.key = key;
    const revision = ++this.revision;
    this.dismissedFiles.clear();
    this.unavailable = false;
    const editor = this.editor;
    // Keep the same file's chip stable while selecting; capture still rejects pending context.
    if (!editor || this.entry?.uri !== editor.document.uri.toString()) this.entry = undefined;
    this.pending = Boolean(key && editor);
    this.changed();
    if (!key || !editor) return;
    const selections = editor.selections.filter(s => !s.isEmpty);
    if (selections.length > 1) {
      this.entry = undefined;
      this.pending = false;
      this.unavailable = true;
      this.changed();
      return;
    }
    void editorContext(this.root, editor.document, selections[0])
      .then(
        entry => {
          if (revision !== this.revision) return;
          if (key !== this.signature()) {
            this.refresh();
            return;
          }
          if (!this.dismissedFiles.has(entry.path ?? entry.uri)) this.entry = entry;
        },
        () => {
          if (revision === this.revision) {
            this.entry = undefined;
            this.unavailable = true;
          }
        },
      )
      .finally(() => {
        if (revision === this.revision) {
          this.pending = false;
          this.changed();
        }
      });
  }
  private included(pinned: ContextEntry[]) {
    const config = vscode.workspace.getConfiguration('independentCodex');
    if (this.entry && !config.get(this.entry.kind === 'selection' ? 'attachSelection' : 'attachOpenFile', true))
      return undefined;
    return this.entry &&
      !this.dismissedFiles.has(this.entry.path ?? this.entry.uri) &&
      !pinned.some(c => c.uri === this.entry!.uri || (this.entry!.path && c.path === this.entry!.path))
      ? this.entry
      : undefined;
  }
  preview(pinned: ContextEntry[]): ActiveEditor | undefined {
    const entry = this.included(pinned);
    return entry
      ? {
          id: entry.id,
          label: entry.label,
          path: entry.path ?? relative(this.root, vscode.Uri.parse(entry.uri).fsPath).split('\\').join('/'),
          startLine: entry.startLine,
          endLine: entry.endLine,
          selected: entry.kind === 'selection',
        }
      : undefined;
  }
  capture(expectedId: string | null, pinned: ContextEntry[]) {
    if (this.key !== this.signature()) {
      this.refresh();
      throw new Error('Editor context changed. Review the current file/selection before sending.');
    }
    if (this.pending) throw new Error('Wait for editor context to finish updating.');
    const entry = this.included(pinned);
    if ((entry?.id ?? null) !== expectedId)
      throw new Error('Editor context changed. Review the current file/selection before sending.');
    return entry;
  }
  dismiss(id: string) {
    if (this.entry?.id !== id) return false;
    this.dismissFile(this.entry.uri, this.entry.path);
    return true;
  }
  dismissFile(uri: string, path?: string) {
    this.dismissedFiles.add(path ?? uri);
    if (this.editor?.document.uri.toString() === uri || (path && this.entry?.path === path)) {
      ++this.revision;
      this.entry = undefined;
      this.pending = false;
      this.unavailable = false;
      this.key = this.signature();
    }
    this.changed();
  }
  dispose() {
    ++this.revision;
    this.subscriptions.forEach(s => s.dispose());
  }
}
