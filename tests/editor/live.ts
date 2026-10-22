import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from '../../src/runtime/compatibility';
import { Coordinator } from '../../src/sessions/coordinator';
import { EditorReview } from '../../src/review/editor';
import { EditJournal } from '../../src/review/journal';
import { validateEditorState } from '../../src/context';
import type { EditReview } from '../../src/shared';

export async function liveEditorTest(root: string) {
  const path = 'live-文.txt',
    uri = vscode.Uri.file(join(root, path));
  const base = 'alpha=before\r\nbeta=keep\r\n',
    after = 'alpha=after\r\nbeta=keep\r\n';
  await writeFile(uri.fsPath, base);
  const document = await vscode.workspace.openTextDocument(uri);
  let proposed: EditReview | undefined;
  const review = new EditorReview(
    root,
    join(root, 'live-records'),
    () => assert.equal(vscode.workspace.isTrusted, true),
    value => {
      proposed = value;
    },
  );
  const data = new Map<string, unknown>();
  const store = {
    get: <T>(key: string, fallback: T) => (data.get(key) ?? fallback) as T,
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
  const session = new Coordinator(
    root,
    store,
    () => {},
    () => validateEditorState(root, []),
    () => {},
    (call, signal) => review.propose(call, signal),
  );
  const runtime = await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root);
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 90_000;
    while (!check() && Date.now() < deadline) {
      if (['failed', 'unknown', 'interrupted'].includes(session.state.status))
        throw new Error(`Live editor turn ended: ${session.state.status}. No request was replayed.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(check(), 'Live editor test timed out; do not replay an unknown request');
  };
  try {
    await session.attach(runtime.client, runtime.version);
    await session.newThread();
    session.state.permission = 'reviewed';
    await session.send(
      'Call propose_text_edits exactly once, with path "live-文.txt" and replacements [{"oldText":"alpha=before","newText":"alpha=after"},{"oldText":"beta=keep","newText":"beta=rejected"}]. Do not read files or call other tools. Respect partial acceptance and stop after the tool result.',
    );
    await until(() => Boolean(proposed));
    const pending = proposed!;
    assert.equal(pending.hunks.length, 2);
    assert.equal(document.getText(), base);
    assert.equal(await readFile(uri.fsPath, 'utf8'), base);
    await review.preview(pending.id, [pending.hunks[0].id]);
    await review.apply(pending.id, [pending.hunks[0].id]);
    await until(() => session.state.status === 'completed');
    assert.equal(document.getText(), after);
    assert.equal(await readFile(uri.fsPath, 'utf8'), base);
    const checkpoint = (await new EditJournal(join(root, 'live-records'), root).list())[0];
    assert.equal(checkpoint.state, 'applied');
    assert.equal(checkpoint.threadId, session.state.threadId);
    assert.equal(await document.save(), true);
    assert.equal(await readFile(uri.fsPath, 'utf8'), after);
    const id = session.state.threadId!;
    await session.rename('Reviewed edit fixture');
    await session.listSessions(false, 'beta=rejected', false);
    assert.ok(
      session.state.sessions.some(s => s.id === id && s.snippet),
      'Real message search must return the fixture chat',
    );
    await session.bookmark(id);
    assert.equal(session.state.sessions.find(s => s.id === id)?.bookmarked, true);
    await session.listSessions(false, '', false);
    await session.archive();
    await session.listSessions(false, '', true);
    assert.ok(session.state.sessions.some(s => s.id === id));
    await session.unarchive(id);
    await session.listSessions(false, '', false);
    assert.ok(session.state.sessions.some(s => s.id === id));
    await session.openThread(id);
    await session.setDraft('Restart draft fixture');
    await session.dispose();
    const resumed = new Coordinator(
      root,
      store,
      () => {},
      () => validateEditorState(root, []),
      () => {},
    );
    const replacement = await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root);
    try {
      await resumed.attach(replacement.client, replacement.version);
      assert.equal(resumed.state.threadId, id);
      assert.equal(resumed.state.draft, 'Restart draft fixture');
      assert.equal(resumed.state.permission, 'read-only');
      assert.ok(resumed.state.items.some(item => item.type === 'userMessage'));
    } finally {
      await resumed.dispose();
      await replacement.client.shutdown();
    }
    await review.restore(checkpoint.id);
    assert.equal(document.getText(), base);
    assert.equal(await readFile(uri.fsPath, 'utf8'), after);
    assert.equal(await document.save(), true);
    assert.equal(await readFile(uri.fsPath, 'utf8'), base);
    console.log(
      'EDITOR LIVE PASS: model -> proposal -> native diff -> partial apply -> save -> search/bookmark/rename/archive/restore -> restart/draft/history -> checkpoint restore/save.',
    );
  } finally {
    await session.dispose();
    await runtime.client.shutdown();
    review.dispose();
  }
}

export async function liveContextTest(root: string) {
  const { randomUUID } = await import('node:crypto');
  const { ActiveEditorContext } = await import('../../src/active-editor');
  const token = `CODEX_CONTEXT_${randomUUID().replaceAll('-', '')}`;
  const uri = vscode.Uri.file(join(root, 'selection-context.ts'));
  await writeFile(
    uri.fsPath,
    `// OUTSIDE_SELECTION_TOP\nconst selectedToken = "${token}";\n// OUTSIDE_SELECTION_BOTTOM\n`,
  );
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(1, 0, 2, 0);
  const tracker = new ActiveEditorContext(root, () => {});
  const data = new Map<string, unknown>();
  const store = {
    get: <T>(key: string, fallback: T) => (data.get(key) ?? fallback) as T,
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
  const session = new Coordinator(
    root,
    store,
    () => {},
    async entries => {
      await validateEditorState(root, entries);
    },
    () => {},
  );
  const runtime = await connect(process.env.CODEX_RUNTIME_PATH || 'codex', root);
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 90_000;
    while (!check() && Date.now() < deadline) {
      if (['failed', 'unknown', 'interrupted'].includes(session.state.status))
        throw new Error('Live context task failed or has an unknown outcome. Do not replay it.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(check(), 'Live context task timed out; no request was replayed');
  };
  try {
    await until(() => !tracker.pending && Boolean(tracker.preview([])));
    const context = tracker.capture(tracker.preview([])!.id, [])!;
    assert.equal(context.startLine, 2);
    assert.equal(context.endLine, 2);
    assert.equal(context.kind, 'selection');
    assert.equal(context.text, `const selectedToken = "${token}";\n`);
    assert.doesNotMatch(context.text, /OUTSIDE_SELECTION/);
    await session.attach(runtime.client, runtime.version);
    await session.newThread();
    await session.send(
      'Reply with only the value of selectedToken in the selected editor context. Do not read files or call tools.',
      context,
    );
    await until(() => session.state.status === 'completed');
    const answer = session.state.items
      .filter(item => item.type === 'agentMessage')
      .map(item => item.text)
      .join('')
      .trim();
    assert.equal(answer, token, 'Model must read the value present only in the selected editor context');
    await session.archive();
    console.log(
      'EDITOR CONTEXT LIVE PASS: native selection -> captured line 2 only -> guarded runtime send -> exact random-token answer; synthetic chat archived.',
    );
  } finally {
    tracker.dispose();
    await session.dispose();
    await runtime.client.shutdown();
  }
}
