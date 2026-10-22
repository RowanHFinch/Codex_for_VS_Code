import { restrictedConfig } from '../src/runtime/settings';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/runtime/compatibility';
import type { ThreadStartResponse } from '../src/protocol/v2/ThreadStartResponse';

async function main() {
  if (process.env.CODEX_LIVE_APPROVAL !== '1')
    throw new Error('Set CODEX_LIVE_APPROVAL=1; this disposable approval probe sends one model turn.');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'independent-codex-approval-')));
  const runtime = await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root);
  let fileApprovals = 0,
    proposedFiles = 0,
    approvalError: unknown;
  try {
    await writeFile(join(root, 'fixture.txt'), 'before\n');
    const started = await runtime.client.request<ThreadStartResponse>('thread/start', {
      config: restrictedConfig,
      cwd: root,
      modelProvider: 'openai',
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    });
    assert.equal(started.sandbox.type, 'readOnly');
    assert.equal(started.approvalPolicy, 'on-request');
    const id = started.thread.id;
    runtime.client.on('request', m => {
      const p = m.params as any;
      if (p?.threadId !== id) {
        runtime.client.reject(m.id!);
        return;
      }
      if (m.method === 'item/fileChange/requestApproval') {
        fileApprovals++;
        void readFile(join(root, 'fixture.txt'), 'utf8')
          .then(bytes => {
            assert.equal(bytes, 'before\n');
            runtime.client.respond(m.id!, { decision: 'decline' });
          })
          .catch(error => {
            approvalError = error;
            runtime.client.respond(m.id!, { decision: 'cancel' });
          });
      } else if (m.method === 'item/commandExecution/requestApproval')
        runtime.client.respond(m.id!, { decision: 'decline' });
      else if (m.method === 'item/permissions/requestApproval')
        runtime.client.respond(m.id!, { permissions: {}, scope: 'turn' });
      else runtime.client.reject(m.id!);
    });
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Approval probe timed out; request must not be replayed')),
        90_000,
      );
      runtime.client.on('notification', m => {
        const p = m.params as any;
        if (p?.threadId !== id) return;
        if (m.method === 'item/started' && p.item.type === 'fileChange') proposedFiles += p.item.changes.length;
        if (m.method === 'turn/completed') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await runtime.client.request('turn/start', {
      threadId: id,
      effort: 'low',
      input: [
        {
          type: 'text',
          text: 'Use apply_patch to replace before with after in fixture.txt. Request approval if required. Use no shell or other tools. If approval is denied, stop immediately.',
          text_elements: [],
        },
      ],
    });
    await completed;
    if (approvalError) throw approvalError;
    assert.equal(await readFile(join(root, 'fixture.txt'), 'utf8'), 'before\n');
    console.log(
      JSON.stringify({
        fileApprovals,
        proposedFiles,
        targetUnchanged: true,
        conclusion: fileApprovals
          ? 'Whole-item decline before target write observed'
          : 'No live file approval emitted; strict edit acceptance remains unverified',
      }),
    );
  } finally {
    await runtime.client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Approval probe failed');
  process.exitCode = 1;
});
