import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, relative } from 'node:path';

const runtime = process.argv[2] || 'codex';
const version = execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim();
if (version !== 'codex-cli 0.152.0') throw new Error('Protocol generation requires codex-cli 0.152.0');
const temp = mkdtempSync(join(tmpdir(), 'independent-codex-protocol-'));
const seeds = [
  'InitializeResponse',
  'ReasoningEffort',
  'CollaborationMode',
  ...[
    'GetAccountResponse',
    'Model',
    'ModelListResponse',
    'Thread',
    'ThreadItem',
    'Turn',
    'ThreadStartParams',
    'ThreadStartResponse',
    'ThreadResumeParams',
    'ThreadResumeResponse',
    'ThreadReadResponse',
    'ThreadListResponse',
    'ThreadTurnsListResponse',
    'ThreadItemsListResponse',
    'TurnStartParams',
    'TurnStartResponse',
    'ThreadForkResponse',
    'ToolRequestUserInputParams',
    'ToolRequestUserInputResponse',
    'FileChangeRequestApprovalParams',
    'CommandExecutionRequestApprovalParams',
    'PermissionsRequestApprovalResponse',
    'DynamicToolCallParams',
    'DynamicToolCallResponse',
    'ThreadSearchParams',
    'ThreadSearchResponse',
    'ThreadUnarchiveResponse',
  ].map(name => `v2/${name}`),
];
try {
  execFileSync(runtime, ['app-server', 'generate-ts', '--experimental', '--out', temp]);
  const copied = new Set();
  function copy(name) {
    const file = resolve(temp, name + '.ts');
    if (copied.has(file)) return;
    copied.add(file);
    const source = readFileSync(file, 'utf8');
    const target = join('src/protocol', relative(temp, file));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
    for (const match of source.matchAll(/from "(\.[^"]+)"/g)) copy(relative(temp, resolve(dirname(file), match[1])));
  }
  seeds.forEach(copy);
  console.log(`Generated ${copied.size} public protocol type files (${version}).`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
