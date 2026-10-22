import { mkdir, open, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { contentHash } from './proposals';

export type EditRecord = {
  version: 2;
  id: string;
  root: string;
  path: string;
  threadId: string;
  turnId: string;
  callId: string;
  createdAt: string;
  before: string;
  after: string;
  state: 'prepared' | 'applied' | 'restored';
};
export class EditJournal {
  constructor(
    private directory: string,
    private root: string,
  ) {}
  private async persist(record: EditRecord, first: boolean) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${record.id}.json`),
      temp = first ? path : `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    if (!first) await rename(temp, path);
    // shortcut: Node cannot fsync directories on Windows; native directory flushing needs a platform helper.
    if (process.platform !== 'win32') {
      const directory = await open(this.directory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }
  async prepare(data: Pick<EditRecord, 'path' | 'threadId' | 'turnId' | 'callId' | 'before' | 'after'>) {
    const record: EditRecord = {
      ...data,
      version: 2,
      root: this.root,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      state: 'prepared',
    };
    await this.persist(record, true);
    return record;
  }
  async mark(record: EditRecord, state: EditRecord['state']) {
    await this.persist({ ...record, state }, false);
  }
  async read(id: string): Promise<EditRecord> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid checkpoint identity.');
    const file = await open(join(this.directory, `${id}.json`), 'r');
    let record: EditRecord;
    try {
      if ((await file.stat()).size > 2_000_000) throw new Error('Checkpoint too large.');
      record = JSON.parse(await file.readFile('utf8'));
    } finally {
      await file.close();
    }
    if (
      !record ||
      record.version !== 2 ||
      record.id !== id ||
      record.root !== this.root ||
      typeof record.path !== 'string' ||
      typeof record.createdAt !== 'string' ||
      typeof record.threadId !== 'string' ||
      typeof record.turnId !== 'string' ||
      typeof record.callId !== 'string' ||
      typeof record.before !== 'string' ||
      typeof record.after !== 'string' ||
      record.before.length > 100_000 ||
      record.after.length > 100_000 ||
      [record.before, record.after].some(text => text.includes('\0') || Buffer.from(text).toString('utf8') !== text) ||
      !['prepared', 'applied', 'restored'].includes(record.state)
    )
      throw new Error('Invalid checkpoint record.');
    return record;
  }
  async list() {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: EditRecord[] = [];
    for (const name of files.filter(f => /^[a-f0-9-]{36}\.json$/.test(f))) {
      try {
        records.push(await this.read(name.slice(0, -5)));
      } catch {
        /* A damaged record must not hide other recovery records. */
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export function assertRestoreText(record: EditRecord, current: string, disk: string) {
  if (
    record.state === 'restored' ||
    contentHash(current) !== contentHash(record.after) ||
    (disk !== record.before && disk !== record.after)
  )
    throw new Error('Restore conflict: current editor or disk text changed. No content was replaced.');
}
