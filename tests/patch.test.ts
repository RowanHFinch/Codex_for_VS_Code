import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHunks, previousContent, proposedContent, summarize, turnDiffFiles } from '../src/review/patch';
import { NativeEdits, RestoreConflict } from '../src/review/native-edits';

// Hunk shapes below are copied from codex 0.152.0 fileChange items observed with a synthetic model.
const update = '@@ -1,3 +1,3 @@\n l1\n-l2\n+L2\n l3\n@@ -8,3 +8,4 @@\n l8\n-l9\n+L9a\n+L9b\n l10\n';
const ten = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n';

test('multi-hunk updates apply exactly and refuse a file that drifted', () => {
  assert.equal(applyHunks(ten, update), 'l1\nL2\nl3\nl4\nl5\nl6\nl7\nl8\nL9a\nL9b\nl10\n');
  assert.equal(applyHunks('alpha\n', '@@ -1 +1 @@\n-alpha\n+beta\n'), 'beta\n');
  assert.throws(() => applyHunks(ten.replace('l9', 'x9'), update), /does not match/);
});

test('reversed hunks recover the exact pre-image, including pure insertions and deletions', () => {
  const after = applyHunks(ten, update);
  assert.equal(applyHunks(after, update, true), ten);
  assert.throws(() => applyHunks(after.replace('L9a', 'x'), update, true), /does not match/);
  const insert = '@@ -0,0 +1,2 @@\n+x\n+y\n',
    remove = '@@ -2,2 +1,0 @@\n-b\n-c\n';
  assert.equal(applyHunks(applyHunks('a\n', insert), insert, true), 'a\n');
  assert.equal(applyHunks(applyHunks('a\nb\nc\nd\n', remove), remove, true), 'a\nb\nc\nd\n');
  const upd = { path: 'a.txt', kind: { type: 'update' as const, move_path: null }, diff: update };
  assert.equal(previousContent(upd, after), ten);
  assert.equal(previousContent({ path: 'n', kind: { type: 'add' as const }, diff: 'x\n' }, 'x\n'), null);
  assert.equal(previousContent({ path: 'g', kind: { type: 'delete' as const }, diff: 'bye\n' }, null), 'bye\n');
});

test('add and delete changes carry whole files; summaries count lines and relativize paths', () => {
  const root = '/ws';
  const add = { path: '/ws/sub/new.txt', kind: { type: 'add' as const }, diff: 'hello\nworld\n' };
  const del = { path: '/ws/gone.txt', kind: { type: 'delete' as const }, diff: 'bye\n' };
  const upd = { path: '/ws/a.txt', kind: { type: 'update' as const, move_path: null }, diff: update };
  assert.equal(proposedContent(add, null), 'hello\nworld\n');
  assert.equal(proposedContent(del, 'bye\n'), null);
  assert.deepEqual(summarize(root, add), { path: 'sub/new.txt', kind: 'add', added: 2, removed: 0 });
  assert.deepEqual(summarize(root, del), { path: 'gone.txt', kind: 'delete', added: 0, removed: 1 });
  assert.deepEqual(summarize(root, upd), { path: 'a.txt', kind: 'update', added: 3, removed: 2 });
  assert.equal(summarize(root, { ...add, path: '/elsewhere/x' }).path, '/elsewhere/x');
});

test('turn diffs list each file with its line counts', () => {
  const diff =
    'diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-alpha\n+beta\n' +
    'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n';
  assert.deepEqual(turnDiffFiles(diff), [
    { path: 'a.txt', added: 1, removed: 1 },
    { path: 'n.txt', added: 2, removed: 0 },
  ]);
});

test('native edits are recorded only when the pre-image reproduces the result, and undo checks for drift', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ic-edits-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = join(root, '.store'),
    edits = new NativeEdits(store, root);
  await writeFile(join(root, 'a.txt'), 'alpha\n');
  const changes = [
    {
      path: join(root, 'a.txt'),
      kind: { type: 'update' as const, move_path: null },
      diff: '@@ -1 +1 @@\n-alpha\n+beta\n',
    },
    { path: join(root, 'new.txt'), kind: { type: 'add' as const }, diff: 'fresh\n' },
  ];
  await edits.started('thread', 'turn-1', 'item-1', changes);
  await writeFile(join(root, 'a.txt'), 'beta\n');
  await writeFile(join(root, 'new.txt'), 'fresh\n');
  const records = await edits.completed('item-1', 'completed');
  assert.deepEqual(
    records.map(r => [r.path, r.before, r.after]),
    [
      ['a.txt', 'alpha\n', 'beta\n'],
      ['new.txt', null, 'fresh\n'],
    ],
  );

  // A declined change records nothing.
  await edits.started('thread', 'turn-2', 'item-2', changes);
  assert.deepEqual(await edits.completed('item-2', 'declined'), []);

  // Manual edits after Codex block the undo and leave files untouched.
  await writeFile(join(root, 'a.txt'), 'beta\nmine\n');
  await assert.rejects(
    edits.restore(await edits.list('thread'), () => false),
    RestoreConflict,
  );
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'beta\nmine\n');

  await writeFile(join(root, 'a.txt'), 'beta\n');
  await assert.rejects(
    edits.restore(await edits.list('thread'), full => full.endsWith('a.txt')),
    RestoreConflict,
  );
  const restored = await edits.restore(await edits.list('thread'), () => false);
  assert.deepEqual(restored.paths, ['new.txt', 'a.txt']);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'alpha\n');
  await assert.rejects(readFile(join(root, 'new.txt')), { code: 'ENOENT' });
  assert.ok((await edits.list('thread')).every(r => r.state === 'restored'));
  // A failed history revert puts Codex's text back and makes the records undoable again.
  await restored.rollback();
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'beta\n');
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'fresh\n');
  assert.ok((await edits.list('thread')).every(r => r.state === 'applied'));
});

test('a patch applied before its pre-image was read is recorded from the diff; drift or an add is not', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ic-race-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'd'));
  const edits = new NativeEdits(join(root, '.store'), root);
  await writeFile(join(root, 'd/a.txt'), 'beta\n'); // already applied before "started" was observed
  const change = {
    path: join(root, 'd/a.txt'),
    kind: { type: 'update' as const, move_path: null },
    diff: '@@ -1 +1 @@\n-alpha\n+beta\n',
  };
  await edits.started('thread', 'turn', 'item', [change]);
  assert.deepEqual(
    (await edits.completed('item', 'completed')).map(r => [r.path, r.before, r.after]),
    [['d/a.txt', 'alpha\n', 'beta\n']],
  );
  await edits.restore(await edits.list('thread'), () => false);
  assert.equal(await readFile(join(root, 'd/a.txt'), 'utf8'), 'alpha\n');

  // A missed start is covered by the completed item. A recovered pre-image reverts only Codex's lines, so an
  // edit elsewhere in the file survives undo; a file whose changed lines drifted is not recorded.
  await writeFile(join(root, 'd/a.txt'), 'beta\nlater\n');
  const kept = await edits.completed('missed', 'completed', { threadId: 't', turnId: 'u', changes: [change] });
  assert.deepEqual(
    kept.map(r => r.before),
    ['alpha\nlater\n'],
  );
  await writeFile(join(root, 'd/a.txt'), 'gamma\nlater\n');
  assert.deepEqual(await edits.completed('drift', 'completed', { threadId: 't', turnId: 'u', changes: [change] }), []);

  // An added file without a captured pre-image could have replaced an existing one: never guess "absent".
  await writeFile(join(root, 'd/new.txt'), 'made\n');
  const add = { path: join(root, 'd/new.txt'), kind: { type: 'add' as const }, diff: 'made\n' };
  assert.deepEqual(await edits.completed('added', 'completed', { threadId: 't', turnId: 'u', changes: [add] }), []);
});

test('pre-image recovery refuses newline flips, deletes, links and files another running item changes', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ic-refuse-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const edits = new NativeEdits(join(root, '.store'), root);
  const update = (name: string, diff: string) => ({
    path: join(root, name),
    kind: { type: 'update' as const, move_path: null },
    diff,
  });
  // A captured pre-image that does not reproduce the result (here an end-of-file newline change) is dropped.
  await writeFile(join(root, 'nl.txt'), 'a\nb');
  const flip = update('nl.txt', '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n');
  await edits.started('t', 'u', 'nl', [flip]);
  await writeFile(join(root, 'nl.txt'), 'a\nc\n');
  assert.deepEqual(await edits.completed('nl', 'completed'), []);
  // Missed start: a newline marker still blocks recovery.
  assert.deepEqual(await edits.completed('nl2', 'completed', { threadId: 't', turnId: 'u', changes: [flip] }), []);

  // A delete is never reconstructed from its diff: the old file may have been a link or not text.
  const del = { path: join(root, 'gone.txt'), kind: { type: 'delete' as const }, diff: 'old\n' };
  assert.deepEqual(await edits.completed('del', 'completed', { threadId: 't', turnId: 'u', changes: [del] }), []);

  // A file refused at start (a link here) is not reconstructed later.
  await writeFile(join(root, 'target.txt'), 'beta\n');
  await symlink(join(root, 'target.txt'), join(root, 'link.txt'));
  const linked = update('link.txt', '@@ -1 +1 @@\n-alpha\n+beta\n');
  await edits.started('t', 'u', 'link', [linked]);
  assert.deepEqual(await edits.completed('link', 'completed'), []);

  // Another item still running on the same file makes the result ambiguous.
  await writeFile(join(root, 'shared.txt'), 'beta\n');
  const shared = update('shared.txt', '@@ -1 +1 @@\n-alpha\n+beta\n');
  await edits.started('t', 'u', 'second', [update('shared.txt', '@@ -1 +1 @@\n-beta\n+gamma\n')]);
  assert.deepEqual(await edits.completed('first', 'completed', { threadId: 't', turnId: 'u', changes: [shared] }), []);
  edits.forget('second');
  assert.equal(
    (await edits.completed('first', 'completed', { threadId: 't', turnId: 'u', changes: [shared] })).length,
    1,
  );
});

test('native undo refuses replaced ancestor directories, credential paths and a replaced root', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ic-undo-path-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'workspace'),
    outside = join(base, 'outside');
  await mkdir(join(root, 'dir'), { recursive: true });
  await mkdir(outside);
  const edits = new NativeEdits(join(base, 'records'), root);
  const change = {
    path: 'dir/a.txt',
    kind: { type: 'update' as const, move_path: null },
    diff: '@@ -1 +1 @@\n-before\n+after\n',
  };
  await writeFile(join(root, change.path), 'before\n');
  await edits.started('t', 'u', 'i', [change]);
  await writeFile(join(root, change.path), 'after\n');
  const records = await edits.completed('i', 'completed');
  await rm(join(root, 'dir'), { recursive: true });
  await writeFile(join(outside, 'a.txt'), 'after\n');
  await symlink(outside, join(root, 'dir'), 'junction');
  await assert.rejects(
    edits.restore(records, () => false),
    RestoreConflict,
  );
  assert.equal(await readFile(join(outside, 'a.txt'), 'utf8'), 'after\n');
  await writeFile(join(root, '.env'), 'after\n');
  assert.deepEqual(
    await edits.completed('secret', 'completed', {
      threadId: 't',
      turnId: 'u',
      changes: [{ ...change, path: '.env' }],
    }),
    [],
  );
  await rm(root, { recursive: true });
  await mkdir(join(outside, 'dir'));
  await writeFile(join(outside, 'dir/a.txt'), 'after\n');
  await symlink(outside, root, 'junction');
  await assert.rejects(
    edits.restore(records, () => false),
    RestoreConflict,
  );
  assert.equal(await readFile(join(outside, 'dir/a.txt'), 'utf8'), 'after\n');
});

test('native undo rechecks disk edits and newly dirty buffers after preflight; rollback preserves dirty text', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ic-undo-race-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const edits = new NativeEdits(join(root, '.records'), root);
  const changes = ['a.txt', 'b.txt'].map(path => ({
    path,
    kind: { type: 'update' as const, move_path: null },
    diff: '@@ -1 +1 @@\n-before\n+after\n',
  }));
  for (const change of changes) await writeFile(join(root, change.path), 'before\n');
  await edits.started('t', 'u', 'i', changes);
  for (const change of changes) await writeFile(join(root, change.path), 'after\n');
  const records = await edits.completed('i', 'completed');
  let checks = 0;
  await assert.rejects(
    edits.restore(records, () => ++checks > 2),
    /changed during restoration/,
  );
  for (const change of changes) assert.equal(await readFile(join(root, change.path), 'utf8'), 'after\n');
  // The last preflight check edits the file that will be restored first.
  const { writeFileSync } = await import('node:fs');
  checks = 0;
  await assert.rejects(
    edits.restore(records, () => {
      if (++checks === 2) writeFileSync(join(root, 'b.txt'), 'manual edit\n');
      return false;
    }),
    /changed during restoration/,
  );
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'manual edit\n');
  await writeFile(join(root, 'b.txt'), 'after\n');
  let dirty = false;
  const restored = await edits.restore(records, () => dirty);
  dirty = true;
  await assert.rejects(restored.rollback(), /left as they are/);
  for (const change of changes) assert.equal(await readFile(join(root, change.path), 'utf8'), 'before\n');
});

test('a late dirty check during deleted-file restore cannot leave an empty replacement', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ic-undo-delete-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const edits = new NativeEdits(join(root, '.records'), root);
  await writeFile(join(root, 'gone.txt'), 'original\n');
  await edits.started('t', 'u', 'i', [{ path: 'gone.txt', kind: { type: 'delete' }, diff: 'original\n' }]);
  await rm(join(root, 'gone.txt'));
  const records = await edits.completed('i', 'completed');
  let checks = 0;
  await assert.rejects(
    edits.restore(records, () => ++checks >= 3),
    /changed during restoration/,
  );
  await assert.rejects(readFile(join(root, 'gone.txt')), { code: 'ENOENT' });
  assert.equal((await edits.list())[0].state, 'applied');
});
