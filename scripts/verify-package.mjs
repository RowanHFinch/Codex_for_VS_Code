import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import yauzl from 'yauzl';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const path = process.argv[2] || `dist/codex-for-vscode-${manifest.version}.vsix`;
const allowed = new Set([
  'extension.vsixmanifest',
  '[Content_Types].xml',
  ...[
    'package.json',
    'package.nls.json',
    'package.nls.zh-cn.json',
    'readme.md',
    'LICENSE.txt',
    'THIRD_PARTY_NOTICES.md',
    'changelog.md',
    'PRIVACY.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'media/icon.svg',
    'media/icon-light.svg',
    'media/icon.png',
    'dist/extension.js',
    'dist/webview.js',
    'dist/webview.css',
    'dist/THIRD_PARTY_LICENSES.txt',
    'docs/runtime-support.md',
    'docs/release-readiness.md',
  ].map(name => `extension/${name}`),
  // PvRecorder ships unbundled with its desktop native libraries (copied by scripts/build.mjs).
  ...(await readdir('dist/node_modules/@picovoice/pvrecorder-node', { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => `extension/${entry.parentPath}/${entry.name}`.replace(/\\/g, '/')),
]);
const archive = await new Promise((resolve, reject) =>
  yauzl.open(path, { lazyEntries: true }, (error, zip) => (error ? reject(error) : resolve(zip))),
);
const contents = new Map();
let total = 0;
await new Promise((resolve, reject) => {
  archive.on('error', reject);
  archive.on('end', resolve);
  archive.on('entry', entry => {
    try {
      assert.ok(allowed.has(entry.fileName), `Unexpected packaged file: ${entry.fileName}`);
      assert.ok(!contents.has(entry.fileName), 'Duplicate entry');
      total += entry.uncompressedSize;
      // About 3.8 MB of this is PvRecorder's native libraries for macOS, Linux and Windows.
      assert.ok(total < 8_000_000, 'Archive exceeds the reviewed size');
    } catch (error) {
      archive.close();
      reject(error);
      return;
    }
    archive.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => {
        contents.set(entry.fileName, Buffer.concat(chunks));
        archive.readEntry();
      });
    });
  });
  archive.readEntry();
});
assert.deepEqual([...contents.keys()].sort(), [...allowed].sort(), 'Missing package files');
const packaged = JSON.parse(contents.get('extension/package.json').toString('utf8'));
assert.equal(packaged.version, manifest.version);
assert.equal(packaged.publisher, manifest.publisher);
assert.equal(packaged.main, './dist/extension.js');
assert.deepEqual(packaged.contributes.viewsContainers, manifest.contributes.viewsContainers);
assert.deepEqual(packaged.contributes.views, manifest.contributes.views);
const openCommand = packaged.contributes.commands.find(command => command.command === 'independentCodex.open');
for (const asset of [
  packaged.icon,
  packaged.contributes.viewsContainers.secondarySidebar[0].icon,
  packaged.contributes.viewsContainers.activitybar[0].icon,
  ...Object.values(openCommand.icon),
])
  assert.ok(contents.get(`extension/${asset}`)?.equals(await readFile(asset)), `Packaged icon differs: ${asset}`);
for (const name of ['extension.js', 'webview.js', 'webview.css', 'THIRD_PARTY_LICENSES.txt'])
  assert.ok(
    contents.get(`extension/dist/${name}`).equals(await readFile(`dist/${name}`)),
    `Packaged ${name} differs from the tested build`,
  );
for (const [name, bytes] of contents) {
  const text = bytes.toString('utf8');
  // Vendor native libraries carry their own CI build paths; they must instead match the npm package exactly.
  const vendorBinary = name.endsWith('.node');
  if (vendorBinary)
    assert.ok(
      bytes.equals(await readFile(name.replace('extension/dist/', ''))),
      `Packaged ${name} differs from the installed npm package`,
    );
  assert.ok(
    !(
      vendorBinary
        ? /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-proj-[A-Za-z0-9]{20}/
        : /(?:\/Users\/|[A-Z]:\\Users\\|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-proj-[A-Za-z0-9]{20})/
    ).test(text),
    `Local path or secret marker found in ${name}`,
  );
}
const scope = JSON.parse(await readFile('docs/feature-matrix.json', 'utf8'));
assert.equal(scope.features.length, 110);
assert.deepEqual(
  scope.features.map(row => row.id).sort(),
  [...Array.from({ length: 109 }, (_, i) => `CLAUDE-${String(i + 1).padStart(3, '0')}`), 'REQ-I18N'].sort(),
  'Original reference scope changed',
);
const bytes = await readFile(path),
  sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(`${path}.sha256`, `${sha256}  ${basename(path)}\n`);
const result = {
  version: manifest.version,
  artifact: basename(path),
  bytes: bytes.length,
  files: contents.size,
  sha256,
  scopeRows: 110,
  recordedPlatformEvidence:
    'See docs/release-readiness.md; historical platform results do not certify the current package',
  verificationScope: 'Archive identity/content checks only; this command does not execute platform acceptance',
  publication: 'not performed',
};
await writeFile('dist/release-verification.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
