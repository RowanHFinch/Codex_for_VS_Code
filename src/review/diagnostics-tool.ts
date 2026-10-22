import type { DynamicToolSpec } from '../protocol/v2/DynamicToolSpec';

export const DIAGNOSTICS_TOOL = 'get_diagnostics';
export const diagnosticsTool: DynamicToolSpec = {
  type: 'function',
  name: DIAGNOSTICS_TOOL,
  description:
    'Read the current VS Code problems (errors and warnings from language servers and linters) for one workspace file, or for the whole workspace when path is omitted. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { path: { type: 'string', description: 'Optional workspace-relative file path.' } },
  },
};
