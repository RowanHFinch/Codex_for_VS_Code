import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryBrowser } from '../src/memories';

test('memory browsing lists metadata only, reads on demand, clears content and refuses forged IDs', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ic-memory-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'memories'));
  await mkdir(join(home, 'memories_v2'));
  await writeFile(join(home, 'memories', 'MEMORY.md'), 'synthetic-only');
  await writeFile(join(home, 'memories_v2', 'memory_summary.md'), 'second');
  await writeFile(join(home, 'auth.json'), 'never-read');
  const browser = new MemoryBrowser(
    home,
    () => {},
    () => {},
  );
  await browser.list();
  assert.equal(browser.state.files.length, 2);
  assert.equal(JSON.stringify(browser.state).includes('synthetic-only'), false);
  assert.equal(browser.state.selected, undefined);
  const file = browser.state.files.find(f => f.path === 'memories/MEMORY.md')!;
  await browser.read(file.id);
  assert.equal((browser.state.selected as { text: string } | undefined)?.text, 'synthetic-only');
  await assert.rejects(browser.read('../auth.json'), /expired/);
  browser.closePreview();
  assert.equal(browser.state.files.length, 2);
  assert.equal(browser.state.selected, undefined);
  browser.clear();
  assert.equal(browser.state.selected, undefined);
  await assert.rejects(browser.read(file.id), /expired/);
});
test('memory files replaced by links or invalid/large text never expose outside content', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ic-memory-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, 'memories'),
    file = join(directory, 'entry.md'),
    privateFile = join(home, 'secret');
  await mkdir(directory);
  await writeFile(file, 'public');
  await writeFile(privateFile, 'synthetic secret');
  const browser = new MemoryBrowser(
    home,
    () => {},
    () => {},
  );
  await browser.list();
  const id = browser.state.files[0].id;
  await rm(file);
  await symlink(privateFile, file);
  await assert.rejects(browser.read(id), /links|changed/);
  await browser.list();
  assert.equal(browser.state.files.length, 0);
  await rm(file);
  await link(privateFile, file);
  await browser.list();
  assert.equal(browser.state.files.length, 0);
  await rm(file);
  await writeFile(file, Buffer.from([0xff, 0]));
  await browser.list();
  await assert.rejects(browser.read(browser.state.files[0].id), /UTF-8/);
  await writeFile(file, 'x'.repeat(400001));
  await assert.rejects(browser.read(browser.state.files[0].id), /UTF-8/);
  await rm(directory, { recursive: true });
  await symlink(home, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await browser.list();
  assert.equal(browser.state.files.length, 0);
});

test('closing a memory browser invalidates its in-flight metadata listing', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ic-memory-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'memories'));
  await writeFile(join(home, 'memories', 'MEMORY.md'), 'synthetic');
  let checks = 0;
  const browser = new MemoryBrowser(
    home,
    () => {
      if (++checks === 2) browser.clear();
    },
    () => {},
  );
  await browser.list();
  assert.deepEqual(browser.state.files, []);
  assert.equal(browser.state.loading, false);
});
