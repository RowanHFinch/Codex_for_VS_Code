import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { RuntimeClient } from '../src/runtime/client';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/runtime/compatibility';
import { Coordinator } from '../src/sessions/coordinator';

async function main() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'independent-codex-noauth-')));
  const home = join(temp, 'runtime'),
    root = join(temp, 'workspace');
  await Promise.all([mkdir(home), mkdir(root)]);
  const original = RuntimeClient.spawn;
  let session: Coordinator | undefined;
  try {
    RuntimeClient.spawn = (executable, args, cwd) =>
      new RuntimeClient(
        spawn(executable, args, {
          cwd,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CODEX_HOME: home },
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
    const runtime = await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root);
    const values = new Map();
    session = new Coordinator(
      root,
      {
        get: (key: string, fallback: any) => values.get(key) ?? fallback,
        update: async (key, value) => {
          values.set(key, value);
        },
      },
      () => {},
      async () => {},
      () => {},
    );
    await session.attach(runtime.client, runtime.version);
    const deadline = Date.now() + 5000;
    while (session.state.account === 'unknown' && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(session.state.account, 'unavailable');
    await session.newThread();
    assert.ok(session.state.threadId);
    assert.equal(session.state.account, 'unavailable');
    console.log(
      'PASS: real runtime with isolated empty CODEX_HOME can create an empty chat while remaining signed out; no generation requested or credentials copied.',
    );
  } finally {
    RuntimeClient.spawn = original;
    await session?.dispose();
    await rm(temp, { recursive: true, force: true });
  }
}
void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Offline smoke failed');
  process.exitCode = 1;
});
