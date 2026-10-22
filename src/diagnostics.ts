import * as vscode from 'vscode';
import { isAbsolute, relative, resolve } from 'node:path';
import { truncate } from './shared';

const MAX = 200;
const severity = ['error', 'warning', 'info', 'hint'];

/** Text summary of VS Code problems inside `root`, for the read-only get_diagnostics tool. */
export function workspaceDiagnostics(root: string, args: unknown) {
  const requested =
    args && typeof args === 'object' && typeof (args as { path?: unknown }).path === 'string'
      ? (args as { path: string }).path
      : undefined;
  const target = requested ? resolve(root, requested) : undefined;
  if (target && relative(root, target).startsWith('..')) return 'Path is outside the workspace.';
  const lines: string[] = [];
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file') continue;
    const rel = relative(root, uri.fsPath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    if (target && uri.fsPath !== target) continue;
    for (const d of diagnostics) {
      if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
      if (lines.length === MAX) {
        lines.push(`… more problems omitted (limit ${MAX}).`);
        return lines.join('\n');
      }
      const source = d.source ? ` [${d.source}]` : '';
      lines.push(
        `${rel.split('\\').join('/')}:${d.range.start.line + 1}:${d.range.start.character + 1} ${severity[d.severity]}${source}: ${truncate(d.message.replace(/\s+/g, ' '), 500)}`,
      );
    }
  }
  return lines.length ? lines.join('\n') : 'No errors or warnings reported.';
}
