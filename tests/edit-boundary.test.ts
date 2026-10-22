import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, writeFile, readFile, symlink, link, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceText, attachable } from '../src/files';
import { proposalFromReplacements, selectedProposal } from '../src/review/proposals';
import { EditJournal, assertRestoreText } from '../src/review/journal';

test('replacement proposals preserve Unicode/CRLF and reject ambiguous, overlapping and invalid text', () => {
  const base = '甲\r\nsecond\r\n';
  const { proposal } = proposalFromReplacements(base, {
    path: '文.txt',
    replacements: [
      { oldText: '甲', newText: '乙' },
      { oldText: 'second', newText: 'changed' },
    ],
  });
  assert.equal(selectedProposal(base, proposal, [proposal.hunks[0].id]), '乙\r\nsecond\r\n');
  for (const [text, replacements] of [
    ['aaaa', [{ oldText: 'aa', newText: 'b' }]],
    [base, [{ oldText: '', newText: 'b' }]],
    [base, [{ oldText: '甲', newText: '\ud800' }]],
    ['甲😀乙', [{ oldText: '\ud83d', newText: 'X' }]],
    [
      base,
      [
        { oldText: '甲', newText: '乙' },
        { oldText: '甲\r\n', newText: '' },
      ],
    ],
  ] as const)
    assert.throws(() => proposalFromReplacements(text, { path: 'a', replacements }));
  assert.throws(
    () => proposalFromReplacements('a\r\nb', { path: 'a', replacements: [{ oldText: '\r', newText: '' }] }),
    /CRLF/,
  );
  const normalized = proposalFromReplacements('a\r\nb', {
    path: 'a',
    replacements: [{ oldText: 'a', newText: 'first\nsecond' }],
  });
  assert.equal(
    selectedProposal(
      'a\r\nb',
      normalized.proposal,
      normalized.proposal.hunks.map(h => h.id),
    ),
    'first\r\nsecond\r\nb',
  );
  const large = 'a' + 'c'.repeat(99999),
    p = proposalFromReplacements(large, {
      path: 'a',
      replacements: [
        { oldText: 'a', newText: 'b'.repeat(100000) },
        { oldText: 'c'.repeat(99999), newText: '' },
      ],
    }).proposal;
  assert.throws(() => selectedProposal(large, p, [p.hunks[0].id]), /limit/);
});
test('live edit file boundary refuses traversal, metadata, credentials, links and invalid UTF-8', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ic-files-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'file.txt'), 'hello');
  await writeFile(join(root, '.env'), 'SYNTHETIC=test');
  await symlink(join(root, 'file.txt'), join(root, 'sym'));
  await link(join(root, 'file.txt'), join(root, 'hard'));
  await writeFile(join(root, 'invalid'), Buffer.from([0xff]));
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git', 'config'), 'fixture');
  for (const path of [
    '../outside',
    '.env',
    '.git/config',
    'sym',
    'hard',
    'file.txt',
    'invalid',
    '/etc/hosts',
    'a/../invalid',
    'a\\b',
  ])
    await assert.rejects(readWorkspaceText(root, path), path);
  await writeFile(join(root, '文.txt'), '甲\r\n');
  assert.equal((await readWorkspaceText(root, '文.txt')).text, '甲\r\n');
});
test('durable edit journal survives reopening and treats prepared records as uncertain until content reconciliation', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ic-journal-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'records'),
    journal = new EditJournal(directory, root);
  const record = await journal.prepare({
    path: 'file.txt',
    before: 'before',
    after: 'after',
    threadId: 'thread',
    turnId: 'turn',
    callId: 'call',
  });
  const reopened = new EditJournal(directory, root);
  assert.equal((await reopened.read(record.id)).state, 'prepared');
  assertRestoreText(record, 'after', 'before');
  assertRestoreText(record, 'after', 'after');
  assert.throws(() => assertRestoreText(record, 'manual', 'before'), /conflict/);
  assert.throws(() => assertRestoreText(record, 'after', 'manual'), /conflict/);
  await reopened.mark(record, 'applied');
  assert.equal((await journal.list())[0].state, 'applied');
  await reopened.mark(record, 'restored');
  assert.throws(() => assertRestoreText({ ...record, state: 'restored' }, 'after', 'after'));
  assert.equal((await readFile(join(directory, `${record.id}.json`), 'utf8')).includes('before'), true);
  await assert.rejects(reopened.read('../outside'));
});

test('shared context/file filter refuses standard credential files and private metadata directories', () => {
  for (const path of [
    '.netrc',
    '.git-credentials',
    '.npmrc',
    '.pypirc',
    'nested/.env.local',
    '.ssh/config',
    '.codex/config.toml',
    '.git/config',
    '.aws/credentials',
    '.kube/config',
    '.docker/config.json',
    'service-account.json',
    'credentials.yaml',
    'secrets.toml',
    'id_ecdsa',
    'terraform.tfstate.backup',
    'C:\\project\\.netrc',
  ])
    assert.equal(attachable(path), false, path);
  for (const path of ['src/main.ts', 'config.json', 'README.md', 'src/credentials.ts', 'assets/key.svg'])
    assert.equal(attachable(path), true, path);
});
