import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from '../src/runtime/compatibility';
import { restrictedConfig } from '../src/runtime/settings';
import { Coordinator } from '../src/sessions/coordinator';

async function main() {
  if (process.env.CODEX_LIVE_ACCEPT !== '1')
    throw new Error('Set CODEX_LIVE_ACCEPT=1 to authorize a real subscription model test.');
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ic-live-agents-'))),
    root = join(temp, 'workspace');
  await mkdir(root);
  const runtime = await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root);
  const created = new Set<string>();
  let coordinator: Coordinator | undefined;
  let verified = false;
  try {
    const account = await runtime.client.request<any>('account/read', { refreshToken: false });
    assert.equal(account.account?.type, 'chatgpt');
    assert.equal(account.requiresOpenaiAuth, true);
    const catalog = await runtime.client.request<any>('model/list', { limit: 100 });
    const model =
      catalog.data.find((m: any) => !m.hidden && m.isDefault && m.multiAgentVersion === 'v2') ??
      catalog.data.find((m: any) => !m.hidden && m.multiAgentVersion === 'v2');
    assert.ok(model, 'A v2-capable model is required');
    const effort = model.supportedReasoningEfforts.some((e: any) => e.reasoningEffort === 'medium')
      ? 'medium'
      : model.defaultReasoningEffort;
    const request = runtime.client.request.bind(runtime.client);
    runtime.client.request = async (method: string, params?: any): Promise<any> => {
      const result = await request(
        method,
        method === 'thread/start'
          ? { ...params, config: { ...restrictedConfig, 'features.multi_agent': true } }
          : params,
      );
      if (method === 'thread/start') created.add((result as any).thread.id);
      return result;
    };
    const store = new Map();
    coordinator = new Coordinator(
      root,
      {
        get: (k, v) => store.get(k) ?? v,
        update: async (k, v) => {
          store.set(k, v);
        },
      },
      () => {},
      async () => {},
      () => {},
    );
    await coordinator.attach(runtime.client, runtime.version, {
      ...runtime.settings,
      model: model.model,
      effort,
      profile: ':read-only',
      approval: 'never',
      reviewer: 'user',
      memories: false,
    });
    await coordinator.newThread();
    const parent = coordinator.state.threadId;
    const token = 'CHILD_' + randomUUID(),
      interrupt = process.env.CODEX_AGENTS_INTERRUPT === '1';
    await coordinator.send(
      `This is an explicitly authorized subagent acceptance test. Use the native subagent capability to create exactly one child agent. Give the child this task: ${interrupt ? 'Run /bin/sleep 20 using the native command tool, then return' : 'Return only'} the exact text ${token}. ${interrupt ? 'The sleep command is the only permitted tool action. Do not read files, browse or edit anything.' : 'Do not use tools, read files, browse, run commands or edit anything.'} Wait for the child's result, then return that exact text as your final answer. Do not perform the child task yourself or create additional agents.`,
    );
    const end = Date.now() + 150000;
    if (interrupt) {
      while (
        !coordinator.agents.state.tasks.some(t => t.status === 'running' && t.turnId) &&
        !['completed', 'failed', 'unknown'].includes(coordinator.state.status) &&
        Date.now() < end
      )
        await new Promise(resolve => setTimeout(resolve, 50));
      const task = coordinator.agents.state.tasks.find(t => t.status === 'running' && t.turnId);
      assert.ok(task, 'No running real child to interrupt');
      const targetTurn = await coordinator.stopAgent(task.id);
      let stopped = false;
      const stopEnd = Date.now() + 15000;
      while (!stopped && Date.now() < stopEnd) {
        const turns = await coordinator.request<any>('thread/turns/list', {
          threadId: task.id,
          limit: 10,
          sortDirection: 'desc',
          itemsView: 'full',
        });
        stopped = turns.data.some((turn: any) => turn.id === targetTurn && turn.status === 'interrupted');
        if (!stopped) await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(stopped, true, 'Native targeted child turn did not interrupt');
      assert.equal(coordinator.state.threadId, parent);
      created.add(task.id);
      verified = true;
      console.log(
        JSON.stringify({
          model: model.model,
          multiAgent: model.multiAgentVersion,
          realChatGptAccount: true,
          targetedInterrupt: true,
          nativeReadback: true,
          parentUnchanged: true,
          parentStillRunning: coordinator.state.status === 'running',
        }),
      );
      return;
    }
    while (!['completed', 'failed', 'unknown', 'interrupted'].includes(coordinator.state.status) && Date.now() < end)
      await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(coordinator.state.status, 'completed', coordinator.state.error ?? 'Parent did not complete');
    await coordinator.agents.refresh();
    const children = coordinator.agents.state.tasks;
    for (const child of children) created.add(child.id);
    assert.equal(children.length, 1, 'Exactly one real native child must be recorded');
    const child = children[0];
    assert.equal(child.parentId, parent);
    await coordinator.agents.activeTurn(child.id);
    await coordinator.agents.open(child.id);
    assert.ok(
      coordinator.agents.state.selected?.items.some(item => item.type === 'agentMessage' && item.text.includes(token)),
      'Child native transcript token missing',
    );
    assert.ok(
      coordinator.state.items.some(item => item.type === 'agentMessage' && item.text.includes(token)),
      'Parent final result missing',
    );
    verified = true;
    console.log(
      JSON.stringify({
        model: model.model,
        effort,
        multiAgent: model.multiAgentVersion,
        realChatGptAccount: true,
        nativeChild: true,
        nativeAncestry: true,
        passiveTranscript: true,
        parentResult: !interrupt,
        targetedInterrupt: false,
        parentUnchanged: coordinator.state.threadId === parent,
        syntheticPromptOnly: true,
      }),
    );
  } finally {
    if (coordinator) {
      if (['running', 'waiting'].includes(coordinator.state.status)) await coordinator.cancel().catch(() => {});
      for (const child of coordinator.agents.state.tasks) {
        created.add(child.id);
        if (['running', 'active'].includes(child.status)) await coordinator.stopAgent(child.id).catch(() => {});
      }
      await coordinator.dispose();
    } else await runtime.client.shutdown();
    const cleanup = await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root, {}, true);
    let archived = 0;
    try {
      for (const id of [...created].reverse()) {
        await cleanup.client.request('thread/archive', { threadId: id });
        archived++;
      }
    } finally {
      await cleanup.client.shutdown();
    }
    console.log(JSON.stringify({ verified, archivedFixtures: archived, expectedFixtures: created.size }));
    await rm(temp, { recursive: true, force: true });
  }
}
void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
