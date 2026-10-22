import { restrictedConfig } from '../src/runtime/settings';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/runtime/compatibility';
import { EDIT_TOOL, editTool, editInstructions } from '../src/review/tool';
import type { ThreadStartResponse } from '../src/protocol/v2/ThreadStartResponse';

async function main() {
  if (process.env.CODEX_LIVE_TOOLS !== '1')
    throw new Error('Set CODEX_LIVE_TOOLS=1; this test sends one small model turn.');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ic-tools-')));
  const runtime = await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root);
  try {
    await writeFile(join(root, 'fixture.txt'), 'before\n');
    const models = await runtime.client.request<{ data: { model: string; isDefault: boolean }[] }>('model/list', {
      limit: 100,
      includeHidden: false,
    });
    const model = models.data.find(m => m.isDefault)?.model;
    const start = await runtime.client.request<ThreadStartResponse>('thread/start', {
      config: restrictedConfig,
      model,
      cwd: root,
      modelProvider: 'openai',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      dynamicTools: [editTool],
      developerInstructions: editInstructions,
    });
    let calls = 0;
    runtime.client.on('request', m => {
      const p = m.params as any;
      if (m.method !== 'item/tool/call' || p?.threadId !== start.thread.id || p.tool !== EDIT_TOOL) {
        runtime.client.reject(m.id!);
        return;
      }
      calls++;
      void readFile(join(root, 'fixture.txt'), 'utf8').then(text => {
        assert.equal(text, 'before\n');
        runtime.client.respond(m.id!, {
          success: false,
          contentItems: [
            { type: 'inputText', text: 'User declined before apply. No editor or filesystem changes were made. Stop.' },
          ],
        });
      });
    });
    const output: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tool probe timed out. Do not replay.')), 90_000);
      runtime.client.on('notification', m => {
        const p = m.params as any;
        if (p?.threadId !== start.thread.id) return;
        if (m.method === 'item/completed' && p.item.type === 'agentMessage') output.push(p.item.text);
        if (m.method === 'turn/completed') {
          output.push(`turn:${p.turn.status},error:${JSON.stringify(p.turn.error?.codexErrorInfo)}`);
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await runtime.client.request('turn/start', {
      threadId: start.thread.id,
      effort: 'low',
      input: [
        {
          type: 'text',
          text: 'Reviewed edits are enabled for this test. Call propose_text_edits exactly once with path fixture.txt and replacements [{"oldText":"before","newText":"after"}]. Do not read files or use other tools. If declined, stop.',
          text_elements: [],
        },
      ],
    });
    await done;
    assert.equal(calls, 1, JSON.stringify(output));
    assert.equal(await readFile(join(root, 'fixture.txt'), 'utf8'), 'before\n');
    console.log('PASS: real dynamic tool proposal held and declined before any target write.');
  } finally {
    await runtime.client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Live tool probe failed');
  process.exitCode = 1;
});
