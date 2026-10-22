import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type PastedImage = { id: string; name: string; path: string };
const limit = 5;

/**
 * Images pasted into each chat's draft ('' is a tab with no chat yet). Like Claudian, they are
 * written to temp files and sent as `localImage` paths: the runtime echoes user input back, and
 * inline data URLs would push those frames past the client's 16 MiB limit.
 */
export class PastedImages {
  private byChat = new Map<string, PastedImage[]>();
  private dir?: Promise<string>;
  list(threadId?: string | null) {
    return this.byChat.get(threadId ?? '') ?? [];
  }
  async add(threadId: string | null, id: string, name: string, dataUrl: string) {
    if (this.list(threadId).length >= limit) throw new Error(`Attach up to ${limit} images per message.`);
    const parsed = /^data:image\/(png|jpeg|gif|webp);base64,(.*)$/.exec(dataUrl);
    if (!parsed) throw new Error('Only PNG, JPEG, GIF and WebP images are supported.');
    const [, extension, data] = parsed;
    const dir = (this.dir ??= mkdtemp(join(tmpdir(), 'codex-vscode-images-')));
    const path = join(
      await dir.catch(error => {
        if (this.dir === dir) this.dir = undefined;
        throw error;
      }),
      `${id}.${extension}`,
    );
    await writeFile(path, Buffer.from(data, 'base64'), { mode: 0o600 }).catch(async error => {
      await unlink(path).catch(() => {});
      throw error;
    });
    const images = this.list(threadId);
    if (images.length >= limit) {
      await unlink(path).catch(() => {});
      throw new Error(`Attach up to ${limit} images per message.`);
    }
    this.byChat.set(threadId ?? '', [...images, { id, name, path }]);
  }
  /** Leaves the file in place: a send already in flight may still hand its path to the runtime. */
  remove(threadId: string | null, id: string) {
    this.set(
      threadId,
      this.list(threadId).filter(image => image.id !== id),
    );
  }
  /** A chat created in an empty tab takes over the images pasted before it existed. */
  adopt(threadId: string | undefined) {
    const draft = this.byChat.get('');
    if (!threadId || !draft) return;
    this.byChat.delete('');
    this.set(threadId, [...this.list(threadId), ...draft]);
  }
  /**
   * Forgets delivered images. Files stay until the tab closes: the runtime can read a `localImage`
   * after `turn/start` returns (for example after a userPromptSubmit hook runs), so deleting at send
   * time left the model with a missing path.
   */
  sent(threadId: string, images: PastedImage[]) {
    this.set(
      threadId,
      this.list(threadId).filter(image => !images.includes(image)),
    );
  }
  async dispose() {
    const dir = this.dir;
    this.dir = undefined;
    this.byChat.clear();
    if (dir)
      await dir.then(
        path => rm(path, { recursive: true, force: true }),
        () => {},
      );
  }
  private set(threadId: string | null, images: PastedImage[]) {
    if (images.length) this.byChat.set(threadId ?? '', images);
    else this.byChat.delete(threadId ?? '');
  }
}
