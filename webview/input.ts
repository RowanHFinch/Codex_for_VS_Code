export function shouldSend(
  event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean; keyCode?: number },
  mode: 'enter' | 'modEnter',
) {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.shiftKey) return false;
  return mode === 'enter' || event.ctrlKey || event.metaKey;
}

export function mentionAt(text: string, cursor: number) {
  const match = /(?:^|\s)@([^\s@]{0,200})$/.exec(text.slice(0, cursor));
  return match ? { query: match[1], start: cursor - match[1].length - 1, end: cursor } : undefined;
}

export function composerTrigger(text: string, cursor: number) {
  const file = mentionAt(text, cursor);
  if (file) return { ...file, trigger: '@' as const };
  const match = /(?:^|\s)([$/])([^\s$@/]{0,200})$/.exec(text.slice(0, cursor));
  return match
    ? { query: match[2], start: cursor - match[2].length - 1, end: cursor, trigger: match[1] as '$' | '/' }
    : undefined;
}
