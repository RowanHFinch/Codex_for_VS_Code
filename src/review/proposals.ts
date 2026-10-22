import { createHash, randomUUID } from 'node:crypto';

export const contentHash = (text: string) => createHash('sha256').update(text).digest('hex');
export type ProposedHunk = { id: string; start: number; end: number; text: string };
export type Proposal = { baseHash: string; hunks: ProposedHunk[] };

export function proposalFromReplacements(base: string, input: unknown, eol = base.includes('\r\n') ? '\r\n' : '\n') {
  const a = input as { path?: unknown; replacements?: { oldText: unknown; newText: unknown }[] } | null;
  if (
    !a ||
    typeof a.path !== 'string' ||
    !Array.isArray(a.replacements) ||
    !a.replacements.length ||
    a.replacements.length > 40
  )
    throw new Error('Invalid edit proposal.');
  let size = 0;
  const hunks = a.replacements.map(r => {
    if (
      !r ||
      typeof r.oldText !== 'string' ||
      typeof r.newText !== 'string' ||
      r.oldText.length > 100_000 ||
      r.newText.length > 100_000 ||
      r.newText.includes('\0') ||
      Buffer.from(r.oldText).toString('utf8') !== r.oldText ||
      Buffer.from(r.newText).toString('utf8') !== r.newText
    )
      throw new Error('Invalid text replacement.');
    size += r.oldText.length + r.newText.length;
    const start = base.indexOf(r.oldText);
    if (
      size > 200_000 ||
      start === -1 ||
      (!r.oldText && base !== '') ||
      (r.oldText && base.indexOf(r.oldText, start + 1) !== -1)
    )
      throw new Error('Replacement must match the current text exactly once.');
    return { id: randomUUID(), start, end: start + r.oldText.length, text: r.newText.replace(/\r\n|\r|\n/g, eol) };
  });
  const proposal = { baseHash: contentHash(base), hunks };
  selectedProposal(
    base,
    proposal,
    hunks.map(h => h.id),
  );
  return { path: a.path, proposal };
}

export function selectedProposal(base: string, proposal: Proposal, accepted: string[]) {
  if (contentHash(base) !== proposal.baseHash) throw new Error('Proposal base changed');
  const ids = new Set(proposal.hunks.map(h => h.id));
  if (
    ids.size !== proposal.hunks.length ||
    new Set(accepted).size !== accepted.length ||
    accepted.some(id => !ids.has(id))
  )
    throw new Error('Invalid hunk identity');
  const sorted = [...proposal.hunks].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const h = sorted[i];
    if (!Number.isInteger(h.start) || !Number.isInteger(h.end) || h.start < 0 || h.end < h.start || h.end > base.length)
      throw new Error('Invalid hunk range');
    if ([h.start, h.end].some(offset => base[offset - 1] === '\r' && base[offset] === '\n'))
      throw new Error('Replacement splits a CRLF line ending');
    if (i && (h.start < sorted[i - 1].end || h.start === sorted[i - 1].start)) throw new Error('Overlapping hunks');
  }
  const after = sorted
    .filter(h => accepted.includes(h.id))
    .reverse()
    .reduce((text, h) => text.slice(0, h.start) + h.text + text.slice(h.end), base);
  if (after.length > 100_000 || after.includes('\0') || Buffer.from(after).toString('utf8') !== after)
    throw new Error('Selected edits exceed the valid UTF-8 text review limit');
  return after;
}
