import type { DynamicToolSpec } from '../protocol/v2/DynamicToolSpec';

export const EDIT_TOOL = 'propose_text_edits';
export const editTool: DynamicToolSpec = {
  type: 'function',
  name: EDIT_TOOL,
  description:
    'Propose reviewable edits to one existing UTF-8 workspace file. Nothing changes until the user accepts selected replacements in the editor. Each oldText must match exactly once. Do not use shell or apply_patch to write files.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'replacements'],
    properties: {
      path: { type: 'string', description: 'Workspace-relative path to an existing text file.' },
      replacements: {
        type: 'array',
        minItems: 1,
        maxItems: 40,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['oldText', 'newText'],
          properties: { oldText: { type: 'string' }, newText: { type: 'string' } },
        },
      },
    },
  },
};

export const editInstructions =
  'This client keeps the runtime read-only. When the user enables Reviewed edits in Chat mode, use propose_text_edits for changes to existing workspace text files. The client holds each proposal before any editor mutation; the user may accept only some replacements. Use the tool result as the authority on what changed. Never assume rejected replacements were applied. Edits stay in editor buffers until saved by the user or their editor autosave. Do not bypass the tool with shell, apply_patch, MCP, permission escalation, or another writer. New files, deletion, renaming and binary editing are unsupported by this tool.';
