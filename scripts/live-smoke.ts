import { restrictedConfig } from '../src/runtime/settings';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/runtime/compatibility';
import { Coordinator } from '../src/sessions/coordinator';
import type { ThreadResumeResponse } from '../src/protocol/v2/ThreadResumeResponse';

// Explicit opt-in only: this command sends one minimal authenticated model request.
async function main() {
  if (process.env.CODEX_LIVE_SMOKE !== '1')
    throw new Error('Set CODEX_LIVE_SMOKE=1 to authorize the live inference smoke test.');
  const temp = await mkdtemp(join(tmpdir(), 'independent-codex-smoke-'));
  const root = await realpath(temp);
  const first = await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root);
  let second: Awaited<ReturnType<typeof connect>> | undefined;
  const data = new Map();
  const store = {
    get: (key: string, fallback: any) => data.get(key) ?? fallback,
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
  let notify: (() => void) | undefined;
  const session = new Coordinator(
    root,
    store,
    () => notify?.(),
    async () => {},
    () => {},
  );
  try {
    await session.attach(first.client, first.version);
    assert.equal(session.state.account, 'chatgpt');
    await session.newThread();
    const id = session.state.threadId!;
    console.log('Handshake, ChatGPT account, catalog, effective read-only policy: PASS');
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Live turn exceeded 90 seconds; do not replay')), 90_000);
      notify = () => {
        if (['completed', 'failed', 'interrupted', 'unknown'].includes(session.state.status)) {
          clearTimeout(timer);
          resolve();
        }
      };
    });
    await session.send('Reply exactly CODEX_CLIENT_OK. Do not use any tools.');
    await completed;
    assert.equal(session.state.status, 'completed', session.state.error);
    assert.ok(session.state.items.some(i => i.type === 'agentMessage' && i.text.includes('CODEX_CLIENT_OK')));
    console.log('Real authenticated turn and streamed/final event rendering: PASS');
    second = await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root);
    await assert.rejects(
      second.client.request('thread/resume', {
        config: restrictedConfig,
        threadId: id,
        cwd: root,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        excludeTurns: true,
      }),
      /active writer/,
    );
    console.log('Second app-server is refused while the first owns the thread: PASS (0.152.0 only)');
    await first.client.shutdown();
    const res = await second.client.request<ThreadResumeResponse>('thread/resume', {
      config: restrictedConfig,
      threadId: id,
      cwd: root,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      excludeTurns: true,
    });
    assert.equal(res.thread.id, id);
    console.log('Sequential resume after process exit: PASS');
    await session.attach(second.client, second.version);
    await session.openThread(id);
    assert.ok(session.state.items.some(i => i.text.includes('CODEX_CLIENT_OK')));
    console.log('Authoritative paginated history hydration: PASS');
    console.log(
      JSON.stringify({
        runtime: first.version,
        inference: 'completed',
        policy: 'read-only/never',
        writerExclusion: 'two app-servers verified; other versions/desktop unverified',
      }),
    );
  } finally {
    second?.client.stop();
    await session.dispose();
    first.client.stop();
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Live smoke failed');
  process.exitCode = 1;
});
