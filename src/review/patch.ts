import { isAbsolute, relative, resolve } from 'node:path';
import type { FileUpdateChange } from '../protocol/v2/FileUpdateChange';

export type ChangeSummary = { path: string; kind: 'add' | 'delete' | 'update'; movePath?: string; added: number; removed: number };

// Codex sends update hunks with headers; add/delete carry the whole new/old file as `diff`.
// `reverse` undoes the hunks: it reads the new side from `original` and writes the old side.
export function applyHunks(original: string, diff: string, reverse = false) {
  const source = original.split('\n');
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out: string[] = [];
  // Forward: '-' lines are read from `original`, '+' lines written; reverse swaps them.
  const [consumed, emitted] = reverse ? ['+', '-'] : ['-', '+'];
  let cursor = 0,
    i = 0;
  while (i < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
    if (!header) throw new Error('Malformed patch hunk.');
    const [first, count] = reverse ? [header[3], header[4]] : [header[1], header[2]];
    const start = Number(first) - (count === '0' ? 0 : 1);
    if (start < cursor || start > source.length) throw new Error('Patch hunks are out of order.');
    out.push(...source.slice(cursor, start));
    cursor = start;
    for (i++; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const line = lines[i];
      // ponytail: "\ No newline at end of file" is ignored; end-of-file newline flips can preview off by one newline.
      if (line.startsWith('\\')) continue;
      const mark = line[0] ?? ' ',
        body = line.slice(1);
      if (mark === emitted) out.push(body);
      else if (mark === ' ' || mark === consumed) {
        if (source[cursor] !== body) throw new Error('Patch does not match the current file.');
        cursor++;
        if (mark === ' ') out.push(body);
      } else throw new Error('Malformed patch line.');
    }
  }
  out.push(...source.slice(cursor));
  return out.join('\n');
}

/** Content the change produces from `current`; null means the file is deleted. */
export function proposedContent(change: FileUpdateChange, current: string | null) {
  if (change.kind.type === 'add') return change.diff;
  if (change.kind.type === 'delete') return null;
  if (current === null) throw new Error('The file to update no longer exists.');
  return applyHunks(current, change.diff);
}

/** Content before the change, recovered from what it produced; the inverse of `proposedContent`. */
export function previousContent(change: FileUpdateChange, after: string | null) {
  if (change.kind.type === 'add') return null;
  if (change.kind.type === 'delete') return change.diff;
  if (after === null) throw new Error('The updated file no longer exists.');
  return applyHunks(after, change.diff, true);
}

export function summarize(root: string, change: FileUpdateChange): ChangeSummary {
  let added = 0,
    removed = 0;
  const body = change.diff.split('\n');
  if (body.at(-1) === '') body.pop();
  if (change.kind.type === 'add') added = body.length;
  else if (change.kind.type === 'delete') removed = body.length;
  else
    for (const line of body) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  const movePath = change.kind.type === 'update' && change.kind.move_path ? workspacePath(root, change.kind.move_path) : undefined;
  return { path: workspacePath(root, change.path), kind: change.kind.type, ...(movePath ? { movePath } : {}), added, removed };
}

/** Workspace-relative POSIX path, or the absolute path when it lies outside the workspace. */
export function workspacePath(root: string, path: string) {
  const full = isAbsolute(path) ? path : resolve(root, path),
    rel = relative(root, full);
  return !rel || rel.startsWith('..') || isAbsolute(rel) ? full : rel.split('\\').join('/');
}

/** Per-file +/- counts from a turn-level `diff --git` patch. */
export function turnDiffFiles(diff: string) {
  const files: { path: string; added: number; removed: number }[] = [];
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) files.push({ path: header[2], added: 0, removed: 0 });
    else if (files.length && line.startsWith('+') && !line.startsWith('+++')) files.at(-1)!.added++;
    else if (files.length && line.startsWith('-') && !line.startsWith('---')) files.at(-1)!.removed++;
  }
  return files;
}
