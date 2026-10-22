import type { ResponseAnnotation } from './annotations';
import type { ReasoningEffort } from './protocol/ReasoningEffort';
import type { Model } from './protocol/v2/Model';
import type { ToolRequestUserInputParams } from './protocol/v2/ToolRequestUserInputParams';
import type { AskForApproval } from './protocol/v2/AskForApproval';
import type { ApprovalsReviewer } from './protocol/v2/ApprovalsReviewer';
import type { FormField, FormValue } from './runtime/elicitation';

export type Locale = 'en' | 'zh-CN';
export type RunState =
  | 'offline'
  | 'connecting'
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'interrupting'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'unknown';
export type TimelineItem = {
  id: string;
  turnId: string;
  type: string;
  text: string;
  status?: string;
  truncated?: boolean;
  title?: string;
  detail?: string;
  durationMs?: number;
  exitCode?: number;
  phase?: 'commentary' | 'final_answer';
  summaryIndex?: number;
};
export type FileChoice = { id: string; path: string };
export type SkillChoice = { id: string; name: string; description: string; scope: string; enabled: boolean };
export type McpChoice = {
  id: string;
  name: string;
  transport: string;
  scope: string;
  enabled: boolean;
  allowed: boolean;
  status: string;
  auth: string;
  tools: string[];
  editable: boolean;
};
export type IntegrationState = {
  skills: SkillChoice[];
  servers: McpChoice[];
  loading: boolean;
  uncertain: boolean;
  notice?: string;
};
export type AuthState = {
  kind: 'mcp';
  name?: string;
  status: 'pending' | 'success' | 'failed' | 'unknown';
};
export type MemoryState = {
  files: { id: string; path: string; bytes: number; updatedAt: number }[];
  loading: boolean;
  limited: boolean;
  selected?: { id: string; path: string; text: string };
};
export type AgentState = {
  uncertain?: boolean;
  busy?: boolean;
  tasks: { id: string; parentId: string; title: string; role: string; status: string; turnId?: string }[];
  loading: boolean;
  limited: boolean;
  selected?: { id: string; items: TimelineItem[]; cursor: string | null };
};
export type EcosystemState = {
  features: { name: string; enabled: boolean }[];
  hooks: {
    id: string;
    event: string;
    source: string;
    enabled: boolean;
    managed: boolean;
    supported: boolean;
    trust: string;
  }[];
  plugins: { id: string; name: string; description: string; enabled: boolean; installed: boolean }[];
  agents: { id: string; name: string; scope: string }[];
  loading: boolean;
  notice?: string;
};
export type FileResult =
  | { type: 'fileResults'; requestId: string; files: FileChoice[]; limited: boolean; failed?: boolean }
  | { type: 'fileAttached' | 'skillAttached'; id: string; ok: boolean };
export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  owned: boolean;
  bookmarked: boolean;
  snippet?: string;
};
export type ContextEntry = {
  id: string;
  label: string;
  text: string;
  uri: string;
  version: number;
  startLine: number;
  endLine: number;
  kind?: 'file' | 'selection';
  path?: string;
};
export type ActiveEditor = {
  id: string;
  label: string;
  path: string;
  startLine: number;
  endLine: number;
  selected: boolean;
};
export type Decision = {
  id: string | number;
  token: string;
  kind: 'blocked' | 'approval' | 'question';
  threadId: string;
  turnId: string;
  itemId: string;
  method: string;
  questions?: ToolRequestUserInputParams['questions'];
  form?: { serverName: string; message: string; fields: FormField[] };
  summary?: string;
  canAccept?: boolean;
  scope?: 'request' | 'turn' | 'session';
  truncated?: boolean;
  reason?: string;
  command?: string;
  cwd?: string;
  changes?: import('./review/patch').ChangeSummary[];
  options?: ('accept' | 'acceptForSession' | 'decline' | 'cancel')[];
};
export type EditReview = { id: string; path: string; hunks: { id: string; before: string; after: string }[] };
export type ViewState = {
  operationBusy?: boolean;
  writable?: boolean;
  locale: Locale;
  sendKey: 'enter' | 'modEnter';
  status: RunState;
  runtimeVersion?: string;
  /** How the native CLI is signed in; this client never chooses or switches it. */
  account: 'unknown' | 'chatgpt' | 'apiKey' | 'provider' | 'unavailable';
  accountReadFailed?: boolean;
  models: Model[];
  model: string;
  /** Set when the configured model is not in the CLI catalog and the catalog default is used instead. */
  modelFallback?: { requested: string; used: string };
  effort: ReasoningEffort;
  mode: 'default' | 'plan';
  threadId?: string;
  owned: boolean;
  title: string;
  permission: 'read-only' | 'reviewed' | 'agent';
  review?: EditReview;
  profiles?: { id: string; description: string | null; allowed: boolean }[];
  profile?: string;
  approval?: AskForApproval;
  reviewer?: ApprovalsReviewer;
  nativeReady?: boolean;
  memoryEnabled?: boolean;
  memoryAvailable?: boolean;
  queued?: { id: string; text: string }[];
  items: TimelineItem[];
  /** Files changed per turn, from native turn diffs or completed history items. */
  turnChanges?: Record<string, { path: string; added: number; removed: number }[]>;
  sessions: SessionSummary[];
  sessionsCursor: string | null;
  historyCursor: string | null;
  decisions: Decision[];
  contexts: ContextEntry[];
  annotations?: ResponseAnnotation[];
  draft: string;
  /** Changes only when the host itself replaces `draft`; keystroke echoes leave it alone. */
  draftEpoch?: number;
  sessionsSearch: string;
  sessionsArchived: boolean;
  sessionsSearching?: boolean;
  activeEditor?: ActiveEditor;
  editorContextPending?: boolean;
  editorContextUnavailable?: boolean;
  channelId?: string;
  tabs?: import('./sessions/tabs').SessionTab[];
  groups?: import('./sessions/tabs').SessionGroup[];
  groupAssignments?: Record<string, string>;
  integrations?: IntegrationState;
  integrationBusy?: boolean;
  integrationMutationBusy?: boolean;
  selectedSkills?: { id: string; name: string }[];
  /** A temporary read-only fork for side questions; it never changes the main chat. */
  side?: {
    threadId: string;
    parentId: string;
    turnId?: string;
    items: TimelineItem[];
    status: RunState;
    error?: string;
  };
  /** The agent's own background terminals in the open chat, as listed by the runtime. */
  terminals?: {
    loading: boolean;
    error?: string;
    items: {
      processId: string;
      command: string;
      cwd: string;
      osPid: number | null;
      cpuPercent: number | null;
      rssKb: number | null;
    }[];
  };
  /** First-run checklist state. */
  /** Set when no folder is open: chats run in this generated folder, like the official projectless chats. */
  projectless?: string;
  /** Dictation state; the transcript goes into the draft and is never sent automatically. */
  voice?: { status: 'starting' | 'recording' | 'transcribing' | 'idle'; error?: string; annotationId?: string };
  /** Images pasted into this chat's draft; bytes stay in the extension host. */
  images?: { id: string; name: string }[];
  enabledMcp?: string[];
  ecosystem?: EcosystemState;
  agents?: AgentState;
  memories?: MemoryState;
  auth?: AuthState;
  usage?: import('./runtime/usage').AccountUsage;
  tokenUsage?: import('./runtime/usage').TokenUsage;
  notice?: string;
  error?: string;
};
export type Action =
  | {
      type:
        'refreshAgents' | 'closeAgentOutput' | 'browseMemories' | 'closeMemory' | 'closeMemoryPreview' | 'refreshUsage';
    }
  | { type: 'agentOutput' | 'moreAgentOutput' | 'stopAgent' | 'readMemory'; id: string }
  | {
      type:
        | 'ready'
        | 'connect'
        | 'new'
        | 'newReviewed'
        | 'continue'
        | 'fork'
        | 'refresh'
        | 'moreSessions'
        | 'moreHistory'
        | 'cancel'
        | 'logs'
        | 'attach'
        | 'instructions'
        | 'checkpoints'
        | 'settings'
        | 'diagnostics'
        | 'worktree'
        | 'voiceStop'
        | 'attachImage'
        | 'setGoal';
    }
  | { type: 'send'; text: string; threadId: string | null; contextId: string | null }
  | { type: 'draft'; text: string; threadId: string | null }
  | { type: 'open'; threadId: string }
  | { type: 'bookmark' | 'unarchive' | 'archive' | 'closeChat'; threadId: string }
  | { type: 'rename'; threadId: string; title: string }
  | { type: 'search'; text: string; archived: boolean; deep?: boolean }
  | { type: 'permission'; value: 'read-only' | 'reviewed' }
  | { type: 'reviewApply' | 'reviewPreview'; id: string; accepted: string[] }
  | { type: 'configure'; model: string; effort: ReasoningEffort; mode: 'default' | 'plan' }
  | {
      type: 'nativePolicy';
      profile?: string;
      approval?: 'on-request' | 'never' | 'untrusted';
      reviewer?: 'user' | 'auto_review';
    }
  | { type: 'memory'; enabled: boolean }
  | { type: 'permissionMode'; value: 'review' | 'ask' | 'auto' | 'full' | 'plan' }
  | { type: 'followup'; text: string; threadId: string; delivery: 'queue' | 'steer' }
  | { type: 'removeQueued'; id: string }
  | { type: 'refreshEcosystem' | 'browsePlugins' | 'newAgent' }
  | { type: 'openEcosystem'; id: string }
  | { type: 'trustHook'; id: string }
  | { type: 'removePlugin'; id: string }
  | { type: 'hookToggle'; id: string; enabled: boolean }
  | { type: 'pluginToggle'; id: string; enabled: boolean }
  | { type: 'ecosystemFeature'; name: 'hooks' | 'plugins' | 'multi_agent' | 'memories'; enabled: boolean }
  | { type: 'addAnnotation'; threadId: string; annotation: ResponseAnnotation }
  | { type: 'commentAnnotation'; threadId: string; id: string; text: string }
  | { type: 'removeAnnotation'; threadId: string; id: string }
  | { type: 'removeContext'; id: string }
  | { type: 'findFiles'; requestId: string; query: string }
  | { type: 'newTab' | 'addGroup' | 'addMcp' | 'reconnectMcp' | 'openMcpConfig' }
  | { type: 'refreshIntegrations'; requestId: string }
  | { type: 'selectTab' | 'closeTab'; id: string }
  | { type: 'group'; id: string; operation: 'rename' | 'remove' | 'up' | 'down' | 'collapse'; collapsed?: boolean }
  | { type: 'assignGroup'; id: string; groupId: string | null }
  | { type: 'skillToggle'; id: string; enabled: boolean }
  | { type: 'selectSkill' | 'removeSkill' | 'openSkill' | 'mcpRemove' | 'mcpLogin' | 'removeImage'; id: string }
  | { type: 'pasteImage'; id: string; name: string; data: string; threadId: string | null }
  | { type: 'sideAsk'; threadId: string; text: string }
  | { type: 'voiceCancel'; annotationId?: string; threadId?: string }
  | { type: 'voiceOffer'; sdp: string; annotationId?: string; threadId?: string }
  | { type: 'sideClose' }
  | { type: 'refreshTerminals' }
  | { type: 'stopAllTerminals' }
  | { type: 'stopTerminal'; id: string }
  | { type: 'mcpToggle'; id: string; enabled: boolean }
  | { type: 'attachFile'; id: string; threadId: string | null }
  | {
      type: 'decision';
      id: string | number;
      token: string;
      cancel?: boolean;
      accept?: boolean;
      answers?: Record<string, { answers: string[] }>;
      content?: Record<string, FormValue>;
      session?: boolean;
    }
  | { type: 'openChange'; id: string | number; token: string; path: string }
  | { type: 'openTurnFile'; turnId: string; path: string }
  | { type: 'openTurnChanges'; turnId: string }
  | { type: 'undoTurn' | 'rewind'; turnId: string }
  | { type: 'copy'; itemId: string }
  | { type: 'planOpen' | 'planProceed'; itemId: string }
  | { type: 'export'; threadId: string; destination: 'clipboard' | 'document' }
  | { type: 'link'; url: string };

/** Display only: the runtime itself decides whether its sign-in can serve a turn. */
export function accountMode(response: { account: { type: string } | null; requiresOpenaiAuth: boolean } | undefined) {
  const type = response?.account?.type;
  if (type === 'chatgpt' || type === 'apiKey') return type;
  // A configured provider that needs no OpenAI sign-in (Bedrock, custom endpoint) authenticates itself.
  return type === 'amazonBedrock' || response?.requiresOpenaiAuth === false ? 'provider' : 'unavailable';
}
export const signedIn = (account: ViewState['account']) => account !== 'unknown' && account !== 'unavailable';
export const busy = (status: RunState) =>
  ['connecting', 'starting', 'running', 'waiting', 'interrupting'].includes(status);
/** Cuts to at most `max` UTF-16 units without splitting a surrogate pair; the runtime rejects lone surrogates. */
export function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  return /[\uD800-\uDBFF]/.test(text[max - 1]) ? text.slice(0, max - 1) : text.slice(0, max);
}
