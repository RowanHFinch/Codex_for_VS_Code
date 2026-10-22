import type { DynamicToolSpec } from '../protocol/v2/DynamicToolSpec';

export const TITLE_TOOL = 'set_chat_title';
export function fallbackTitle(text: string) {
  return text
    .split(/\s*(?:--- Selected code:|\[Referenced file:)/)[0]
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60);
}

export const titleTool: DynamicToolSpec = {
  type: 'function',
  name: TITLE_TOOL,
  description:
    "Before your first answer in a new chat, call this once to give the conversation a short descriptive title in the user's language. Summarize the user's goal, rather than quoting their message. This changes only the chat title; it does not edit files. Do not call again after a title has been set.",
  inputSchema: {
    type: 'object',
    properties: { title: { type: 'string', minLength: 1, maxLength: 80 } },
    required: ['title'],
    additionalProperties: false,
  },
};

export function chatTitle(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return;
  const title = (args as { title?: unknown }).title;
  if (typeof title !== 'string' || !title.trim() || title.length > 80 || /[\x00-\x1f\x7f]/.test(title)) return;
  return title.trim();
}
