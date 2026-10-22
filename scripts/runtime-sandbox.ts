import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeVersion } from '../src/runtime/compatibility';

async function main() {
  if (process.platform !== 'darwin')
    throw new Error('This sandbox acceptance probe targets the declared macOS support platform.');
  const executable = process.env.CODEX_RUNTIME_PATH || 'codex';
  await runtimeVersion(executable);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ic-sandbox-'))),
    home = join(root, 'home'),
    target = join(root, 'fixture.txt');
  await mkdir(home);
  await writeFile(target, 'before');
  try {
    const program =
      "const fs=require('node:fs');if(fs.readFileSync(process.argv[1],'utf8')!=='before')process.exit(10);try{fs.writeFileSync(process.argv[1],'after');process.exit(11)}catch(e){if(!['EPERM','EACCES','EROFS'].includes(e.code))throw e;process.stdout.write('READ_OK WRITE_BLOCKED')}";
    const { stdout } = await promisify(execFile)(
      executable,
      ['sandbox', '-P', ':read-only', '-C', root, '--', process.execPath, '-e', program, target],
      { cwd: root, timeout: 15_000, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, TMPDIR: root } },
    );
    assert.equal(stdout, 'READ_OK WRITE_BLOCKED');
    assert.equal(await readFile(target, 'utf8'), 'before');
    console.log(
      'PASS: Codex 0.152.0 macOS read-only sandbox allowed a real read and denied a real write. No model or credentials used.',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Sandbox check failed');
  process.exitCode = 1;
});
