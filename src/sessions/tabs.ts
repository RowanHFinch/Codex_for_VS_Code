import { randomUUID } from 'node:crypto';
import { Coordinator, type SessionMetadata, type SessionStore } from './coordinator';
import { busy, type RunState } from '../shared';

export type SessionGroup = { id: string; name: string; collapsed: boolean };
export type SessionTab = {
  id: string;
  threadId?: string;
  title: string;
  status: RunState;
  error?: boolean;
  groupId?: string;
  unread: boolean;
};
type Saved = {
  version: 1;
  active: string;
  tabs: { id: string; groupId?: string; unread: boolean }[];
  groups: SessionGroup[];
  assignments: Record<string, string>;
};

export class SessionTabs {
  readonly sessions = new Map<string, Coordinator>();
  readonly metadata: SessionMetadata;
  readonly store: SessionStore;
  groups: SessionGroup[] = [];
  assignments: Record<string, string> = {};
  active: string;
  private records = new Map<string, { groupId?: string; unread: boolean; status?: RunState; threadId?: string }>();
  private visible = new Set<string>();
  private tail = Promise.resolve();
  constructor(
    store: SessionStore,
    private factory: (id: string, store: SessionStore, metadata: SessionMetadata, changed: () => void) => Coordinator,
    private changed: () => void,
  ) {
    this.store = {
      get: (key, fallback) => store.get(key, fallback),
      update: (key, value) => {
        const next = this.tail.then(() => store.update(key, value));
        this.tail = next.catch(() => {});
        return next;
      },
    };
    this.metadata = {
      owned: new Set(store.get('owned', [])),
      reviewed: new Set(store.get('reviewedThreads', [])),
      bookmarks: new Set(store.get('bookmarks', [])),
    };
    const saved = store.get<Saved | undefined>('tabs.v1', undefined);
    const valid =
      saved?.version === 1 &&
      Array.isArray(saved.tabs) &&
      saved.tabs.length > 0 &&
      saved.tabs.length <= 8 &&
      saved.tabs.every(t => t && typeof t.id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(t.id)) &&
      new Set(saved.tabs.map(t => t.id)).size === saved.tabs.length;
    this.active = valid ? saved.active : randomUUID();
    if (valid) {
      this.groups = (Array.isArray(saved.groups) ? saved.groups : [])
        .filter(
          g =>
            g &&
            /^[a-zA-Z0-9-]{1,100}$/.test(g.id) &&
            typeof g.name === 'string' &&
            g.name.trim() &&
            g.name.length <= 100,
        )
        .slice(0, 50)
        .map(g => ({ ...g, collapsed: Boolean(g.collapsed) }));
      this.assignments = Object.fromEntries(
        Object.entries(saved.assignments ?? {}).filter(
          ([id, group]) => /^[a-zA-Z0-9-]{1,100}$/.test(id) && this.groups.some(g => g.id === group),
        ),
      );
      for (const record of saved.tabs) this.create(record.id, record);
    } else this.create(this.active, { unread: false }, true);
    if (!this.sessions.has(this.active)) this.active = this.sessions.keys().next().value!;
  }
  private create(id: string, record: { groupId?: string; unread: boolean }, legacy = false) {
    this.records.set(id, {
      ...record,
      groupId: this.groups.some(g => g.id === record.groupId) ? record.groupId : undefined,
    });
    const scoped: SessionStore = {
      get: (key, fallback) =>
        key === 'draft' && !legacy
          ? fallback
          : key === 'lastThread' || key === 'draft.new'
            ? this.store.get(
                `channel.${id}.${key}`,
                legacy ? this.store.get(key, this.store.get('draft', fallback)) : fallback,
              )
            : this.store.get(key, fallback),
      update: (key, value) =>
        this.store.update(key === 'lastThread' || key === 'draft.new' ? `channel.${id}.${key}` : key, value),
    };
    const session = this.factory(id, scoped, this.metadata, () => this.updated(id));
    this.sessions.set(id, session);
    this.records.get(id)!.threadId = session.state.threadId;
    return id;
  }
  private updated(id: string) {
    const session = this.sessions.get(id),
      record = this.records.get(id);
    if (!session || !record) return;
    const prior = record.status;
    record.status = session.state.status;
    if (
      !this.visible.has(id) &&
      prior !== session.state.status &&
      ['completed', 'failed', 'waiting'].includes(session.state.status)
    )
      record.unread = true;
    const threadChanged = record.threadId !== session.state.threadId;
    if (threadChanged) {
      record.threadId = session.state.threadId;
      if (record.threadId && record.groupId) this.assignments[record.threadId] = record.groupId;
    }
    this.changed();
    if (prior !== record.status || threadChanged) void this.persist().catch(error => session.setError(error));
  }
  get(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Chat tab closed or expired.');
    return session;
  }
  find(threadId: string) {
    return [...this.sessions].find(([, c]) => c.state.threadId === threadId)?.[0];
  }
  summary(): SessionTab[] {
    const history = new Map(
      [...this.sessions.values()].flatMap(c => c.state.sessions.map(s => [s.id, s.title] as const)),
    );
    return [...this.sessions].map(([id, c]) => ({
      id,
      threadId: c.state.threadId,
      title: c.state.title || history.get(c.state.threadId ?? '') || '',
      status: c.state.status,
      error: Boolean(c.state.error),
      groupId: this.records.get(id)?.groupId,
      unread: this.records.get(id)?.unread ?? false,
    }));
  }
  setVisible(ids: string[]) {
    this.visible = new Set(ids);
  }
  async select(id: string) {
    this.get(id);
    this.active = id;
    this.records.get(id)!.unread = false;
    this.changed();
    await this.persist();
  }
  async add() {
    if (this.sessions.size >= 8) throw new Error('Close an unused chat tab before opening more (maximum eight).');
    const id = this.create(randomUUID(), { unread: false });
    await this.select(id);
    return id;
  }
  async close(id: string) {
    const session = this.get(id);
    if (
      busy(session.state.status) ||
      session.state.agents?.busy ||
      session.state.agents?.tasks.some(t => ['running', 'active', 'pendingInit'].includes(t.status))
    )
      throw new Error('Stop or finish this chat before closing its tab.');
    await session.closeChat();
    await session.dispose();
    // Create the replacement before deleting: a new tab's factory can synchronously read the still-active tab.
    if (this.sessions.size === 1) this.create(randomUUID(), { unread: false });
    this.sessions.delete(id);
    this.records.delete(id);
    if (!this.sessions.has(this.active)) this.active = this.sessions.keys().next().value!;
    this.changed();
    await this.persist();
  }
  async group(action: 'add' | 'rename' | 'remove' | 'collapse' | 'up' | 'down', id?: string, value?: string | boolean) {
    if (action === 'add') {
      if (typeof value !== 'string' || !value.trim() || value.length > 100 || this.groups.length >= 50)
        throw new Error('Use a group name between 1 and 100 characters (maximum 50 groups).');
      this.groups.push({ id: randomUUID(), name: value.trim(), collapsed: false });
    } else {
      const index = this.groups.findIndex(g => g.id === id);
      if (index < 0) throw new Error('Session group expired.');
      if (action === 'rename') {
        if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new Error('Invalid group name.');
        this.groups[index].name = value.trim();
      }
      if (action === 'collapse') this.groups[index].collapsed = Boolean(value);
      if (action === 'remove') {
        this.groups.splice(index, 1);
        for (const record of this.records.values()) if (record.groupId === id) record.groupId = undefined;
        this.assignments = Object.fromEntries(Object.entries(this.assignments).filter(([, group]) => group !== id));
      }
      if (action === 'up' || action === 'down') {
        const target = index + (action === 'up' ? -1 : 1);
        if (this.groups[target]) [this.groups[index], this.groups[target]] = [this.groups[target], this.groups[index]];
      }
    }
    this.changed();
    await this.persist();
  }
  async assign(tabId: string, groupId: string | null) {
    const c = this.get(tabId);
    if (groupId !== null && !this.groups.some(g => g.id === groupId)) throw new Error('Unknown group.');
    this.records.get(tabId)!.groupId = groupId ?? undefined;
    if (c.state.threadId) {
      if (groupId) this.assignments[c.state.threadId] = groupId;
      else delete this.assignments[c.state.threadId];
    }
    this.changed();
    await this.persist();
  }
  private persist() {
    return Promise.resolve(
      this.store.update('tabs.v1', {
        version: 1,
        active: this.active,
        tabs: [...this.records].map(([id, r]) => ({ id, groupId: r.groupId, unread: r.unread })),
        groups: this.groups.map(g => ({ ...g })),
        assignments: { ...this.assignments },
      } satisfies Saved),
    );
  }
  async dispose() {
    await Promise.allSettled([...this.sessions.values()].map(c => c.dispose()));
    await this.tail;
  }
}
