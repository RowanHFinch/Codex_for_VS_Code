import { realpath } from 'node:fs/promises';
import type { IntegrationRpc } from '../integrations';
import type { Thread } from '../protocol/v2/Thread';
import type { ThreadItem } from '../protocol/v2/ThreadItem';
import { appendDelta, appendReasoningDelta, timelineItem, upsertItem } from '../runtime/events';
import type { RpcMessage } from '../runtime/client';
import { truncate, type AgentState } from '../shared';

export class AgentTasks {
  state: AgentState = { tasks: [], loading: false, limited: false };
  private threads = new Map<string, Thread>();
  private turns = new Map<string, string>();
  private revision = 0;
  private selection = 0;
  private pending = new Map<string, import('../runtime/client').RpcMessage[]>();
  private overflow = false;
  private failed = new Set<string>();
  private events = new Map<string, number>();
  get active() {
    return (
      this.overflow ||
      this.pending.size > 0 ||
      this.failed.size > 0 ||
      this.turns.size > 0 ||
      this.state.tasks.some(t => ['running', 'active', 'pendingInit', 'interrupting'].includes(t.status))
    );
  }
  private update() {
    this.state.busy = this.active;
    this.changed();
  }
  constructor(
    private rpc: IntegrationRpc,
    private root: string,
    private parent: () => string | undefined,
    private changed: () => void,
    private provider: () => string = () => 'openai',
  ) {}
  reset() {
    this.revision++;
    this.threads.clear();
    this.turns.clear();
    this.events.clear();
    this.pending.clear();
    this.failed.clear();
    this.overflow = false;
    this.state = { tasks: [], loading: false, limited: false };
  }
  async verify(id: string): Promise<Thread> {
    const parent = this.parent(),
      revision = this.revision;
    if (!parent || id === parent) throw new Error('Choose a child agent of this chat.');
    let current = id;
    const chain: { thread: Thread; event: number }[] = [],
      seen = new Set<string>();
    while (current !== parent) {
      if (seen.has(current) || chain.length >= 16) throw new Error('Invalid agent ancestry.');
      seen.add(current);
      const event = this.events.get(current) ?? 0;
      const { thread } = await this.rpc.request<{ thread: Thread }>('thread/read', {
        threadId: current,
        includeTurns: false,
      });
      if (
        thread.id !== current ||
        !thread.parentThreadId ||
        thread.modelProvider !== this.provider() ||
        (await realpath(thread.cwd)) !== this.root
      )
        throw new Error('Agent belongs to a different chat, workspace or provider.');
      chain.push({ thread, event });
      current = thread.parentThreadId;
    }
    if (revision !== this.revision || parent !== this.parent())
      throw new Error('Chat changed while checking its agents.');
    for (const { thread, event } of chain.reverse()) this.record(thread, event);
    this.failed.delete(id);
    const found = this.threads.get(id);
    if (!found) throw new Error('Agent limit reached.');
    return found;
  }
  private record(thread: Thread, event?: number) {
    if (!this.threads.has(thread.id) && this.threads.size >= 200) {
      this.overflow = true;
      this.state.limited = true;
      this.state.uncertain = true;
      this.update();
      return;
    }
    this.threads.set(thread.id, thread);
    const previous = this.state.tasks.find(t => t.id === thread.id);
    const task = {
      id: thread.id,
      parentId: thread.parentThreadId!,
      title: truncate(thread.agentNickname || thread.name || thread.preview || thread.id, 200),
      role: thread.agentRole ?? '',
      status: this.turns.has(thread.id)
        ? 'running'
        : previous && event !== undefined && event !== (this.events.get(thread.id) ?? 0)
          ? previous.status
          : thread.status.type === 'active'
            ? 'running'
            : thread.status.type,
      turnId: this.turns.get(thread.id),
    };
    this.state.tasks = [...this.state.tasks.filter(t => t.id !== thread.id), { ...previous, ...task }].slice(-200);
    this.update();
  }
  async refresh() {
    const parent = this.parent(),
      revision = this.revision;
    if (!parent) throw new Error('Open a chat first.');
    if (this.state.loading) return;
    this.state.loading = true;
    this.update();
    try {
      let cursor: string | null = null;
      const seen = new Set<string>();
      let count = 0;
      do {
        const page: { data: Thread[]; nextCursor: string | null } = await this.rpc.request('thread/list', {
          ancestorThreadId: parent,
          useStateDbOnly: true,
          sourceKinds: ['subAgent'],
          modelProviders: [this.provider()],
          cwd: this.root,
          limit: 100,
          cursor,
        });
        if (revision !== this.revision) return;
        for (const thread of page.data) {
          if (++count > 200) break;
          await this.verify(thread.id);
        }
        cursor = page.nextCursor;
        if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error('Agent pagination did not advance.');
        if (cursor) seen.add(cursor);
      } while (cursor && count < 200);
      this.state.limited = Boolean(cursor) || count > 200;
      this.state.uncertain = this.overflow || this.failed.size > 0;
    } finally {
      if (revision === this.revision) {
        this.state.loading = false;
        this.update();
      }
    }
  }
  async activeTurn(id: string) {
    const revision = this.revision,
      thread = await this.verify(id);
    const event = this.events.get(id) ?? 0;
    const page = await this.rpc.request<{ data: { id: string; status: string }[] }>('thread/turns/list', {
      threadId: id,
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'full',
    });
    if (revision !== this.revision) throw new Error('Agent connection changed.');
    if (event !== (this.events.get(id) ?? 0)) return this.turns.get(id);
    const turn = page.data.find(t => t.status === 'inProgress');
    if (turn) this.turns.set(id, turn.id);
    else this.turns.delete(id);
    const task = this.state.tasks.find(task => task.id === id);
    if (task) {
      task.turnId = turn?.id;
      task.status = turn || thread.status.type === 'active' ? 'running' : (page.data[0]?.status ?? thread.status.type);
    }
    this.update();
    return turn?.id;
  }
  hasTurn(id: string, turnId: string) {
    return this.threads.has(id) && this.turns.get(id) === turnId;
  }
  async open(id: string, more = false) {
    const revision = this.revision,
      selection = ++this.selection;
    await this.verify(id);
    const selected = this.state.selected;
    if (more && (selected?.id !== id || !selected.cursor)) return;
    const page = await this.rpc.request<any>('thread/turns/list', {
      threadId: id,
      cursor: more ? selected?.cursor : null,
      limit: 10,
      sortDirection: 'desc',
      itemsView: 'full',
    });
    const items = [];
    for (const turn of [...page.data].reverse()) {
      let rows = turn.items;
      if (turn.itemsView !== 'full') {
        rows = [];
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
          const result: any = await this.rpc.request('thread/items/list', {
            threadId: id,
            turnId: turn.id,
            limit: 100,
            cursor,
          });
          rows.push(...result.data.map((entry: { item: ThreadItem }) => entry.item));
          cursor = result.nextCursor;
          if (cursor && (seen.has(cursor) || seen.size >= 100))
            throw new Error('Agent item pagination did not advance.');
          if (cursor) seen.add(cursor);
          if (rows.length > 500) throw new Error('Agent turn is too large to display.');
        } while (cursor);
      }
      for (const item of rows) items.push(timelineItem(item, turn.id, turn.status));
      if (turn.status === 'inProgress') this.turns.set(id, turn.id);
    }
    if (revision !== this.revision || selection !== this.selection || (more && this.state.selected !== selected))
      throw new Error('Agent selection changed.');
    this.state.selected = {
      id,
      items: [...items, ...(more ? selected!.items : [])].slice(-500),
      cursor: page.nextCursor,
    };
    this.update();
  }
  private discover(id: string) {
    if (this.pending.has(id)) return;
    if (!this.threads.has(id) && this.pending.size + this.threads.size >= 200) {
      this.overflow = true;
      this.state.limited = true;
      this.state.uncertain = true;
      this.update();
      return;
    }
    const revision = this.revision,
      events: RpcMessage[] = [];
    this.pending.set(id, events);
    this.update();
    void this.verify(id)
      .then(async () => {
        if (revision !== this.revision) return;
        for (const event of events) this.notification(event);
        await this.activeTurn(id);
      })
      .catch(() => {
        if (revision === this.revision) {
          this.failed.add(id);
          this.state.uncertain = true;
        }
      })
      .finally(() => {
        if (revision === this.revision) {
          this.pending.delete(id);
          this.state.uncertain = this.overflow || this.failed.size > 0;
          this.update();
        }
      });
  }
  notification(message: RpcMessage) {
    const p = message.params as any;
    if (!p) return;
    if (
      (p.threadId === this.parent() || this.threads.has(p.threadId)) &&
      message.method === 'item/completed' &&
      p.item?.type === 'collabAgentToolCall'
    ) {
      for (const id of p.item.receiverThreadIds ?? [])
        if (typeof id === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(id)) this.discover(id);
    }
    if (
      (p.threadId === this.parent() || this.threads.has(p.threadId)) &&
      ['item/started', 'item/completed'].includes(message.method!) &&
      p.item?.type === 'subAgentActivity' &&
      typeof p.item.agentThreadId === 'string' &&
      /^[A-Za-z0-9-]{1,100}$/.test(p.item.agentThreadId)
    )
      this.discover(p.item.agentThreadId);
    if (message.method === 'thread/started') {
      const thread = p.thread as Thread;
      // Only runtime-announced descendants of an already established parent enter live routing.
      if (
        thread?.parentThreadId &&
        (thread.parentThreadId === this.parent() || this.threads.has(thread.parentThreadId)) &&
        thread.cwd === this.root &&
        thread.modelProvider === this.provider()
      )
        this.record(thread);
      return;
    }
    if (!this.threads.has(p.threadId)) {
      const pending = this.pending.get(p.threadId);
      if (pending && pending.length < 100) pending.push(message);
      return;
    }
    if (['turn/started', 'turn/completed', 'thread/status/changed'].includes(message.method!))
      this.events.set(p.threadId, (this.events.get(p.threadId) ?? 0) + 1);
    const task = this.state.tasks.find(t => t.id === p.threadId)!;
    if (message.method === 'turn/started') {
      this.turns.set(p.threadId, p.turn.id);
      task.turnId = p.turn.id;
      task.status = 'running';
    }
    if (message.method === 'turn/completed' && this.hasTurn(p.threadId, p.turn.id)) {
      this.turns.delete(p.threadId);
      task.turnId = undefined;
      task.status = p.turn.status;
    }
    if (message.method === 'thread/status/changed') {
      task.status = p.status.type === 'active' ? 'running' : p.status.type;
    }
    if (this.state.selected && this.state.selected.id === p.threadId) {
      const selected = this.state.selected;
      if (message.method === 'item/started' || message.method === 'item/completed')
        selected.items = upsertItem(selected.items, timelineItem(p.item as ThreadItem, p.turnId));
      if (message.method === 'item/reasoning/summaryTextDelta')
        selected.items = appendReasoningDelta(selected.items, p.turnId, p.itemId, p.summaryIndex, p.delta);
      if (message.method === 'item/agentMessage/delta' || message.method === 'item/commandExecution/outputDelta')
        selected.items = appendDelta(
          selected.items,
          p.turnId,
          p.itemId,
          message.method.includes('commandExecution') ? 'commandExecution' : 'agentMessage',
          p.delta,
        );
    }
    this.update();
  }
  close() {
    this.selection++;
    this.state.selected = undefined;
    this.update();
  }
}
