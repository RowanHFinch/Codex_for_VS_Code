import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, selectedProposal } from '../src/review/proposals';

test('pure proposal decisions reject B before any disk write and retain CRLF/Unicode', () => {
  const base = '甲\r\nsecond\r\n';
  const p = {
    baseHash: contentHash(base),
    hunks: [
      { id: 'A', start: 0, end: 1, text: '乙' },
      { id: 'B', start: 3, end: 9, text: 'changed' },
    ],
  };
  assert.equal(selectedProposal(base, p, []), base);
  assert.equal(selectedProposal(base, p, ['A']), '乙\r\nsecond\r\n');
  assert.throws(() => selectedProposal('manual edit', p, ['A']));
  assert.throws(() =>
    selectedProposal(base, { ...p, hunks: [...p.hunks, { id: 'C', start: 0, end: 3, text: '' }] }, ['A']),
  );
  assert.throws(() => selectedProposal(base, p, ['unknown']));
});
