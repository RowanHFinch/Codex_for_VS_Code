import * as vscode from 'vscode';
import { realpath, lstat } from 'node:fs/promises';
import { relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { attachable, within, readWorkspaceText } from './files';
import type { FileChoice } from './shared';

// One catalog per webview: the renderer chooses opaque IDs, never filesystem paths.
export class WorkspaceFiles {
  private revision = 0;
  private choices = new Map<string, string>();
  private listing?: { at: number; files: Thenable<vscode.Uri[]> };
  constructor(private root: string) {}
  async search(query: string) {
    const revision = ++this.revision;
    this.choices.clear();
    // ponytail: one cached listing per view for 15 s; typing no longer rescans the workspace per keystroke.
    if (!this.listing || Date.now() - this.listing.at > 15_000)
      this.listing = {
        at: Date.now(),
        files: vscode.workspace.findFiles(
          new vscode.RelativePattern(this.root, '**/*'),
          '**/{node_modules,.git,dist,out,build,.next}/**',
          5001,
        ),
      };
    const found = await this.listing.files;
    // shortcut: scan at most 5,000 workspace paths; expose the cap until an indexed search is needed.
    const ranked = found
      .slice(0, 5000)
      .filter(uri => attachable(uri.fsPath))
      .map(uri => {
        const path = relative(this.root, uri.fsPath).split('\\').join('/'),
          needle = query.toLowerCase(),
          value = path.toLowerCase();
        let cursor = 0;
        for (const character of value) if (character === needle[cursor]) cursor++;
        const name = value.split('/').at(-1)!;
        return {
          uri,
          path,
          score: name.startsWith(needle) ? 0 : value.includes(needle) ? 1 : cursor === needle.length ? 2 : 3,
        };
      })
      .filter(row => row.score < 3)
      .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
    const files: FileChoice[] = [],
      choices = new Map<string, string>(),
      seen = new Set<string>();
    for (const row of ranked) {
      if (revision !== this.revision) return;
      try {
        const canonical = await realpath(row.uri.fsPath),
          stat = await lstat(canonical);
        if (
          !within(this.root, canonical) ||
          !attachable(canonical) ||
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > 240_000
        )
          continue;
        const path = relative(this.root, canonical).split('\\').join('/');
        if (path.length > 512 || seen.has(path)) continue;
        seen.add(path);
        const id = randomUUID();
        choices.set(id, path);
        files.push({ id, path });
        if (files.length === 20) break;
      } catch {
        /* Deleted or inaccessible files are not attachment candidates. */
      }
    }
    if (revision !== this.revision) return;
    this.choices = choices;
    return { files, limited: found.length > 5000 || files.length === 20 };
  }
  async resolve(id: string) {
    const path = this.choices.get(id);
    if (!path) throw new Error('File search changed. Choose the file again.');
    const { full } = await readWorkspaceText(this.root, path);
    return vscode.Uri.file(full);
  }
  dispose() {
    this.revision++;
    this.choices.clear();
  }
}
