import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PastedImages } from '../src/pasted-images';

const png = 'data:image/png;base64,iVBORw0KGgo=';

test('pasted images live in temp files scoped to their chat and move into a chat created from the draft', async t => {
  const images = new PastedImages();
  t.after(() => images.dispose());
  await images.add(null, 'a', 'shot.png', png);
  await images.add('other', 'b', 'shot.png', png);
  const [draft] = images.list(null);
  assert.deepEqual(readFileSync(draft.path), Buffer.from('iVBORw0KGgo=', 'base64'));
  assert.deepEqual(images.list('chat'), []);
  images.adopt('chat');
  assert.deepEqual(images.list(null), []);
  assert.deepEqual(
    images.list('chat').map(i => i.id),
    ['a'],
  );
  images.sent('chat', images.list('chat'));
  assert.deepEqual(images.list('chat'), []);
  assert.ok(
    existsSync(draft.path),
    'the runtime may read the file after the request returns, so it stays until dispose',
  );
  for (const id of ['c', 'd', 'e', 'f']) await images.add('other', id, 'x.png', png);
  await assert.rejects(images.add('other', 'g', 'x.png', png), /up to 5/);
  const removed = images.list('other')[0];
  images.remove('other', removed.id);
  assert.ok(!images.list('other').includes(removed));
  assert.ok(existsSync(removed.path), 'an in-flight send may still use the file');
  await images.dispose();
  assert.ok(!existsSync(dirname(draft.path)));
});
test('an unsupported image type is refused with a clear message', async t => {
  const images = new PastedImages();
  t.after(() => images.dispose());
  await assert.rejects(images.add(null, 'b', 'shot.bmp', 'data:image/bmp;base64,Qk0='), /PNG, JPEG, GIF and WebP/);
  assert.deepEqual(images.list(null), []);
});
