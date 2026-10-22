import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const seen = new Set();
const notices = [];
function collect(name, parent) {
  if (name.startsWith('@types/')) return;
  const require = createRequire(join(parent, 'package.json'));
  let directory = dirname(require.resolve(name));
  while (true) {
    try {
      if (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name === name) break;
    } catch {}
    const above = dirname(directory);
    if (above === directory) throw new Error(`Cannot locate license for ${name}`);
    directory = above;
  }
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const identity = `${pkg.name}@${pkg.version}`;
  if (seen.has(identity)) return;
  seen.add(identity);
  const files = readdirSync(directory).filter(file => /^(?:licen[sc]e|copying|notice)(?:\.|$|-)/i.test(file));
  // PvRecorder's npm package omits its repository's Apache-2.0 LICENSE; ship that text instead.
  const bundled = pkg.name === '@picovoice/pvrecorder-node' ? ['licenses/PvRecorder-LICENSE.txt'] : [];
  if (!files.length && !bundled.length) throw new Error(`Missing license for ${identity}`);
  notices.push(
    `${identity}\n${[...files.map(file => join(directory, file)), ...bundled].map(file => readFileSync(file, 'utf8')).join('\n')}`,
  );
  for (const dependency of Object.keys(pkg.dependencies ?? {})) collect(dependency, directory);
}
for (const name of Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).dependencies))
  collect(name, resolve('.'));
notices.unshift(
  'Public Codex protocol declarations\n' +
    readFileSync('licenses/Codex-Apache-2.0.txt', 'utf8') +
    '\n' +
    readFileSync('licenses/Codex-NOTICE.txt', 'utf8'),
);
writeFileSync('dist/THIRD_PARTY_LICENSES.txt', notices.join('\n\n--------------------\n\n'));
console.log(`Included licenses for ${seen.size} runtime dependencies.`);
