import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { readWorkspaceText } from './files';
import type { MemoryState } from './shared';

export class MemoryBrowser {
  state: MemoryState = { files: [], loading: false, limited: false };
  private revision = 0;
  private files = new Map<string, { root: string; path: string }>();
  constructor(
    private home: string,
    private guard: () => void,
    private changed: () => void,
  ) {}
  clear() {
    this.revision++;
    this.files.clear();
    this.state = { files: [], loading: false, limited: false };
    this.changed();
  }
  closePreview() {
    this.revision++;
    this.state.selected = undefined;
    this.state.loading = false;
    this.changed();
  }
  async list() {
    this.guard();
    const revision = ++this.revision;
    this.state.loading = true;
    this.state.selected = undefined;
    this.changed();
    const files = new Map<string, { root: string; path: string }>(),
      entries: MemoryState['files'] = [];
    let directories = 0,
      inspected = 0,
      limited = false;
    try {
      if ((await realpath(this.home)) !== this.home) throw new Error('Codex home changed. Reconnect first.');
      const walk = async (root: string, path: string, depth: number): Promise<void> => {
        if (++directories > 100 || depth > 6) {
          limited = true;
          return;
        }
        const full = join(root, path),
          stat = await lstat(full);
        if (stat.isSymbolicLink() || !stat.isDirectory() || (await realpath(full)) !== full) return;
        for await (const entry of await opendir(full)) {
          this.guard();
          if (revision !== this.revision) return;
          if (++inspected > 2000 || entries.length >= 500) {
            limited = true;
            break;
          }
          if (entry.name.startsWith('.')) continue;
          const relative = path ? `${path}/${entry.name}` : entry.name;
          if (relative.length > 512) {
            limited = true;
            continue;
          }
          if (entry.isDirectory()) await walk(root, relative, depth + 1);
          else if (entry.isFile() && entry.name.endsWith('.md')) {
            const info = await lstat(join(root, relative));
            if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) continue;
            const id = createHash('sha256')
              .update(root + '\0' + relative)
              .digest('hex');
            files.set(id, { root, path: relative });
            entries.push({
              id,
              path: `${root === join(this.home, 'memories') ? 'memories' : 'memories_v2'}/${relative}`,
              bytes: info.size,
              updatedAt: info.mtimeMs,
            });
          }
        }
      };
      for (const name of ['memories', 'memories_v2']) {
        try {
          await walk(join(this.home, name), '', 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      this.guard();
      if (revision !== this.revision) return;
      this.files = files;
      this.state.files = entries.sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
      this.state.limited = limited;
    } finally {
      if (revision === this.revision) {
        this.state.loading = false;
        this.changed();
      }
    }
  }
  async read(id: string) {
    this.guard();
    const revision = this.revision,
      entry = this.files.get(id),
      listed = this.state.files.find(f => f.id === id);
    if (!entry || !listed || this.state.loading) throw new Error('Memory entry expired. Refresh and choose it again.');
    if ((await realpath(this.home)) !== this.home) throw new Error('Codex home changed. Reconnect first.');
    const { text } = await readWorkspaceText(entry.root, entry.path);
    this.guard();
    if (revision !== this.revision || this.files.get(id) !== entry)
      throw new Error('Memory inventory changed. Choose it again.');
    this.state.selected = { id, path: listed.path, text };
    this.changed();
  }
}
