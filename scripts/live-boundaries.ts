import { restrictedConfig } from '../src/runtime/settings';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/runtime/compatibility';
import { Coordinator } from '../src/sessions/coordinator';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function main() {
  if (process.env.CODEX_LIVE_BOUNDARIES !== '1')
    throw new Error('Set CODEX_LIVE_BOUNDARIES=1; this test sends two small model turns.');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'independent-codex-boundary-')));
  const runtime = await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root);
  const values = new Map();
  const store = {
    get: (key: string, fallback: any) => values.get(key) ?? fallback,
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
  let changed: (() => void) | undefined;
  const session = new Coordinator(
    root,
    store,
    () => changed?.(),
    async () => {},
    () => {},
  );
  const events = new Map<string, number>();
  runtime.client.on('notification', m => events.set(m.method!, (events.get(m.method!) ?? 0) + 1));
  const finish = () =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Live turn timed out; do not replay')), 90_000);
      changed = () => {
        if (['completed', 'interrupted', 'failed', 'unknown'].includes(session.state.status)) {
          clearTimeout(timer);
          resolve();
        }
      };
    });
  try {
    await session.attach(runtime.client, runtime.version);
    await session.newThread();
    const id = session.state.threadId!;
    await writeFile(join(root, 'fixture.txt'), 'before\n');
    let done = finish();
    await session.send(
      'Use apply_patch once to replace before with after in fixture.txt. Do not use shell, network or other tools. If denied, stop and briefly report the denial.',
    );
    await done;
    assert.equal(await readFile(join(root, 'fixture.txt'), 'utf8'), 'before\n');
    console.log('Read-only write-attempt target bytes unchanged:', session.state.status);
    console.log('Observed item kinds:', [...new Set(session.state.items.map(i => i.type))].join(', '));
    session.state.mode = 'plan';
    const started = new Promise<void>(resolve => {
      const listener = (m: any) => {
        if (m.method === 'turn/started') {
          runtime.client.off('notification', listener);
          resolve();
        }
      };
      runtime.client.on('notification', listener);
    });
    done = finish();
    await session.send('Do not use tools. Explain binary search in two short sentences.');
    await started;
    if (session.state.status === 'running') await session.cancel();
    await done;
    assert.ok(['interrupted', 'completed'].includes(session.state.status));
    console.log('Plan-mode request and real interruption reconciliation:', session.state.status);
    try {
      await promisify(execFile)(
        process.env.CODEX_RUNTIME_PATH || 'codex',
        [
          ...runtime.policyArgs,
          'exec',
          'resume',
          '--skip-git-repo-check',
          '--json',
          id,
          'Reply CODEX_CLI_OK. Do not use tools.',
        ],
        {
          cwd: root,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, OPENAI_BASE_URL: undefined },
        },
      );
      throw new Error('CLI unexpectedly acquired the owned thread; concurrency is unsupported');
    } catch (e) {
      const error = e as { stdout?: string; stderr?: string; message?: string };
      assert.match((error.stdout ?? '') + (error.stderr ?? ''), /active writer/);
      console.log('Official CLI 0.152.0 concurrent resume refused before model execution: PASS');
    }
    const other = await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root);
    try {
      await assert.rejects(
        other.client.request('thread/resume', {
          config: restrictedConfig,
          threadId: id,
          cwd: root,
          sandbox: 'read-only',
          approvalPolicy: 'never',
          excludeTurns: true,
        }),
        /active writer/,
      );
      await runtime.client.shutdown();
      await session.attach(other.client, other.version);
      await session.openThread(id);
      assert.ok(session.state.items.some(i => i.type === 'userMessage'));
      console.log('Owner release, separate runtime resume and paginated history hydration: PASS');
    } finally {
      await other.client.shutdown();
    }
    console.log(
      'Runtime event counts:',
      JSON.stringify(
        Object.fromEntries(
          [...events].filter(([method]) =>
            /turn\/(started|completed)|item\/(started|completed|agentMessage\/delta)/.test(method),
          ),
        ),
      ),
    );
  } finally {
    await session.dispose();
    await runtime.client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Boundary smoke failed');
  process.exitCode = 1;
});
