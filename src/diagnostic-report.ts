/** Removes credentials, e-mail addresses, account/user/org identifiers and the home path before review. */
export function redact(text: string, home: string) {
  let out = text;
  // The plain home path and its JSON-escaped form (Windows backslashes), case-insensitively for drive letters.
  for (const form of home ? [home, home.replace(/\\/g, '\\\\')] : [])
    out = out.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '~');
  return out
    .replace(/\b(?:sk|rk|pk|rt)[-_][A-Za-z0-9_-]{8,}/g, '<redacted-key>')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '<redacted-jwt>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<redacted-email>')
    .replace(/(https?:\/\/[^\s?#"']+)\?[^\s#"']*/g, '$1?<redacted-query>')
    .replace(
      /((?:token|secret|password|api[_-]?key|(?:account|user|org|organization|workspace)[_-]?id)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      '$1<redacted>',
    );
}

export type ReportTab = {
  status: string;
  account: string;
  provider: string;
  runtimeVersion?: string;
  writable?: boolean;
  owned: boolean;
  diagnostics?: unknown;
  error?: string;
};

/** A local Markdown report the user reviews before deciding whether to share it anywhere. */
export function diagnosticReport(input: {
  extensionVersion: string;
  vscodeVersion: string;
  platform: string;
  arch: string;
  tabs: ReportTab[];
  log: string[];
  home: string;
}) {
  const lines = [
    '# Codex for VS Code diagnostic report',
    '',
    'Generated locally and not sent anywhere. Review it before sharing. Credentials, e-mail addresses,',
    'URL query strings and your home path were redacted; conversation text, memory and file contents are not included.',
    '',
    '## Environment',
    '',
    `- Extension: ${input.extensionVersion}`,
    `- VS Code: ${input.vscodeVersion}`,
    `- Platform: ${input.platform} ${input.arch}`,
    '',
    '## Chat tabs',
  ];
  input.tabs.forEach((tab, index) => {
    lines.push(
      '',
      `### Tab ${index + 1}`,
      '',
      `- Status: ${tab.status}`,
      `- Runtime: ${tab.runtimeVersion ?? 'not connected'}`,
      `- Sign-in mode: ${tab.account}`,
      `- Model provider: ${tab.provider}`,
      `- Chat: ${tab.owned ? 'owned here' : 'not owned here'}${tab.writable ? ', writable' : ', read-only'}`,
    );
    if (tab.diagnostics !== undefined) lines.push('', '```json', JSON.stringify(tab.diagnostics, null, 2), '```');
    if (tab.error) lines.push(`- Runtime diagnostics: unavailable (${tab.error})`);
  });
  lines.push('', '## Recent extension log', '', '```text', ...(input.log.length ? input.log : ['(empty)']), '```', '');
  return redact(lines.join('\n'), input.home);
}
