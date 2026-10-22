import { annotationContext, validAnnotation, type ResponseAnnotation } from '../annotations';
import { authorizationUrl } from '../runtime/auth';
import { accountUsage, tokenUsage } from '../runtime/usage';
import { elicitationFields, validateElicitation, type FormValue } from '../runtime/elicitation';
import { AgentTasks } from './agents';
import { exportMessages } from './export';
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { realpath } from 'node:fs/promises';
import type { RuntimeClient, RpcMessage } from '../runtime/client';
import { DeliveryError, THREAD_NOT_FOUND } from '../runtime/client';
import { appendDelta, appendReasoningDelta, timelineItem, upsertItem, turnErrorMessage } from '../runtime/events';
import { accountMode, busy, truncate, type Decision, type ViewState } from '../shared';
import type { Thread } from '../protocol/v2/Thread';
import type { ThreadItem } from '../protocol/v2/ThreadItem';
import type { ThreadStartResponse } from '../protocol/v2/ThreadStartResponse';
import type { ThreadResumeResponse } from '../protocol/v2/ThreadResumeResponse';
import type { ThreadReadResponse } from '../protocol/v2/ThreadReadResponse';
import type { ThreadListResponse } from '../protocol/v2/ThreadListResponse';
import type { ThreadTurnsListResponse } from '../protocol/v2/ThreadTurnsListResponse';
import type { ThreadItemsListResponse } from '../protocol/v2/ThreadItemsListResponse';
import type { TurnStartParams } from '../protocol/v2/TurnStartParams';
import type { TurnStartResponse } from '../protocol/v2/TurnStartResponse';
import type { ModelListResponse } from '../protocol/v2/ModelListResponse';
import type { GetAccountResponse } from '../protocol/v2/GetAccountResponse';
import { EDIT_TOOL, editTool, editInstructions } from '../review/tool';
import type { DynamicToolCallParams } from '../protocol/v2/DynamicToolCallParams';
import type { DynamicToolCallResponse } from '../protocol/v2/DynamicToolCallResponse';
import type { ThreadSearchResponse } from '../protocol/v2/ThreadSearchResponse';
import { restrictedThreadConfig, type RuntimeSettings } from '../runtime/settings';
import type { FileUpdateChange } from '../protocol/v2/FileUpdateChange';
import { summarize, turnDiffFiles } from '../review/patch';
import { DIAGNOSTICS_TOOL, diagnosticsTool } from '../review/diagnostics-tool';
import { TITLE_TOOL, titleTool, chatTitle, fallbackTitle } from './title';

export type SessionStore = {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
};
export type SessionMetadata = { owned: Set<string>; reviewed: Set<string>; bookmarks: Set<string> };
/** Host integrations that need VS Code or the filesystem; all optional so tests can omit them. */
export type CoordinatorHooks = {
  fileChange?(
    phase: 'started' | 'completed',
    threadId: string,
    turnId: string,
    item: ThreadItem & { type: 'fileChange' },
  ): void;
  settled?(token: string): void;
  fileApproval?(id: string | number, token: string, changes: FileUpdateChange[]): void;
  diagnostics?(args: unknown): Promise<string>;
};
/** Runtime numbers are untrusted display data; anything else becomes unknown. */
const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
/** Side-effect-free requests: a timeout leaves nothing to reconcile, so it never closes the runtime. */
const READS = new Set([
  'account/read',
  'config/read',
  'model/list',
  'permissionProfile/list',
  'thread/list',
  'thread/read',
  'thread/search',
  'thread/turns/list',
  'thread/items/list',
  'thread/queue/list',
]);
export class Coordinator {
  state: ViewState;
  private accountReadGeneration = 0;
  agents: AgentTasks;
  private routing = new Map<string | number, { resolved: boolean }>();
  private client?: RuntimeClient;
  private activeTurn?: string;
  private owned: Set<string>;
  private operation = false;
  private ready = false;
  private hydration = false;
  private historyLoad?: Promise<void>;
  private uncertainWork = false;
  get unresolvedWork() {
    return this.uncertainWork;
  }
  private deferred: RpcMessage[] = [];
  private reviews = new Map<string | number, AbortController>();
  private reviewedThreads: Set<string>;
  private allowEdits = false;
  private bookmarks: Set<string>;
  private listing = 0;
  private deepSearch = false;
  private draftRevision = 0;
  private disposed = false;
  private nativeRequests = new Map<string, any>();
  private defaults?: RuntimeSettings;
  private historyWatch?: FSWatcher;
  private sideBusy = false;
  private loadedThread?: string;
  private named = false;
  private fileChanges = new Map<string, FileUpdateChange[]>();
  constructor(
    private cwd: string,
    private store: SessionStore,
    private changed: () => void,
    private beforeSend: (contexts: ViewState['contexts']) => Promise<void>,
    private log: (message: string) => void,
    private review?: (call: DynamicToolCallParams, signal: AbortSignal) => Promise<DynamicToolCallResponse>,
    metadata?: SessionMetadata,
    private hooks: CoordinatorHooks = {},
  ) {
    this.owned = metadata?.owned ?? new Set(store.get<string[]>('owned', []));
    this.reviewedThreads = metadata?.reviewed ?? new Set(store.get<string[]>('reviewedThreads', []));
    this.bookmarks = metadata?.bookmarks ?? new Set(store.get<string[]>('bookmarks', []));
    const last = store.get<string | undefined>('lastThread', undefined);
    this.state = {
      locale: 'en',
      sendKey: 'enter',
      status: 'offline',
      account: 'unknown',
      models: [],
      model: '',
      effort: 'low',
      mode: 'default',
      permission: 'read-only',
      threadId: last,
      owned: Boolean(last && this.owned.has(last)),
      title: '',
      items: [],
      sessions: [],
      sessionsCursor: null,
      historyCursor: null,
      decisions: [],
      contexts: [],
      draft: store.get(`draft.${last ?? 'new'}`, store.get('draft', '')),
      sessionsSearch: '',
      sessionsArchived: false,
    };
    this.agents = new AgentTasks(
      this,
      cwd,
      () => this.state.threadId,
      () => {
        this.state.agents = this.agents.state;
        this.update();
      },
      () => this.provider,
    );
    this.state.agents = this.agents.state;
  }
  /** The configured model provider; threads from other providers cannot resume on this runtime. */
  get provider() {
    return this.defaults?.provider ?? 'openai';
  }
  update() {
    this.changed();
  }
  setError(error: unknown) {
    this.state.error = error instanceof Error ? error.message : 'Operation failed';
    this.log(this.state.error);
    this.update();
  }
  async attach(client: RuntimeClient, version: string, defaults?: RuntimeSettings) {
    const generation = ++this.accountReadGeneration;
    if (this.disposed) {
      client.stop();
      throw new Error('Chat tab closed.');
    }
    if (this.historyLoad) {
      this.client?.stop();
      await this.historyLoad.catch(() => {});
    }
    this.ready = false;
    this.state.account = 'unknown';
    this.state.accountReadFailed = false;
    this.state.usage = undefined;
    this.state.tokenUsage = undefined;
    this.uncertainWork ||= this.agents.active;
    this.agents.reset();
    this.state.agents = this.agents.state;
    this.routing.clear();
    this.abortReviews();
    this.state.side = undefined;
    await this.client?.shutdown();
    if (this.disposed) {
      client.stop();
      throw new Error('Chat tab closed during connection.');
    }
    this.client = client;
    this.state.status = 'connecting';
    this.loadedThread = undefined;
    this.defaults = defaults;
    this.state.runtimeVersion = version;
    client.on('notification', message => {
      if (this.client !== client) return;
      if (this.hydration) this.deferred.push(message);
      else this.notification(message);
    });
    client.on('request', message => {
      if (this.client === client)
        void this.serverRequest(message).catch(() => {
          if (this.client === client) {
            client.stop();
            this.state.error = 'Runtime request could not be safely routed. Reconnect first.';
            this.update();
          }
        });
    });
    client.on('disconnect', () => {
      if (this.client !== client) return;
      this.uncertainWork ||= Boolean(
        this.activeTurn || (this.state.status === 'starting' && this.state.writable) || this.agents.active,
      );
      this.ready = false;
      this.state.account = 'unknown';
      this.state.usage = undefined;
      this.state.tokenUsage = undefined;
      this.state.writable = false;
      this.abortReviews();
      this.state.status = 'unknown';
      this.state.decisions = [];
      this.state.error = 'Runtime disconnected. Reconnect and reload history; the last request will not be replayed.';
      this.activeTurn = undefined;
      this.update();
    });
    try {
      const [models, profiles] = await Promise.all([
        client.request<ModelListResponse>('model/list', { limit: 100, includeHidden: false }),
        defaults ? this.loadProfiles(client) : Promise.resolve([]),
        this.listSessions(),
      ]);
      this.state.models = models.data.filter(m => !m.hidden);
      const saved = this.store.get<Partial<ViewState>>(`preferences.${this.state.threadId ?? 'new'}`, {});
      const selected = saved.model ?? defaults?.model ?? this.state.model;
      const model =
        this.state.models.find(m => m.model === selected) ??
        this.state.models.find(m => m.isDefault) ??
        this.state.models[0];
      this.state.model = selected || model?.model || '';
      this.state.effort =
        saved.effort ??
        defaults?.effort ??
        (selected && selected === model?.model ? this.state.effort : undefined) ??
        model?.defaultReasoningEffort ??
        'medium';
      // A configured model missing from this CLI's catalog (usually an older CLI) falls back to the
      // catalog default for this client only, with a visible notice. Unsupported efforts still fail closed.
      this.state.modelFallback = undefined;
      if (selected && model && !this.state.models.some(m => m.model === selected)) {
        this.state.modelFallback = { requested: selected, used: model.displayName || model.model };
        this.state.model = model.model;
        if (!model.supportedReasoningEfforts.some(e => e.reasoningEffort === this.state.effort))
          this.state.effort = model.defaultReasoningEffort;
      }
      this.state.mode = saved.mode ?? 'default';
      this.state.nativeReady = false;
      if (defaults) {
        this.state.profiles = profiles;
        this.state.profile = saved.profile ?? defaults.profile;
        this.state.approval = saved.approval ?? defaults.approval;
        this.state.reviewer = saved.reviewer ?? defaults.reviewer;
        this.state.memoryAvailable = defaults.memories;
        this.state.nativeReady = true;
        if (!this.state.threadId) this.state.permission = 'agent';
      }
      this.state.error = undefined;
      this.state.status = 'idle';
      this.update();
      if (this.state.threadId)
        try {
          await this.openThread(this.state.threadId);
        } catch (error) {
          // A chat that never got a message is not persisted, so after a restart the runtime no longer
          // knows it. Nothing was sent; start empty instead of reporting an unknown outcome.
          if (
            !(error instanceof DeliveryError) ||
            error.delivery !== 'rejected' ||
            error.method !== 'thread/read' ||
            !error.message.endsWith(THREAD_NOT_FOUND)
          )
            throw error;
          await this.clearView();
          this.state.status = 'idle';
          if (this.state.nativeReady) this.state.permission = 'agent';
        }
      if (this.uncertainWork && this.state.threadId) {
        await this.agents.refresh();
        for (const task of this.agents.state.tasks) await this.agents.activeTurn(task.id);
        if (this.agents.active || this.agents.state.limited || this.agents.state.uncertain)
          throw new Error(
            'Child tasks are still active or unresolved. Stop them in their owning client before reconnecting.',
          );
      }
      this.uncertainWork = false;
      this.ready = true;
      this.update();
      // Account metadata is display-only and can take seconds; native requests enforce authentication.
      void client.request<GetAccountResponse>('account/read', { refreshToken: false }).then(
        account => {
          if (generation !== this.accountReadGeneration || this.client !== client || this.disposed || !client.connected)
            return;
          this.state.account = accountMode(account);
          this.state.accountReadFailed = false;
          this.update();
        },
        () => {
          if (generation !== this.accountReadGeneration || this.client !== client || this.disposed || !client.connected)
            return;
          this.state.accountReadFailed = true;
          this.update();
        },
      );
    } catch (e) {
      client.stop();
      this.state.account = 'unknown';
      this.state.status = this.state.threadId ? 'unknown' : 'offline';
      throw e;
    }
  }
  private async loadProfiles(client: RuntimeClient) {
    const profiles: NonNullable<ViewState['profiles']> = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { data: NonNullable<ViewState['profiles']>; nextCursor?: string | null } = await client.request(
        'permissionProfile/list',
        { cwd: this.cwd, cursor, limit: 100 },
      );
      profiles.push(...page.data);
      cursor = page.nextCursor ?? null;
      if (cursor && (seen.has(cursor) || seen.size >= 100))
        throw new Error('Permission profile pagination did not advance or exceeded its limit.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return profiles;
  }
  private runtime() {
    if (!this.client?.connected) throw new Error('Connect to Codex first.');
    return this.client;
  }
  private async exclusive<T>(action: () => Promise<T>) {
    if (this.operation || this.hydration || busy(this.state.status))
      throw new Error('Wait for the active operation to finish.');
    this.operation = true;
    this.state.operationBusy = true;
    this.update();
    try {
      return await action();
    } catch (error) {
      if (error instanceof DeliveryError && error.delivery === 'unknown' && !READS.has(error.method)) {
        this.state.writable = false;
        this.client?.stop();
        this.state.status = 'unknown';
      }
      throw error;
    } finally {
      this.operation = false;
      this.state.operationBusy = false;
      this.update();
    }
  }
  /** Read-only thread overrides, including every configured MCP server switched off. */
  private get restrictedConfig() {
    return restrictedThreadConfig(this.defaults?.mcpServers);
  }
  /** `deep` searches message text with thread/search; otherwise the term only filters titles. */
  async listSessions(
    more = false,
    search = this.state.sessionsSearch,
    archived = this.state.sessionsArchived,
    deep = more && this.deepSearch,
  ) {
    if (more && !this.state.sessionsCursor) return;
    const client = this.runtime();
    const revision = ++this.listing;
    this.state.sessionsSearch = search;
    this.state.sessionsArchived = archived;
    this.deepSearch = deep && Boolean(search.trim());
    const params = {
      limit: 30,
      cursor: more ? this.state.sessionsCursor : null,
      sortKey: 'updated_at' as const,
      archived,
    };
    if (!more) this.state.sessionsCursor = null;
    // Message search reads every rollout (seconds), so the view shows it is still working.
    this.state.sessionsSearching = this.deepSearch;
    if (this.deepSearch) this.update();
    let result: ThreadSearchResponse | ThreadListResponse;
    try {
      result = this.deepSearch
        ? await this.runtime().request<ThreadSearchResponse>('thread/search', { ...params, searchTerm: search.trim() })
        : await this.runtime().request<ThreadListResponse>('thread/list', {
            ...params,
            cwd: this.cwd,
            modelProviders: [this.provider],
            searchTerm: search.trim() || null,
            // The default scan-and-repair reads every rollout file: 8+ s with a few GB of sessions, which
            // stalled new chats and tabs. The state DB answers the same page in milliseconds (0.152+).
            useStateDbOnly: true,
          });
    } finally {
      if (revision === this.listing && this.state.sessionsSearching) {
        this.state.sessionsSearching = false;
        this.update();
      }
    }
    const entries = result.data.map(entry => ('thread' in entry ? entry : { thread: entry, snippet: undefined }));
    const scoped = [];
    const roots = new Map<string, Promise<string>>();
    for (const entry of entries) {
      if (entry.thread.modelProvider !== this.provider) continue;
      try {
        if (!roots.has(entry.thread.cwd)) roots.set(entry.thread.cwd, realpath(entry.thread.cwd));
        if ((await roots.get(entry.thread.cwd)) === this.cwd) scoped.push(entry);
      } catch {
        /* Missing foreign workspace paths are not results for this workspace. */
      }
    }
    if (revision !== this.listing || this.client !== client || this.disposed || !client.connected) return;
    const sessions = scoped.map(({ thread: t, snippet }) => ({
      id: t.id,
      title: truncate(t.name || fallbackTitle(t.preview || ''), 200),
      updatedAt: t.updatedAt,
      owned: this.owned.has(t.id),
      bookmarked: this.bookmarks.has(t.id),
      snippet: snippet && (snippet.length > 500 ? truncate(snippet, 500) + '…' : snippet),
    }));
    this.state.sessions = more
      ? [...new Map([...this.state.sessions, ...sessions].map(s => [s.id, s])).values()]
      : sessions;
    this.state.sessionsCursor = result.nextCursor;
    this.update();
  }
  async exportConversation(id: string) {
    return this.exclusive(async () => {
      if (id !== this.state.threadId || this.agents.active) throw new Error('Choose an idle chat before exporting.');
      const client = this.runtime();
      const before = await client.request<ThreadReadResponse>('thread/read', { threadId: id, includeTurns: false });
      await this.checkWorkspace(before.thread);
      if (before.thread.status.type === 'active') throw new Error('Finish active work before exporting.');
      const result = await exportMessages(
        client.request.bind(client),
        id,
        before.thread.name || before.thread.preview || id,
      );
      const after = await client.request<ThreadReadResponse>('thread/read', { threadId: id, includeTurns: false });
      await this.checkWorkspace(after.thread);
      if (
        this.client !== client ||
        !client.connected ||
        this.state.threadId !== id ||
        after.thread.status.type === 'active' ||
        after.thread.updatedAt !== before.thread.updatedAt
      )
        throw new Error('Chat changed while exporting. No partial export was created.');
      return result;
    });
  }
  private async checkWorkspace(thread: Thread) {
    if ((await realpath(thread.cwd)) !== this.cwd || thread.modelProvider !== this.provider)
      throw new Error('Thread belongs to a different workspace or provider.');
  }
  private ensureReadonly(response: ThreadStartResponse | ThreadResumeResponse) {
    if (
      response.sandbox.type !== 'readOnly' ||
      response.sandbox.networkAccess ||
      response.approvalPolicy !== 'never' ||
      response.modelProvider !== this.provider
    ) {
      this.client?.stop();
      throw new Error('Runtime did not honor the read-only policy. Connection closed.');
    }
  }
  private async unload(next?: string) {
    if (!this.loadedThread || this.loadedThread === next) return;
    if (this.agents.state.tasks.some(t => ['running', 'active', 'pendingInit'].includes(t.status)))
      throw new Error('Stop or finish child agents before switching this runtime to another chat.');
    const id = this.loadedThread;
    await this.runtime().request('thread/unsubscribe', { threadId: id });
    // Some runtimes close an unsubscribed thread (and its writer lock) about a minute later; 0.152 keeps it until exit.
    this.loadedThread = undefined;
    this.state.writable = false;
  }
  async newThread(reviewed = !this.state.nativeReady) {
    return this.exclusive(async () => {
      if (!this.ready || this.state.status === 'unknown')
        throw new Error('Wait for connection and history reconciliation.');
      await this.setDraft(this.state.draft);
      await this.unload();
      if (!reviewed) await this.beforeSend([]);
      const result = await this.runtime().request<ThreadStartResponse>('thread/start', {
        cwd: this.cwd,
        model: this.state.model,
        ...(reviewed
          ? {
              sandbox: 'read-only' as const,
              approvalPolicy: 'never' as const,
              approvalsReviewer: 'user' as const,
              dynamicTools: [editTool, titleTool],
              config: this.restrictedConfig,
            }
          : {
              ...this.nativePolicy(),
              dynamicTools: [...(this.hooks.diagnostics ? [diagnosticsTool] : []), titleTool],
            }),
      });
      if (reviewed) this.ensureReadonly(result);
      await this.checkWorkspace(result.thread);
      this.loadedThread = result.thread.id;
      this.owned.add(result.thread.id);
      await this.store.update('owned', [...this.owned]);
      if (reviewed) {
        this.reviewedThreads.add(result.thread.id);
        await this.store.update('reviewedThreads', [...this.reviewedThreads]);
      }
      await this.selectThread(result.thread);
      this.state.permission = reviewed ? 'read-only' : 'agent';
      this.state.writable = true;
      this.state.memoryEnabled = undefined;
      await this.savePreferences();
      this.state.items = [];
      this.state.historyCursor = null;
      this.state.decisions = [];
      this.state.status = 'idle';
      this.state.error = undefined;
      void this.listSessions().catch(() => this.log('Session list refresh failed; refresh History to retry.'));
    });
  }
  async openThread(id: string) {
    return this.exclusive(async () => {
      this.state.status = 'starting';
      this.state.error = undefined;
      this.activeTurn = undefined;
      this.update();
      try {
        const result = await this.runtime().request<ThreadReadResponse>('thread/read', {
          threadId: id,
          includeTurns: false,
        });
        await this.checkWorkspace(result.thread);
        if (this.uncertainWork && result.thread.status.type === 'active')
          throw new Error('The previous task is still active. Stop it in its owning client before reconnecting.');
        await this.setDraft(this.state.draft);
        await this.unload(id);
        await this.selectThread(result.thread);
        this.state.items = [];
        this.state.decisions = [];
        this.state.error = undefined;
        this.state.writable = false;
        await this.loadHistory(false);
        if (this.activeTurn) throw new Error('Thread became active during history reconciliation. Sending is blocked.');
        this.state.status = 'idle';
        this.followHistory(result.thread);
      } catch (error) {
        this.state.status = 'unknown';
        throw error;
      }
    });
  }
  loadHistory(more = true): Promise<void> {
    if (this.historyLoad) return this.historyLoad;
    const load = this.hydrateHistory(more).finally(() => {
      if (this.historyLoad === load) this.historyLoad = undefined;
    });
    this.historyLoad = load;
    return load;
  }
  private async hydrateHistory(more: boolean) {
    const id = this.state.threadId;
    if (!id || (more && !this.state.historyCursor)) return;
    const client = this.runtime();
    this.hydration = true;
    try {
      const turns = await client.request<ThreadTurnsListResponse>('thread/turns/list', {
        threadId: id,
        limit: more ? 20 : 5,
        cursor: more ? this.state.historyCursor : null,
        sortDirection: 'desc',
        itemsView: 'full',
      });
      if (this.uncertainWork && turns.data.some(turn => turn.status === 'inProgress'))
        throw new Error('The previous turn is unresolved. Reconcile it in its owning client first.');
      const hydrated = [],
        turnChanges: NonNullable<ViewState['turnChanges']> = {};
      for (const turn of [...turns.data].reverse()) {
        let items = turn.items;
        if (turn.itemsView !== 'full') {
          items = [];
          let cursor: string | null = null;
          const seen = new Set<string>();
          do {
            const page: ThreadItemsListResponse = await client.request('thread/items/list', {
              threadId: id,
              turnId: turn.id,
              limit: 100,
              cursor,
              sortDirection: 'asc',
            });
            items.push(...page.data.map(e => e.item));
            cursor = page.nextCursor;
            if (cursor && (seen.has(cursor) || seen.size >= 100))
              throw new Error('History item pagination did not advance or exceeded its limit.');
            if (cursor) seen.add(cursor);
          } while (cursor);
        }
        hydrated.push(...items.map(item => timelineItem(item, turn.id)));
        const changed = items.flatMap(item =>
          item.type === 'fileChange' && item.status === 'completed' ? item.changes : [],
        );
        if (changed.length) {
          const files = new Map<string, { path: string; added: number; removed: number }>();
          for (const change of changed) {
            const { path, added, removed } = summarize(this.cwd, change),
              prior = files.get(path);
            files.set(path, { path, added: added + (prior?.added ?? 0), removed: removed + (prior?.removed ?? 0) });
          }
          turnChanges[turn.id] = [...files.values()];
        }
      }
      if (this.state.threadId !== id || this.client !== client || this.disposed || !client.connected) return;
      if (turns.nextCursor && turns.nextCursor === (more ? this.state.historyCursor : null))
        throw new Error('History pagination did not advance.');
      this.state.items = [
        ...new Map([...hydrated, ...(more ? this.state.items : [])].map(i => [i.turnId + '/' + i.id, i])).values(),
      ];
      this.state.historyCursor = turns.nextCursor;
      this.state.turnChanges = { ...(more ? this.state.turnChanges : {}), ...turnChanges };
    } finally {
      this.hydration = false;
      for (const event of this.deferred) this.notification(event);
      this.deferred = [];
      this.update();
    }
  }
  /** `fromView` marks the webview's own keystrokes, which it already shows and must not get echoed back. */
  async setDraft(text: string, threadId: string | null | undefined = this.state.threadId, fromView = false) {
    const target = threadId ?? undefined;
    if (
      target &&
      target !== this.state.threadId &&
      !this.owned.has(target) &&
      !this.state.sessions.some(s => s.id === target)
    )
      throw new Error('Draft belongs to an unknown chat.');
    if (target === this.state.threadId) {
      if (!fromView && text !== this.state.draft) this.bumpDraftEpoch();
      this.state.draft = text;
      this.draftRevision++;
    }
    await this.store.update(`draft.${target ?? 'new'}`, text);
  }
  async annotate(
    threadId: string,
    action: 'add' | 'comment' | 'remove',
    value: ResponseAnnotation | string,
    comment = '',
  ) {
    if (threadId !== this.state.threadId) throw new Error('This annotation belongs to another chat.');
    const annotations = this.state.annotations ?? [];
    if (action === 'add') {
      if (!validAnnotation(value) || annotations.length >= 10 || annotations.some(a => a.id === value.id))
        throw new Error('Select up to 10 excerpts, each at most 8,000 characters.');
      if (
        !this.state.items.some(
          item => item.type === 'agentMessage' && item.id === value.itemId && item.turnId === value.turnId,
        )
      )
        throw new Error('Select text from a loaded assistant response.');
      this.state.annotations = [...annotations, value];
    } else {
      if (typeof value !== 'string' || comment.length > 2000) throw new Error('Invalid annotation.');
      this.state.annotations =
        action === 'remove'
          ? annotations.filter(a => a.id !== value)
          : annotations.map(a => (a.id === value ? { ...a, comment } : a));
    }
    await this.store.update(`annotations.${threadId}`, this.state.annotations);
    this.update();
  }
  /**
   * Side questions run in an ephemeral fork of the open chat, as the Codex TUI's /side does: the fork
   * sees the history, is read-only, writes no rollout and leaves the main chat untouched.
   */
  async askSide(parentId: string, text: string) {
    if (!text.trim() || text.length > 100_000) throw new Error('Type a side question.');
    if (this.sideBusy || (this.state.side && busy(this.state.side.status)))
      throw new Error('Wait for the side answer before asking again.');
    if (parentId !== this.state.threadId || !this.ready)
      throw new Error('Open the chat before asking a side question.');
    this.sideBusy = true;
    try {
      if (this.state.side?.parentId !== parentId) {
        await this.closeSide();
        const fork = await this.runtime().request<ThreadResumeResponse>('thread/fork', {
          threadId: parentId,
          ephemeral: true,
          cwd: this.cwd,
          sandbox: 'read-only',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          config: this.restrictedConfig,
          excludeTurns: true,
        });
        this.ensureReadonly(fork);
        if (this.state.threadId !== parentId) {
          void this.runtime()
            .request('thread/unsubscribe', { threadId: fork.thread.id })
            .catch(() => {});
          throw new Error('Chat changed before the side question started.');
        }
        this.state.side = { threadId: fork.thread.id, parentId, items: [], status: 'idle' };
      }
      const side = this.state.side!;
      side.status = 'starting';
      side.error = undefined;
      this.update();
      const started = await this.runtime().request<TurnStartResponse>('turn/start', {
        threadId: side.threadId,
        clientUserMessageId: randomUUID(),
        input: [{ type: 'text', text, text_elements: [] }],
        cwd: this.cwd,
        model: this.state.model,
        effort: this.state.effort,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      });
      // Closed while the turn was starting: stop it rather than leave an unobserved fork running.
      if (this.state.side !== side)
        await this.runtime()
          .request('turn/interrupt', { threadId: side.threadId, turnId: started.turn.id })
          .catch(() => {});
    } catch (error) {
      if (this.state.side) {
        this.state.side.status = 'failed';
        this.state.side.error = error instanceof Error ? error.message : 'Side question failed.';
      }
      throw error;
    } finally {
      this.sideBusy = false;
      this.update();
    }
  }
  /** Lists the agent's background terminals in this chat (the TUI's /ps). */
  async refreshTerminals() {
    const threadId = this.state.threadId;
    if (!threadId || !this.state.writable) {
      this.state.terminals = {
        loading: false,
        items: [],
        error: 'Continue this chat here to see its background terminals.',
      };
      return this.update();
    }
    this.state.terminals = { items: this.state.terminals?.items ?? [], loading: true };
    this.update();
    try {
      const result = await this.runtime().request<{ data: any[] }>('thread/backgroundTerminals/list', {
        threadId,
        limit: 50,
      });
      if (this.state.threadId !== threadId) return;
      this.state.terminals = {
        loading: false,
        items: result.data.map(terminal => ({
          processId: String(terminal.processId),
          command: truncate(String(terminal.command ?? ''), 500),
          cwd: String(terminal.cwd ?? ''),
          osPid: finite(terminal.osPid),
          cpuPercent: finite(terminal.cpuPercent),
          rssKb: finite(terminal.rssKb),
        })),
      };
    } catch (error) {
      this.state.terminals = {
        loading: false,
        items: [],
        error: error instanceof Error ? error.message : 'Unavailable in this runtime.',
      };
    }
    this.update();
  }
  /** Stops one background terminal, or all of them (the TUI's /stop). */
  async stopTerminals(processId?: string) {
    const threadId = this.state.threadId;
    if (!threadId || !this.state.writable) throw new Error('Continue this chat here to stop its background terminals.');
    if (processId && !this.state.terminals?.items.some(t => t.processId === processId))
      throw new Error('That terminal is no longer listed. Refresh first.');
    await this.runtime().request(
      processId ? 'thread/backgroundTerminals/terminate' : 'thread/backgroundTerminals/clean',
      processId ? { threadId, processId } : { threadId },
    );
    await this.refreshTerminals();
  }
  /** Ends the side fork; ephemeral threads keep nothing once unsubscribed. */
  async closeSide() {
    const side = this.state.side;
    if (!side) return;
    this.state.side = undefined;
    this.update();
    if (!this.client?.connected) return;
    if (busy(side.status) && side.turnId)
      await this.client.request('turn/interrupt', { threadId: side.threadId, turnId: side.turnId }).catch(() => {});
    await this.client.request('thread/unsubscribe', { threadId: side.threadId }).catch(() => {});
  }
  private sideNotification(method: string, p: any) {
    const side = this.state.side!;
    switch (method) {
      case 'turn/started':
        side.turnId = p.turn.id;
        side.status = 'running';
        break;
      case 'turn/completed':
        side.turnId = undefined;
        side.status = p.turn.status;
        if (p.turn.status === 'failed') side.error = turnErrorMessage(p.turn.error);
        break;
      case 'item/started':
      case 'item/completed':
        side.items = upsertItem(
          side.items,
          timelineItem(p.item as ThreadItem, p.turnId, method === 'item/started' ? 'inProgress' : 'completed'),
        );
        break;
      case 'item/reasoning/summaryTextDelta':
        side.items = appendReasoningDelta(side.items, p.turnId, p.itemId, p.summaryIndex, p.delta);
        break;
      case 'item/agentMessage/delta':
        side.items = appendDelta(side.items, p.turnId, p.itemId, 'agentMessage', p.delta);
        break;
      default:
        return;
    }
    this.update();
  }
  /**
   * Another client writes a passively opened chat through the same rollout file, so follow that file
   * and reload the latest turns. Stops once this chat is continued here or another chat is selected.
   */
  private followHistory(thread: Thread) {
    this.historyWatch?.close();
    this.historyWatch = undefined;
    if (!thread.path || this.state.writable) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const watcher = watch(thread.path, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (this.historyWatch !== watcher || this.state.threadId !== thread.id) return;
          if (this.state.writable) return void this.followHistory(thread);
          if (this.operation || busy(this.state.status) || !this.ready) return;
          void this.exclusive(() => this.loadHistory(false)).catch(() => {});
        }, 500);
      });
      watcher.on('error', () => watcher.close());
      this.historyWatch = watcher;
    } catch {
      /* A moved or unreadable rollout leaves manual reload as the route. */
    }
  }
  /** Tells the webview the host replaced the draft (send, chat switch, dictation); otherwise it keeps its own text. */
  private bumpDraftEpoch() {
    this.state.draftEpoch = (this.state.draftEpoch ?? 0) + 1;
  }
  private async selectThread(thread: Thread) {
    this.state.terminals = undefined;
    if (this.state.side?.parentId !== thread.id) void this.closeSide();
    this.historyWatch?.close();
    this.historyWatch = undefined;
    this.state.tokenUsage = undefined;
    this.agents.reset();
    this.state.agents = this.agents.state;
    const previousPermission = this.state.threadId === thread.id ? this.state.permission : undefined;
    await this.store.update('lastThread', thread.id);
    this.draftRevision++;
    this.bumpDraftEpoch();
    Object.assign(this.state, {
      threadId: thread.id,
      owned: this.owned.has(thread.id),
      title: thread.name || fallbackTitle(thread.preview || ''),
      draft: this.store.get(`draft.${thread.id}`, ''),
      annotations: this.store.get<ResponseAnnotation[]>(`annotations.${thread.id}`, []),
      contexts: [],
      notice: undefined,
    });
    this.named = Boolean(thread.name);
    this.state.permission = this.reviewedThreads.has(thread.id)
      ? previousPermission === 'reviewed'
        ? 'reviewed'
        : 'read-only'
      : 'agent';
    const saved = this.store.get<Partial<ViewState>>(`preferences.${thread.id}`, {});
    for (const key of ['model', 'effort', 'mode', 'profile', 'approval', 'reviewer'] as const)
      if (saved[key] !== undefined) (this.state as any)[key] = saved[key];
    this.state.queued = [];
    this.state.turnChanges = {};
  }
  private nativePolicy() {
    if (!this.state.nativeReady || !this.state.profiles?.some(p => p.id === this.state.profile && p.allowed))
      throw new Error('Choose an allowed native permission profile.');
    return {
      permissions: this.state.profile,
      approvalPolicy: this.state.approval,
      approvalsReviewer: this.state.reviewer,
    };
  }
  private async savePreferences() {
    const { model, effort, mode, profile, approval, reviewer } = this.state;
    await this.store.update(`preferences.${this.state.threadId ?? 'new'}`, {
      model,
      effort,
      mode,
      profile,
      approval,
      reviewer,
    });
    this.update();
  }
  async configure(model: string, effort: string, mode: ViewState['mode']) {
    return this.exclusive(async () => {
      await this.settingsIdle();
      if (
        !this.state.models.some(
          m => m.model === model && m.supportedReasoningEfforts.some(e => e.reasoningEffort === effort),
        )
      )
        throw new Error('Unsupported model settings.');
      Object.assign(this.state, { model, effort, mode, modelFallback: undefined });
      await this.savePreferences();
    });
  }
  async configurePolicy(
    profile = this.state.profile!,
    approval = this.state.approval!,
    reviewer = this.state.reviewer!,
  ) {
    return this.exclusive(async () => {
      await this.settingsIdle();
      if (!this.state.nativeReady || !this.state.profiles?.some(p => p.id === profile && p.allowed))
        throw new Error('This permission profile is unavailable or disallowed by policy.');
      Object.assign(this.state, { profile, approval, reviewer });
      await this.savePreferences();
    });
  }
  private async settingsIdle() {
    if (this.agents.active) throw new Error('Stop or finish child agents before changing task settings.');
    if (this.state.permission === 'agent' && this.state.writable && this.state.threadId) await this.refreshQueue();
    if (this.agents.active || busy(this.state.status) || this.state.queued?.length)
      throw new Error(
        'Finish or remove queued work before changing settings. Queued input uses the current runtime task settings.',
      );
  }
  async continueThread(fork = false, sourceId = this.state.threadId) {
    return this.exclusive(() => this.resumeThread(fork, sourceId));
  }
  private async resumeThread(fork: boolean, sourceId: string | undefined) {
    if (this.agents.active) throw new Error('Stop or finish child agents before continuing this runtime.');
    const id = sourceId;
    if (!fork && id !== this.state.threadId) throw new Error('Continue must target the currently open chat.');
    if (!id || !this.ready || this.state.status === 'unknown')
      throw new Error('Open and reconcile a workspace chat first.');
    const reviewed = !fork && this.owned.has(id) && this.reviewedThreads.has(id);
    if (this.reviewedThreads.has(id) && !reviewed)
      throw new Error('Start a new Agent chat; this legacy reviewed chat has different tool instructions.');
    const read = await this.runtime().request<ThreadReadResponse>('thread/read', {
      threadId: id,
      includeTurns: false,
    });
    await this.checkWorkspace(read.thread);
    if (read.thread.status.type === 'active')
      throw new Error('This chat is active in another client. Close it there before continuing.');
    if (!fork && !reviewed) {
      const queue = await this.runtime().request<{ data: unknown[] }>('thread/queue/list', {
        threadId: id,
        limit: 1,
      });
      if (queue.data.length)
        throw new Error('This chat has queued work. Finish or remove it in the client that queued it before sending.');
    }
    await this.unload(fork ? undefined : id);
    await this.beforeSend([]);
    this.state.status = 'starting';
    this.update();
    try {
      const result = await this.runtime().request<ThreadResumeResponse>(fork ? 'thread/fork' : 'thread/resume', {
        threadId: id,
        cwd: this.cwd,
        ...(reviewed
          ? {
              sandbox: 'read-only',
              approvalPolicy: 'never',
              approvalsReviewer: 'user',
              config: this.restrictedConfig,
            }
          : this.nativePolicy()),
        excludeTurns: true,
      });
      if (reviewed) this.ensureReadonly(result);
      await this.checkWorkspace(result.thread);
      if (!fork && result.thread.id !== id)
        throw new Error('Runtime resumed a different chat. Reconnect before sending.');
      if (result.thread.status.type === 'active')
        throw new Error('The chat still has active work. Reconcile before sending.');
      this.loadedThread = result.thread.id;
      this.owned.add(result.thread.id);
      await this.store.update('owned', [...this.owned]);
      if (fork) await this.selectThread(result.thread);
      else this.state.owned = true;
      this.state.memoryEnabled = undefined;
      await this.loadHistory(false);
      if (!reviewed) await this.refreshQueue();
      if (this.activeTurn || this.state.decisions.length || this.agents.active)
        throw new Error('This chat has active work. Reconcile before sending.');
      this.state.writable = true;
      this.historyWatch?.close();
      this.historyWatch = undefined;
      this.state.status = 'idle';
      this.state.notice = undefined;
      await this.savePreferences();
      await this.listSessions();
    } catch (error) {
      this.state.status = 'unknown';
      throw error;
    }
  }
  async memory(enabled: boolean) {
    return this.exclusive(async () => {
      await this.settingsIdle();
      if (!this.state.owned || !this.state.writable || this.state.permission !== 'agent' || !this.state.memoryAvailable)
        throw new Error('Local memories must be enabled in Codex configuration for a continued Agent chat.');
      await this.runtime().request('thread/memoryMode/set', {
        threadId: this.state.threadId,
        mode: enabled ? 'enabled' : 'disabled',
      });
      // 0.152.0 acknowledges this setter but exposes no memory-mode getter. Reconnect shows unknown.
      this.state.memoryEnabled = enabled;
    });
  }
  async refreshQueue() {
    if (!this.state.threadId || !this.state.owned || this.state.permission !== 'agent') return;
    const client = this.runtime(),
      threadId = this.state.threadId;
    const result = await client.request<{ data: { id: string; input: { type: string; text?: string }[] }[] }>(
      'thread/queue/list',
      { threadId, limit: 100 },
    );
    if (client !== this.client || threadId !== this.state.threadId) return;
    this.state.queued = result.data.map(item => ({
      id: item.id,
      text: item.input
        .filter(i => i.type === 'text')
        .map(i => i.text ?? '')
        .join('\n'),
    }));
    this.update();
  }
  async followup(text: string, delivery: 'queue' | 'steer', images: string[] = []) {
    if (this.state.annotations?.length)
      throw new Error('Wait for the current turn to finish before sending response annotations.');
    if (
      (!text.trim() && !images.length) ||
      text.length > 100000 ||
      !this.ready ||
      this.operation ||
      this.state.permission !== 'agent' ||
      !this.state.owned ||
      !['running', 'waiting'].includes(this.state.status) ||
      !this.activeTurn
    )
      throw new Error('Follow-ups require an active Agent turn.');
    const revision = this.draftRevision,
      threadId = this.state.threadId,
      turnId = this.activeTurn;
    this.operation = true;
    this.state.operationBusy = true;
    this.update();
    try {
      await this.beforeSend([]);
      if (
        this.state.threadId !== threadId ||
        this.activeTurn !== turnId ||
        !['running', 'waiting'].includes(this.state.status)
      )
        throw new Error('The active turn changed before follow-up delivery. Nothing was sent.');
      if (
        images.length &&
        !this.state.models.find(m => m.model === this.state.model)?.inputModalities?.includes('image')
      )
        throw new Error('The selected model does not accept images. Choose another model or remove the images.');
      const input = [
        ...(text.trim() ? [{ type: 'text', text, text_elements: [] }] : []),
        ...images.map(path => ({ type: 'localImage', path })),
      ];
      await this.runtime().request(delivery === 'queue' ? 'thread/queue/add' : 'turn/steer', {
        threadId,
        input,
        ...(delivery === 'queue' ? { clientUserMessageId: randomUUID() } : { expectedTurnId: turnId }),
      });
      if (this.state.draft === text && revision === this.draftRevision) await this.setDraft('');
      if (delivery === 'queue') await this.refreshQueue();
    } catch (error) {
      if (error instanceof DeliveryError && error.delivery === 'unknown') {
        this.state.status = 'unknown';
        this.state.writable = false;
        this.client?.stop();
      }
      throw error;
    } finally {
      this.operation = false;
      this.state.operationBusy = false;
      this.update();
    }
  }
  async removeQueued(id: string) {
    if (
      this.operation ||
      !this.ready ||
      !this.state.owned ||
      this.state.permission !== 'agent' ||
      !this.state.queued?.some(q => q.id === id)
    )
      throw new Error('Queued message expired or another operation is in progress.');
    this.operation = true;
    this.state.operationBusy = true;
    this.update();
    try {
      await this.runtime().request('thread/queue/delete', { threadId: this.state.threadId, queuedSubmissionId: id });
      await this.refreshQueue();
    } catch (error) {
      if (error instanceof DeliveryError && error.delivery === 'unknown') {
        this.state.writable = false;
        this.client?.stop();
        this.state.status = 'unknown';
      }
      throw error;
    } finally {
      this.operation = false;
      this.state.operationBusy = false;
      this.update();
    }
  }
  /** Drops `turnId` and every later turn from the native history. Files are restored separately by the host. */
  async revert(turnId: string, restoreFiles: () => Promise<(() => Promise<void>) | void>) {
    return this.exclusive(async () => {
      if (this.agents.active) throw new Error('Stop or finish child agents before rewinding.');
      if (!this.state.threadId || !this.state.owned || !this.state.writable || this.state.permission !== 'agent')
        throw new Error('Open a continued Agent chat owned by this extension to rewind it.');
      if (!this.state.items.some(item => item.turnId === turnId)) throw new Error('That message is no longer loaded.');
      const rollback = await restoreFiles();
      try {
        await this.runtime().request('thread/revert', { threadId: this.state.threadId, beforeTurnId: turnId });
      } catch (error) {
        // An unknown outcome may already have reverted history; only a definite failure puts files back.
        if (error instanceof DeliveryError && error.delivery === 'unknown') this.state.status = 'unknown';
        else if (rollback) await rollback();
        throw error;
      }
      await this.loadHistory(false);
      this.state.status = 'idle';
    });
  }
  /** Turn IDs from `turnId` to the newest loaded turn, oldest first. */
  turnsFrom(turnId: string) {
    const order = [...new Set(this.state.items.map(item => item.turnId))];
    const start = order.indexOf(turnId);
    if (start < 0) throw new Error('That message is no longer loaded.');
    return order.slice(start);
  }
  async bookmark(id: string) {
    if (!this.state.sessions.some(s => s.id === id)) throw new Error('Select a loaded session to bookmark.');
    if (this.bookmarks.has(id)) this.bookmarks.delete(id);
    else this.bookmarks.add(id);
    await this.store.update('bookmarks', [...this.bookmarks]);
    this.state.sessions = this.state.sessions.map(s => ({ ...s, bookmarked: this.bookmarks.has(s.id) }));
    this.update();
  }
  async rename(name: string) {
    return this.exclusive(async () => {
      if (!this.state.threadId || !this.state.owned || !this.ready || this.state.status === 'unknown')
        throw new Error('Open an idle chat owned by this extension to rename it.');
      if (!name.trim() || name.length > 200) throw new Error('Use a chat name between 1 and 200 characters.');
      try {
        await this.runtime().request('thread/name/set', { threadId: this.state.threadId, name: name.trim() });
      } catch (error) {
        if (error instanceof DeliveryError && error.delivery === 'unknown') this.state.status = 'unknown';
        throw error;
      }
      this.state.title = name.trim();
      this.named = true;
      await this.listSessions();
    });
  }
  async archive() {
    return this.exclusive(async () => {
      if (this.agents.active) throw new Error('Stop or finish child agents before archiving this chat.');
      if (!this.state.threadId || !this.state.owned || !this.ready || this.state.status === 'unknown')
        throw new Error('Open an idle chat owned by this extension to archive it.');
      const id = this.state.threadId;
      await this.setDraft(this.state.draft);
      try {
        await this.runtime().request('thread/archive', { threadId: id });
      } catch (error) {
        if (error instanceof DeliveryError && error.delivery === 'unknown') this.state.status = 'unknown';
        throw error;
      }
      await this.clearView();
      this.state.status = 'idle';
      await this.listSessions();
    });
  }
  async unarchive(id: string) {
    return this.exclusive(async () => {
      if (
        !this.ready ||
        this.state.status === 'unknown' ||
        !this.owned.has(id) ||
        !this.state.sessionsArchived ||
        !this.state.sessions.some(s => s.id === id)
      )
        throw new Error('Choose an archived chat owned by this extension after reconciling any unknown outcome.');
      const read = await this.runtime().request<ThreadReadResponse>('thread/read', {
        threadId: id,
        includeTurns: false,
      });
      await this.checkWorkspace(read.thread);
      try {
        await this.runtime().request('thread/unarchive', { threadId: id });
      } catch (error) {
        if (error instanceof DeliveryError && error.delivery === 'unknown') this.state.status = 'unknown';
        throw error;
      }
      await this.listSessions();
    });
  }
  private async clearView() {
    void this.closeSide();
    this.historyWatch?.close();
    this.historyWatch = undefined;
    this.agents.reset();
    this.state.agents = this.agents.state;
    this.state.threadId = undefined;
    this.state.owned = false;
    this.state.title = '';
    this.state.items = [];
    this.state.contexts = [];
    this.state.annotations = [];
    this.state.decisions = [];
    this.state.historyCursor = null;
    this.state.error = undefined;
    this.state.notice = undefined;
    this.activeTurn = undefined;
    this.state.draft = this.store.get('draft.new', '');
    this.bumpDraftEpoch();
    await this.store.update('lastThread', undefined);
  }
  async closeChat() {
    return this.exclusive(async () => {
      if (this.uncertainWork) throw new Error('Reconnect and reconcile the unresolved task before closing this chat.');
      if (this.agents.active) throw new Error('Stop or finish child agents before closing this chat.');
      await this.setDraft(this.state.draft);
      this.ready = false;
      this.abortReviews();
      await this.client?.shutdown();
      this.client = undefined;
      await this.clearView();
      this.state.status = 'offline';
      this.state.account = 'unknown';
      this.state.permission = 'read-only';
    });
  }
  async send(
    text: string,
    editor?: ViewState['contexts'][number],
    skills: () => Promise<{ name: string; path: string }[]> = async () => [],
    images: string[] = [],
  ) {
    return this.exclusive(async () => {
      if (this.state.status === 'unknown') throw new Error('Reload history before sending after an unknown outcome.');
      if (!this.ready || this.state.status === 'offline' || this.state.status === 'connecting')
        throw new Error('Wait for connection and history reconciliation before sending.');
      // An image-only message is a valid native input (verified on 0.152.0).
      if (!text.trim() && !images.length && !this.state.annotations?.length) return;
      if (!this.state.threadId) throw new Error('Open a workspace chat first.');
      if (this.state.permission === 'reviewed' && !this.reviewedThreads.has(this.state.threadId))
        throw new Error('Create a new chat to use reviewed edits. This older chat has no client edit tool.');
      const model = this.state.models.find(m => m.model === this.state.model);
      if (!model?.supportedReasoningEfforts.some(e => e.reasoningEffort === this.state.effort))
        throw new Error('Unsupported model or reasoning effort.');
      if (images.length && !model.inputModalities?.includes('image'))
        throw new Error('The selected model does not accept images. Choose another model or remove the images.');
      const submittedDraftRevision = this.draftRevision,
        annotations = [...(this.state.annotations ?? [])],
        contexts = [...this.state.contexts];
      if (editor && !contexts.some(c => c.uri === editor.uri || (editor.path && c.path === editor.path)))
        contexts.push(editor);
      this.state.status = 'starting';
      this.state.error = undefined;
      this.update();
      try {
        await this.beforeSend(contexts);
        const invoked = await skills();
        if (!this.state.owned || this.state.writable === false) {
          await this.resumeThread(false, this.state.threadId);
          await this.beforeSend(contexts);
        }
        if (this.activeTurn || this.state.decisions.length || this.agents.active || this.state.queued?.length)
          throw new Error('Finish or remove pending work before sending a new message.');
        this.state.status = 'starting';
        this.update();
        this.allowEdits = this.state.permission === 'reviewed' && this.state.mode === 'default';
        const context = contexts
          .map(c =>
            c.kind === 'selection'
              ? `\n\n--- Selected code: ${c.label} ---\n${c.text}\n--- End of selection ---`
              : `\n\n[Referenced file: ${c.path ?? c.label}]`,
          )
          .join('');
        const restricted = this.state.permission !== 'agent' || this.state.mode === 'plan';
        const params: TurnStartParams = {
          threadId: this.state.threadId,
          clientUserMessageId: randomUUID(),
          input: [
            ...[invoked.map(s => `$${s.name} `).join('') + text + annotationContext(annotations) + context]
              .filter(prompt => prompt.trim())
              .map(prompt => ({ type: 'text' as const, text: prompt, text_elements: [] })),
            ...invoked.map(s => ({ type: 'skill' as const, name: s.name, path: s.path })),
            ...images.map(path => ({ type: 'localImage' as const, path })),
          ],
          cwd: this.cwd,
          model: this.state.model,
          effort: this.state.effort,
          summary: 'auto',
          ...(restricted
            ? {
                approvalPolicy: 'never',
                approvalsReviewer: 'user',
                sandboxPolicy: { type: 'readOnly', networkAccess: false },
              }
            : this.nativePolicy()),
          collaborationMode: {
            mode: this.state.mode,
            settings: {
              model: this.state.model,
              reasoning_effort: this.state.effort,
              developer_instructions:
                this.state.permission === 'agent'
                  ? null
                  : `${editInstructions}\nCurrent turn: ${this.allowEdits ? 'Reviewed edits are enabled. Submit changes with propose_text_edits and wait for the user decision.' : 'Read-only. Do not submit edit proposals or attempt writes.'}`,
            },
          },
        };
        const result = await this.runtime().request<TurnStartResponse>('turn/start', params);
        if (!this.state.title) this.state.title = fallbackTitle(text);
        if (this.state.status === 'starting' || this.state.status === 'running') {
          if (result.turn.status === 'inProgress') this.activeTurn = result.turn.id;
          else {
            this.activeTurn = undefined;
            this.state.status = result.turn.status;
          }
        }
        if (this.state.draft === text && this.draftRevision === submittedDraftRevision) await this.setDraft('');
        this.state.contexts = this.state.contexts.filter(c => !contexts.some(submitted => submitted.id === c.id));
        this.state.annotations = (this.state.annotations ?? []).filter(a => !annotations.includes(a));
        await this.store.update(`annotations.${this.state.threadId}`, this.state.annotations);
      } catch (e) {
        if (e instanceof DeliveryError && e.delivery === 'unknown') this.state.status = 'unknown';
        else if (!['unknown', 'running', 'waiting', 'interrupting'].includes(this.state.status))
          this.state.status = 'failed';
        throw e;
      }
    });
  }
  async cancel() {
    if (!this.state.threadId || !this.activeTurn || this.state.status === 'starting')
      throw new Error('Wait for the runtime turn-start event before interrupting.');
    for (const controller of this.reviews.values()) controller.abort();
    this.reviews.clear();
    this.allowEdits = false;
    this.expireDecisions(this.state.threadId, this.activeTurn);
    this.state.status = 'interrupting';
    this.update();
    try {
      await this.runtime().request('turn/interrupt', { threadId: this.state.threadId, turnId: this.activeTurn });
    } catch (e) {
      if (e instanceof DeliveryError && e.delivery === 'rejected') {
        if (this.activeTurn) this.state.status = 'running';
      } else {
        this.uncertainWork = true;
        this.state.writable = false;
        this.client?.stop();
        this.state.status = 'unknown';
      }
      this.update();
      throw e;
    }
    // Interrupting the parent turn does not stop its child agents.
    if (this.agents.active) {
      this.state.notice =
        this.state.locale === 'zh-CN'
          ? '后台任务可能仍在运行，可在 Agents 面板中单独停止。'
          : 'Background agent tasks may still be running. Stop them individually from the Agents panel.';
      this.update();
    }
  }
  decision(id: string | number, token: string) {
    const d = this.state.decisions.find(
      d =>
        d.id === id &&
        d.token === token &&
        ((d.threadId === this.state.threadId && d.turnId === this.activeTurn) ||
          this.agents.hasTurn(d.threadId, d.turnId)),
    );
    if (!d) throw new Error('Decision expired or belongs to another turn.');
    return d;
  }
  decide(
    id: string | number,
    token: string,
    answers?: Record<string, { answers: string[] }>,
    cancel = false,
    accept = false,
    content?: Record<string, FormValue>,
    forSession = false,
  ) {
    const d = this.decision(id, token);
    if (forSession && (!accept || !d.options?.includes('acceptForSession')))
      throw new Error('This request cannot be allowed for the session.');
    if (cancel && accept) throw new Error('Conflicting decision.');
    if (d.method === 'mcpServer/elicitation/request') {
      if (accept && !d.canAccept) throw new Error('This elicitation cannot be accepted.');
      const fields = accept && d.form ? elicitationFields(this.nativeRequests.get(token)?.requestedSchema) : undefined;
      this.runtime().respond(id, {
        action: cancel ? 'cancel' : accept ? 'accept' : 'decline',
        content: fields ? validateElicitation(fields, content) : null,
        _meta: null,
      });
    } else if (d.kind === 'question') {
      if (!cancel && d.questions!.some(q => !answers?.[q.id]?.answers.length))
        throw new Error('Answer each question before submitting.');
      if (answers && Object.keys(answers).some(key => !d.questions!.some(q => q.id === key)))
        throw new Error('Unknown question identity.');
      this.runtime().respond(id, { answers: cancel ? {} : answers });
    } else {
      if (accept && (!d.canAccept || d.kind !== 'approval' || this.state.permission !== 'agent'))
        throw new Error('This request cannot be approved by this workflow.');
      const params = this.nativeRequests.get(token);
      if (!params) throw new Error('Decision snapshot expired.');
      if (d.method === 'item/permissions/requestApproval')
        this.runtime().respond(id, { permissions: accept ? params.permissions : {}, scope: 'turn' });
      else
        this.runtime().respond(id, {
          decision: cancel ? 'cancel' : accept ? (forSession ? 'acceptForSession' : 'accept') : 'decline',
        });
    }
    this.nativeRequests.delete(token);
    this.hooks.settled?.(token);
    this.state.decisions = this.state.decisions.filter(x => x.id !== id);
    this.state.status =
      this.state.decisions.length || this.reviews.size ? 'waiting' : this.activeTurn ? 'running' : 'completed';
    this.update();
  }
  /** Full pending changes behind a file-change approval, for the native diff editor. */
  pendingChanges(id: string | number, token: string) {
    const d = this.decision(id, token);
    const changes = d.method === 'item/fileChange/requestApproval' ? this.fileChanges.get(d.itemId) : undefined;
    if (!changes) throw new Error('This request has no reviewable file changes.');
    return changes;
  }
  authorization(id: string | number, token: string) {
    const d = this.decision(id, token);
    if (d.method !== 'mcpServer/elicitation/request' || !d.canAccept || d.form)
      throw new Error('This request has no supported authorization page.');
    return authorizationUrl(this.nativeRequests.get(token)?.url);
  }
  private abortReviews() {
    for (const controller of this.reviews.values()) controller.abort();
    this.reviews.clear();
    this.nativeRequests.clear();
    for (const d of this.state.decisions) this.hooks.settled?.(d.token);
    this.state.decisions = [];
    this.fileChanges.clear();
    this.allowEdits = false;
  }
  private async serverRequest(message: RpcMessage) {
    const client = this.client!;
    const p = message.params as any;
    if (message.id === undefined) return;
    if (
      this.routing.has(message.id) ||
      this.reviews.has(message.id) ||
      this.state.decisions.some(d => d.id === message.id)
    ) {
      this.abortReviews();
      client.stop();
      this.state.error = 'Duplicate runtime request identity. Connection closed; no approval was granted.';
      this.update();
      return;
    }

    if (message.method === 'mcpServer/elicitation/request' && (!p || typeof p.turnId !== 'string')) {
      client.respond(message.id, { action: 'cancel', content: null, _meta: null });
      this.state.notice =
        'An MCP request had no active turn identity and was cancelled. No authorization page was opened.';
      this.update();
      return;
    }
    if (!p || typeof p.threadId !== 'string' || typeof p.turnId !== 'string') {
      client.reject(message.id);
      return;
    }
    if (p.threadId !== this.state.threadId) {
      if (
        !this.state.owned ||
        !this.state.writable ||
        this.state.permission !== 'agent' ||
        this.state.mode === 'plan'
      ) {
        client.reject(message.id);
        return;
      }
      const parent = this.state.threadId,
        route = { resolved: false };
      this.routing.set(message.id, route);
      try {
        const turn = await this.agents.activeTurn(p.threadId);
        if (this.client !== client || this.state.threadId !== parent || !client.connected || route.resolved) return;
        if (turn !== p.turnId) {
          client.reject(message.id);
          return;
        }
      } catch {
        if (this.client === client && client.connected) client.reject(message.id);
        return;
      } finally {
        if (this.client === client && this.routing.get(message.id) === route) this.routing.delete(message.id);
      }
    } else if (!this.activeTurn || p.turnId !== this.activeTurn) {
      client.reject(message.id);
      return;
    }
    if (message.method === 'item/tool/call' && p.tool === TITLE_TOOL) {
      const title = chatTitle(p.arguments);
      const valid =
        title &&
        p.namespace === null &&
        p.threadId === this.state.threadId &&
        this.state.owned &&
        this.state.writable &&
        !this.named;
      let success = false;
      if (valid) {
        // Reserve once before awaiting: duplicate calls must not overwrite an accepted or manual title.
        this.named = true;
        try {
          await client.request('thread/name/set', { threadId: p.threadId, name: title });
          success = true;
          if (this.client === client && this.state.threadId === p.threadId) {
            this.state.title = title;
            this.state.sessions = this.state.sessions.map(s => (s.id === p.threadId ? { ...s, title } : s));
            this.update();
          }
        } catch {
          this.log('Automatic chat naming was unavailable; no automatic retry.');
        }
      }
      if (this.client === client && client.connected)
        client.respond(message.id, {
          success,
          contentItems: [
            {
              type: 'inputText',
              text: success ? 'Chat title saved.' : 'Title unchanged. Continue answering the user; do not retry.',
            },
          ],
        });
      return;
    }
    if (
      message.method === 'item/tool/call' &&
      p.tool === DIAGNOSTICS_TOOL &&
      p.namespace === null &&
      this.hooks.diagnostics
    ) {
      const id = message.id;
      void this.hooks
        .diagnostics(p.arguments)
        .then(
          text => ({ success: true, contentItems: [{ type: 'inputText' as const, text }] }),
          () => ({
            success: false,
            contentItems: [{ type: 'inputText' as const, text: 'Diagnostics are unavailable.' }],
          }),
        )
        .then(response => {
          if (this.client === client && client.connected) client.respond(id, response);
        });
      return;
    }
    if (message.method === 'item/tool/call') {
      const id = message.id;
      if (
        p.threadId !== this.state.threadId ||
        !this.activeTurn ||
        p.turnId !== this.activeTurn ||
        typeof p.callId !== 'string' ||
        p.callId.length > 200 ||
        p.namespace !== null ||
        p.tool !== EDIT_TOOL ||
        !this.allowEdits ||
        !this.review
      ) {
        client.respond(id, {
          success: false,
          contentItems: [
            {
              type: 'inputText',
              text: 'Edits are not authorized for this turn, or the tool identity is invalid. No file was changed.',
            },
          ],
        });
        return;
      }
      const controller = new AbortController();
      this.reviews.set(id, controller);
      this.state.status = 'waiting';
      this.update();
      void this.review(p, controller.signal)
        .catch(error => {
          if (this.client === client && !controller.signal.aborted) this.setError(error);
          return {
            success: false,
            contentItems: [
              {
                type: 'inputText' as const,
                text: 'Edit proposal could not be applied. Inspect the editor and checkpoint records; do not automatically retry.',
              },
            ],
          };
        })
        .then(response => {
          if (this.reviews.get(id) === controller) this.reviews.delete(id);
          if (controller.signal.aborted || this.client !== client || !client.connected || this.activeTurn !== p.turnId)
            return;
          client.respond(id, response);
          if (!this.reviews.size && !this.state.decisions.length && this.state.status === 'waiting')
            this.state.status = 'running';
          this.update();
        });
      return;
    }
    if (
      [
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/permissions/requestApproval',
        'item/tool/requestUserInput',
        'mcpServer/elicitation/request',
      ].includes(message.method!)
    ) {
      const native = this.state.permission === 'agent' && this.state.mode !== 'plan';
      const d: Decision = {
        id: message.id,
        token: randomUUID(),
        kind: message.method === 'item/tool/requestUserInput' ? 'question' : native ? 'approval' : 'blocked',
        method: message.method!,
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId ?? p.serverName,
      };
      if (d.kind === 'question') d.questions = p.questions;
      else {
        const elicitation = d.method === 'mcpServer/elicitation/request';
        if (elicitation && p.mode === 'form') {
          try {
            const fields = elicitationFields(p.requestedSchema);
            if (
              typeof p.message !== 'string' ||
              p.message.length > 4000 ||
              typeof p.serverName !== 'string' ||
              p.serverName.length > 200
            )
              throw new Error();
            d.form = { fields, message: p.message, serverName: p.serverName };
          } catch {
            /* Unknown schemas stay decline/cancel only. */
          }
        }
        const summary = JSON.stringify(
          elicitation
            ? {
                serverName: p.serverName,
                mode: p.mode,
                message:
                  p.mode === 'url'
                    ? 'Open the native authorization page to continue this MCP request.'
                    : d.form
                      ? 'Review this MCP form before sending answers to the server.'
                      : 'This MCP form is unsupported. Decline or cancel the request.',
                supported: p.mode === 'url' || Boolean(d.form),
              }
            : p,
          null,
          2,
        );
        d.summary = truncate(summary, 20_000);
        d.truncated = summary.length > 20_000;
        if (typeof p.reason === 'string') d.reason = truncate(p.reason, 2000);
        if (d.method === 'item/fileChange/requestApproval') {
          const changes = this.fileChanges.get(p.itemId);
          if (changes) d.changes = changes.map(change => summarize(this.cwd, change));
          d.options = ['accept', 'acceptForSession', 'decline', 'cancel'];
          if (changes && native) queueMicrotask(() => this.hooks.fileApproval?.(d.id, d.token, changes));
        }
        if (d.method === 'item/commandExecution/requestApproval') {
          if (typeof p.command === 'string') d.command = truncate(p.command, 4000);
          if (typeof p.cwd === 'string') d.cwd = p.cwd;
          d.options = Array.isArray(p.availableDecisions)
            ? p.availableDecisions.filter((o: unknown): o is 'accept' | 'acceptForSession' | 'decline' | 'cancel' =>
                ['accept', 'acceptForSession', 'decline', 'cancel'].includes(o as string),
              )
            : ['accept', 'acceptForSession', 'decline', 'cancel'];
        }
        d.scope = d.method === 'item/permissions/requestApproval' ? 'turn' : p.grantRoot ? 'session' : 'request';
        d.canAccept =
          native &&
          (!elicitation || p.mode === 'url' || Boolean(d.form)) &&
          !d.truncated &&
          (!Array.isArray(p.availableDecisions) || p.availableDecisions.includes('accept')) &&
          // Never approve a patch the user cannot see.
          (d.method !== 'item/fileChange/requestApproval' || Boolean(d.changes));
        if (elicitation && p.mode === 'url') {
          try {
            authorizationUrl(p.url);
          } catch {
            d.canAccept = false;
          }
        }
        this.nativeRequests.set(d.token, structuredClone(p));
      }
      this.state.decisions.push(d);
      this.state.status = 'waiting';
      this.update();
    } else client.reject(message.id);
  }
  private notification(message: RpcMessage) {
    const p = message.params as any;
    if (!p) return;
    if (this.state.side && p.threadId === this.state.side.threadId) return this.sideNotification(message.method!, p);
    if (message.method === 'account/rateLimits/updated') {
      if (this.state.usage) {
        this.state.usage.stale = true;
        this.update();
      }
      return;
    }
    if (message.method === 'serverRequest/resolved') {
      const route = this.routing.get(p.requestId);
      if (route) route.resolved = true;
    }
    this.agents.notification(message);
    if ((message.method === 'item/started' || message.method === 'item/completed') && p.item?.type === 'fileChange') {
      const phase = message.method === 'item/started' ? 'started' : 'completed';
      if (phase === 'started') this.fileChanges.set(p.item.id, p.item.changes);
      else this.fileChanges.delete(p.item.id);
      this.hooks.fileChange?.(phase, p.threadId, p.turnId, p.item);
    }
    if (p.threadId !== this.state.threadId) {
      if (message.method === 'turn/completed' || message.method === 'serverRequest/resolved') {
        this.expireDecisions(p.threadId, message.method === 'turn/completed' ? p.turn.id : undefined, p.requestId);
      }
      return;
    }
    switch (message.method) {
      case 'turn/diff/updated':
        this.state.turnChanges = { ...this.state.turnChanges, [p.turnId]: turnDiffFiles(String(p.diff)) };
        break;
      case 'thread/tokenUsage/updated':
        this.state.tokenUsage = tokenUsage(p.tokenUsage);
        break;
      case 'turn/started':
        this.activeTurn = p.turn.id;
        this.state.status = 'running';
        if (this.state.permission === 'agent') void this.refreshQueue().catch(error => this.setError(error));
        break;
      case 'turn/completed':
        if (this.activeTurn && p.turn.id !== this.activeTurn) return;
        for (const controller of this.reviews.values()) controller.abort();
        this.reviews.clear();
        this.allowEdits = false;
        this.activeTurn = undefined;
        this.expireDecisions(p.threadId, p.turn.id);
        this.state.status = this.state.decisions.length ? 'waiting' : p.turn.status;
        if (p.turn.status === 'failed') this.state.error = turnErrorMessage(p.turn.error);
        if (this.state.permission === 'agent') void this.refreshQueue().catch(error => this.setError(error));
        break;
      case 'hook/started':
      case 'hook/completed':
        this.state.items = upsertItem(this.state.items, {
          id: `hook-${p.run?.id ?? p.run?.hookKey ?? p.run?.hook?.key}`,
          turnId: p.turnId ?? 'session',
          type: 'hook',
          text: String(p.run?.eventName ?? p.run?.hook?.eventName ?? 'Hook'),
          status: message.method === 'hook/started' ? 'inProgress' : String(p.run?.status ?? 'completed'),
        });
        break;
      case 'item/started':
      case 'item/completed':
        this.state.items = upsertItem(
          this.state.items,
          timelineItem(p.item as ThreadItem, p.turnId, message.method === 'item/started' ? 'inProgress' : 'completed'),
        );
        break;
      case 'item/reasoning/summaryTextDelta':
        this.state.items = appendReasoningDelta(this.state.items, p.turnId, p.itemId, p.summaryIndex, p.delta);
        break;
      case 'item/agentMessage/delta':
      case 'item/plan/delta':
      case 'item/commandExecution/outputDelta':
        this.state.items = appendDelta(
          this.state.items,
          p.turnId,
          p.itemId,
          message.method === 'item/commandExecution/outputDelta'
            ? 'commandExecution'
            : message.method === 'item/plan/delta'
              ? 'plan'
              : 'agentMessage',
          p.delta,
        );
        break;
      case 'serverRequest/resolved':
        for (const d of this.state.decisions)
          if (d.id === p.requestId) {
            this.nativeRequests.delete(d.token);
            this.hooks.settled?.(d.token);
          }
        this.reviews.get(p.requestId)?.abort();
        this.reviews.delete(p.requestId);
        this.state.decisions = this.state.decisions.filter(d => d.id !== p.requestId);
        if (!this.state.decisions.length && !this.reviews.size && this.state.status === 'waiting')
          this.state.status = 'running';
        break;
      case 'thread/name/updated':
        this.state.title = p.threadName;
        this.named = Boolean(p.threadName);
        this.state.sessions = this.state.sessions.map(s => (s.id === p.threadId ? { ...s, title: p.threadName } : s));
        break;
      default:
        return;
    }
    this.update();
  }
  private expireDecisions(threadId: string, turnId?: string, requestId?: string | number) {
    this.state.decisions = this.state.decisions.filter(d => {
      const expired =
        d.threadId === threadId &&
        (turnId === undefined || d.turnId === turnId) &&
        (requestId === undefined || d.id === requestId);
      if (expired) {
        this.nativeRequests.delete(d.token);
        this.hooks.settled?.(d.token);
      }
      return !expired;
    });
    if (!this.state.decisions.length && this.state.status === 'waiting')
      this.state.status = this.activeTurn ? 'running' : 'completed';
    this.update();
  }
  async stopAgent(id: string) {
    if (
      !this.ready ||
      !this.state.owned ||
      !this.state.writable ||
      this.state.permission !== 'agent' ||
      this.state.status === 'unknown'
    )
      throw new Error('Only the owning native Agent connection can stop its child tasks.');
    const client = this.runtime(),
      parent = this.state.threadId;
    const turn = await this.agents.activeTurn(id);
    if (this.client !== client || this.state.threadId !== parent || !this.state.writable)
      throw new Error('Chat changed before stopping its agent.');
    if (!turn) throw new Error('This agent has no active turn. Refresh its status.');
    try {
      await client.request('turn/interrupt', { threadId: id, turnId: turn });
    } catch (error) {
      if (error instanceof DeliveryError && error.delivery === 'unknown') client.stop();
      throw error;
    }
    // The completed notification, not the interrupt acknowledgement, ends the task.
    return turn;
  }
  async refreshUsage() {
    const client = this.runtime();
    if (this.state.account !== 'chatgpt') throw new Error('Plan usage limits are available only with ChatGPT sign-in.');
    if (this.state.usage?.loading) return;
    const state = (this.state.usage = { buckets: [], loading: true, unavailable: false });
    this.update();
    try {
      const response = await client.request('account/rateLimits/read');
      if (this.client === client && this.state.usage === state && client.connected)
        this.state.usage = accountUsage(response);
    } catch {
      if (this.client === client && this.state.usage === state && client.connected)
        this.state.usage = { buckets: [], loading: false, unavailable: true };
    } finally {
      this.update();
    }
  }
  async dispose() {
    this.disposed = true;
    this.historyWatch?.close();
    this.ready = false;
    this.abortReviews();
    await this.client?.shutdown();
  }
  async request<T>(method: string, params: unknown = {}): Promise<T> {
    return this.runtime().request<T>(method, params);
  }
}
