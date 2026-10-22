import { lstat, link, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { workspaceTextPath, attachable } from '../files';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileUpdateChange } from '../protocol/v2/FileUpdateChange';
import { previousContent, proposedContent } from './patch';

export type NativeEditRecord = {
  version: 1;
  id: string;
  root: string;
  threadId: string;
  turnId: string;
  itemId: string;
  path: string;
  before: string | null;
  after: string | null;
  createdAt: string;
  state: 'applied' | 'restored';
};
type Pending = {
  threadId: string;
  turnId: string;
  changes: FileUpdateChange[];
  before: Map<string, string | null>;
  /** Paths whose start-time read was refused (link, binary, too large): never reconstructed later. */
  skipped: Set<string>;
};

const MAX_BYTES = 1024 * 1024;

/**
 * Records what native Codex file changes actually did, so a turn can be undone later.
 * Pre-images are read when the change item starts. An auto-approved update can land before that
 * read; then (start missed, or the read already saw the result) the pre-image is recovered by
 * reverting the diff on the result, so undo puts back only Codex's lines. Recovery is refused for
 * adds and deletes (an earlier file or a link is not in the diff), end-of-file newline changes
 * (not modelled exactly), files refused at start, and files another running item also changes.
 * A record is kept only when its pre-image plus the reported diff reproduces the file on disk
 * after completion; anything else is dropped rather than stored wrong.
 */
export class NativeEdits {
  private pending = new Map<string, Pending>();
  constructor(
    private directory: string,
    private root: string,
  ) {}
  private full(path: string) {
    const full = isAbsolute(path) ? path : resolve(this.root, path),
      rel = relative(this.root, full);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !attachable(rel)) return undefined;
    return { full, rel: rel.split('\\').join('/') };
  }
  private async text(full: string): Promise<string | null | undefined> {
    try {
      await workspaceTextPath(this.root, relative(this.root, full).split('\\').join('/'), true);
      const stat = await lstat(full);
      if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_BYTES) return undefined;
      const bytes = await readFile(full);
      if (bytes.includes(0)) return undefined;
      const text = bytes.toString('utf8');
      return Buffer.from(text).equals(bytes) ? text : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return undefined;
    }
  }
  async started(threadId: string, turnId: string, itemId: string, changes: FileUpdateChange[]) {
    if (this.pending.has(itemId)) return;
    const before = new Map<string, string | null>(),
      skipped = new Set<string>();
    const entry: Pending = { threadId, turnId, changes, before, skipped };
    this.pending.set(itemId, entry);
    for (const change of changes) {
      const target = this.full(change.path);
      if (!target) continue;
      const text = await this.text(target.full);
      if (text !== undefined) before.set(target.rel, text);
      else skipped.add(target.rel);
    }
  }
  /** Returns the records written for a successfully completed change item; `item` covers a missed start. */
  async completed(
    itemId: string,
    status: string,
    item?: { threadId: string; turnId: string; changes: FileUpdateChange[] },
  ) {
    const entry =
      this.pending.get(itemId) ??
      (item && { ...item, before: new Map<string, string | null>(), skipped: new Set<string>() });
    this.pending.delete(itemId);
    if (!entry || status !== 'completed') return [];
    const records: NativeEditRecord[] = [];
    for (const change of entry.changes) {
      if (change.kind.type === 'update' && change.kind.move_path) continue; // ponytail: renames are not undoable yet
      const target = this.full(change.path);
      if (!target) continue;
      const after = await this.text(target.full);
      if (after === undefined) continue;
      const produces = (before: string | null) => {
        try {
          return proposedContent(change, before) === after;
        } catch {
          return false;
        }
      };
      const captured = entry.before.has(target.rel) ? entry.before.get(target.rel)! : undefined;
      let before: string | null | undefined = captured;
      if (before === undefined || !produces(before)) {
        // Only an update whose start-time read missed or already saw the result is reconstructed; a
        // captured pre-image that simply does not reproduce the result means something else changed.
        if (
          change.kind.type !== 'update' ||
          (captured !== undefined && captured !== after) ||
          entry.skipped.has(target.rel) ||
          /^\\/m.test(change.diff) ||
          [...this.pending.values()].some(other => other.changes.some(c => this.full(c.path)?.rel === target.rel))
        )
          continue;
        try {
          before = previousContent(change, after);
        } catch {
          continue;
        }
        if (!produces(before)) continue;
      }
      if (before === undefined) continue;
      const pre = before;
      records.push({
        version: 1,
        id: randomUUID(),
        root: this.root,
        threadId: entry.threadId,
        turnId: entry.turnId,
        itemId,
        path: target.rel,
        before: pre,
        after,
        createdAt: new Date().toISOString(),
        state: 'applied',
      });
    }
    for (const record of records) await this.persist(record);
    return records;
  }
  forget(itemId: string) {
    this.pending.delete(itemId);
  }
  private async persist(record: NativeEditRecord) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${record.id}.json`),
      temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  }
  async list(threadId?: string) {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: NativeEditRecord[] = [];
    for (const name of names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
      try {
        const record: NativeEditRecord = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
        if (record.version === 1 && record.root === this.root && (!threadId || record.threadId === threadId))
          records.push(record);
      } catch {
        /* A damaged record must not hide the others. */
      }
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  /**
   * Restores files changed by the given turns, newest first. Every file must still match
   * what Codex wrote and must not have unsaved editor changes; otherwise nothing is touched.
   */
  async restore(records: NativeEditRecord[], isDirty: (full: string) => boolean) {
    const live = records.filter(r => r.state === 'applied').reverse();
    const latest = new Map<string, NativeEditRecord>();
    for (const record of live) if (!latest.has(record.path)) latest.set(record.path, record);
    const plan: { record: NativeEditRecord; full: string }[] = [];
    const conflicts: string[] = [];
    for (const [path, record] of latest) {
      const target = this.full(path);
      if (!target) {
        conflicts.push(path);
        continue;
      }
      const current = await this.text(target.full);
      if (current !== record.after || isDirty(target.full)) conflicts.push(path);
      else plan.push({ record, full: target.full });
    }
    // Restore to the oldest pre-image per path; each step must start where the previous one ended.
    const oldest = new Map<string, string | null>(),
      next = new Map<string, string | null>();
    for (const record of live) {
      if (next.has(record.path) && next.get(record.path) !== record.after) conflicts.push(record.path);
      next.set(record.path, record.before);
      oldest.set(record.path, record.before);
    }
    if (conflicts.length) throw new RestoreConflict([...new Set(conflicts)]);
    const put = async (full: string, content: string | null, expected: string | null) => {
      const path = relative(this.root, full).split('\\').join('/');
      await workspaceTextPath(this.root, path, true);
      if (isDirty(full) || (await this.text(full)) !== expected)
        throw new Error('File changed during restoration: ' + path);
      if (content === null) {
        await workspaceTextPath(this.root, path, true);
        if (isDirty(full)) throw new Error('Unsaved file changed during restoration: ' + path);
        await rm(full, { force: true });
        return;
      }
      await mkdir(dirname(full), { recursive: true });
      await workspaceTextPath(this.root, path, true);
      const temp = join(dirname(full), `.codex-restore-${randomUUID()}.tmp`);
      const mode = expected === null ? 0o600 : (await lstat(full)).mode & 0o777;
      const file = await open(temp, 'wx', mode);
      try {
        await file.writeFile(content);
        await file.sync();
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      } finally {
        await file.close();
      }
      try {
        await workspaceTextPath(this.root, path, true);
        if ((await this.text(full)) !== expected || isDirty(full))
          throw new Error('File changed during restoration: ' + path);
        // Atomic publication: an interrupted write never truncates the original. Creation cannot overwrite.
        if (expected === null) await link(temp, full);
        else await rename(temp, full);
      } finally {
        await rm(temp, { force: true }).catch(() => {});
      }
    };
    const written: { record: NativeEditRecord; full: string }[] = [];
    // Puts Codex's text back only where the file still holds what this restore wrote; returns paths left alone.
    const putBack = async () => {
      const skipped: string[] = [];
      for (const { record, full } of written.reverse()) {
        const ok =
          !isDirty(full) &&
          (await this.text(full)) === oldest.get(record.path) &&
          (await put(full, record.after, oldest.get(record.path)!).then(
            () => true,
            () => false,
          ));
        if (!ok) skipped.push(record.path);
      }
      return skipped;
    };
    try {
      for (const entry of plan) {
        await put(entry.full, oldest.get(entry.record.path)!, entry.record.after);
        written.push(entry);
      }
      for (const record of live) await this.persist({ ...record, state: 'restored' });
    } catch (error) {
      const skipped = await putBack();
      for (const record of live)
        if (!skipped.includes(record.path)) await this.persist(record).catch(() => skipped.push(record.path));
      if (skipped.length)
        throw new Error(`Restore failed and these files are left partly restored: ${skipped.join(', ')}. ${error}`);
      throw error;
    }
    const restored = [...written];
    return {
      paths: plan.map(p => p.record.path),
      /** Re-applies what Codex wrote, e.g. when the matching history revert failed. */
      rollback: async () => {
        written.splice(0, written.length, ...restored);
        const skipped = await putBack();
        for (const record of live)
          if (!skipped.includes(record.path)) await this.persist(record).catch(() => skipped.push(record.path));
        if (skipped.length)
          throw new Error(`Files changed during the rewind were left as they are: ${skipped.join(', ')}.`);
      },
    };
  }
}

export class RestoreConflict extends Error {
  constructor(readonly paths: string[]) {
    super(`Files changed after Codex edited them: ${paths.join(', ')}. Nothing was restored.`);
  }
}
