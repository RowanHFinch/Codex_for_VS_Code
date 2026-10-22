import { EventEmitter, once } from 'node:events';
import { MemoryBrowser } from './memories';
import { NativeAuth } from './runtime/auth';
import * as vscode from 'vscode';
import { realpath, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { contentHash } from './review/proposals';
import { EditorReview } from './review/editor';
import { connect, preferredRuntime, sharedConnection } from './runtime/compatibility';
import { Coordinator } from './sessions/coordinator';
import { editorContext, within, attachable, validateEditorState } from './context';
import { parseMessage } from './bridge';
import { SessionTabs } from './sessions/tabs';
import { Integrations, mcpFingerprint } from './integrations';
import { busy, type Action, type ViewState, type TimelineItem } from './shared';
import { resolveLocale } from './locale';
import { ActiveEditorContext } from './active-editor';
import { WorkspaceFiles } from './workspace-files';
import { ProposedDiffs } from './review/proposed-diff';
import { NativeEdits, RestoreConflict } from './review/native-edits';
import { workspaceDiagnostics } from './diagnostics';
import { PastedImages } from './pasted-images';
import { diagnosticReport } from './diagnostic-report';
import { planWorktree } from './worktree';
import { Dictation, Microphone } from './voice';
import { homedir } from 'node:os';
import { version as extensionVersion } from '../package.json';

const recentLog: string[] = [];

/** A static page for windows Codex cannot work in yet: no local folder, untrusted, or remote. */
function showSetupPage(webview: vscode.Webview) {
  const chinese = vscode.env.language.toLowerCase().startsWith('zh');
  const trust = !vscode.workspace.isTrusted;
  const text = trust
    ? chinese
      ? '信任这个工作区后才能使用 Codex。'
      : 'Trust this workspace to use Codex.'
    : vscode.env.remoteName
      ? chinese
        ? 'Codex for VS Code 目前只支持本地文件夹，远程窗口暂不支持。'
        : 'Codex for VS Code works with local folders; remote windows are not supported yet.'
      : chinese
        ? '打开一个本地文件夹后即可使用 Codex，它会在这个文件夹里工作。'
        : 'Open a local folder to use Codex. It works inside that folder.';
  const button = trust
    ? chinese
      ? '管理工作区信任'
      : 'Manage Workspace Trust'
    : chinese
      ? '打开文件夹'
      : 'Open Folder';
  const nonce = randomBytes(16).toString('base64');
  webview.options = { enableScripts: true };
  webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;padding:0 16px;text-align:center;gap:12px}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:4px;padding:6px 14px;cursor:pointer}p{color:var(--vscode-descriptionForeground);max-width:320px}</style></head><body><p>${text}</p>${vscode.env.remoteName && !trust ? '' : `<button id="go">${button}</button>`}<script nonce="${nonce}">const api=acquireVsCodeApi();document.getElementById('go')?.addEventListener('click',()=>api.postMessage('go'));</script></body></html>`;
  webview.onDidReceiveMessage(message => {
    if (message === 'go')
      void vscode.commands.executeCommand(trust ? 'workbench.trust.manage' : 'workbench.action.files.openFolder');
  });
}

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Codex for VS Code');
  context.subscriptions.push(output);
  // Keep the last log lines in memory for the local diagnostic report; the channel itself is write-only.
  const appendLine = output.appendLine.bind(output);
  output.appendLine = line => {
    recentLog.push(`${new Date().toISOString()} ${line}`.slice(0, 2000));
    if (recentLog.length > 200) recentLog.shift();
    appendLine(line);
  };
  let controller: Promise<ChatHost> | undefined;
  let workspaceUri = '';
  function host() {
    return (controller ??= createHost().catch(error => {
      controller = undefined;
      throw error;
    }));
  }
  async function createHost() {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting Codex.');
    if (vscode.env.remoteName) throw new Error('Open a local folder to use Codex.');
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
    if (!vscode.workspace.workspaceFolders?.length) {
      // Like the official clients' projectless chats, a window without a folder works in a folder under
      // ~/Documents/Codex, so Codex is usable before a project is opened.
      const projectless = join(homedir(), 'Documents', 'Codex', 'VS Code');
      await mkdir(projectless, { recursive: true });
      await mkdir(context.globalStorageUri.fsPath, { recursive: true, mode: 0o700 });
      workspaceUri = '';
      return new ChatHost(context, await realpath(projectless), output, workspaceUri);
    }
    if (!folders.length) throw new Error('Open a local folder to use Codex.');
    // Multi-root workspaces pick one folder as Codex's working directory; the choice is remembered.
    const remembered = context.workspaceState.get<string>('rootFolder');
    let folder = folders.find(f => f.uri.toString() === remembered) ?? (folders.length === 1 ? folders[0] : undefined);
    if (!folder) {
      folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Choose the folder Codex works in' });
      if (!folder || folder.uri.scheme !== 'file') throw new Error('Choose a local workspace folder for Codex.');
      await context.workspaceState.update('rootFolder', folder.uri.toString());
    }
    const root = await realpath(folder.uri.fsPath);
    workspaceUri = folder.uri.toString();
    await mkdir(context.globalStorageUri.fsPath, { recursive: true, mode: 0o700 });
    return new ChatHost(context, root, output, workspaceUri);
  }
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (e) {
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : 'Codex for VS Code failed');
    }
  };
  for (const [viewId, surface] of [
    ['independentCodex.chat', 'chat'],
    ['independentCodex.managerView', 'sidebar'],
  ] as const)
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        viewId,
        {
          async resolveWebviewView(view) {
            const attach = async () => {
              (await host()).bind(
                view.webview,
                view.onDidDispose,
                () => view.visible,
                listener => view.onDidChangeVisibility(listener),
                surface,
              );
            };
            try {
              await attach();
            } catch {
              // No local folder, an untrusted or remote window: explain it in the view instead of an error toast.
              showSetupPage(view.webview);
              const retry = vscode.Disposable.from(
                vscode.workspace.onDidChangeWorkspaceFolders(
                  () =>
                    void attach().then(
                      () => retry.dispose(),
                      () => {},
                    ),
                ),
                vscode.workspace.onDidGrantWorkspaceTrust(
                  () =>
                    void attach().then(
                      () => retry.dispose(),
                      () => {},
                    ),
                ),
              );
              view.onDidDispose(() => retry.dispose());
            }
          },
        },
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
    );
  context.subscriptions.push(
    vscode.commands.registerCommand('independentCodex.open', () =>
      // The view itself explains a missing folder or trust, so focusing it never fails with a toast.
      vscode.commands.executeCommand('independentCodex.chat.focus'),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('independentCodex.editor', () =>
      run(async () => {
        const h = await host();
        const panel = vscode.window.createWebviewPanel(
          'independentCodex.chat',
          'Codex for VS Code',
          vscode.ViewColumn.Beside,
          { enableScripts: true, retainContextWhenHidden: true },
        );
        h.bind(
          panel.webview,
          panel.onDidDispose,
          () => panel.visible,
          listener => panel.onDidChangeViewState(() => listener()),
          'editor',
        );
      }),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('independentCodex.addSelection', () =>
      run(async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) throw new Error('Select code in a saved workspace file.');
        const h = await host();
        await h.addContext(editor.document, editor.selection.isEmpty ? undefined : editor.selection);
        await vscode.commands.executeCommand('independentCodex.chat.focus');
      }),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('independentCodex.settings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('independentCodex.reopenClosed', () =>
      run(async () => {
        await vscode.commands.executeCommand('independentCodex.chat.focus');
        await (await host()).reopenClosed();
      }),
    ),
  );
  for (const [command, accept] of [
    ['independentCodex.acceptProposedDiff', true],
    ['independentCodex.rejectProposedDiff', false],
  ] as const)
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => run(async () => (await host()).decideActiveDiff(accept))),
    );
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.text = '$(comment-discussion) Codex';
  status.tooltip = 'Codex for VS Code';
  status.command = 'independentCodex.open';
  status.show();
  context.subscriptions.push(status);
  context.subscriptions.push(vscode.commands.registerCommand('independentCodex.logs', () => output.show()));
  context.subscriptions.push(
    vscode.commands.registerCommand('independentCodex.worktree', () => run(async () => (await host()).newWorktree())),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('independentCodex.diagnostics', () =>
      run(async () => (await host()).diagnosticReport()),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('independentCodex.instructions', () =>
      run(async () => (await host()).instructions()),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('independentCodex.checkpoints', () =>
      run(async () => (await host()).checkpoints()),
    ),
  );
  context.subscriptions.push({
    dispose() {
      void controller?.then(
        host => host.dispose(),
        () => {},
      );
    },
  });
}

type Channel = {
  review: EditorReview;
  editor: ActiveEditorContext;
  connecting: boolean;
  integrations?: Integrations;
  memories?: MemoryBrowser;
  auth?: NativeAuth;
  selectedSkills: { id: string; name: string }[];
  images: PastedImages;
  dictation?: Dictation;
  microphone?: Microphone;
  voice?: ViewState['voice'];
  voiceTarget?: { threadId: string; annotationId: string };
  voiceView?: vscode.Webview;
  enabledMcp: string[];
};
type BoundView = {
  surface: 'chat' | 'editor' | 'sidebar';
  channelId: string;
  files: WorkspaceFiles;
  visible(): boolean;
  sentChannel?: string;
  sentItems?: TimelineItem[];
};

class ChatHost {
  private chatReady = new EventEmitter();
  private views = new Map<vscode.Webview, BoundView>();
  private channels = new Map<string, Channel>();
  private tabs!: SessionTabs;
  private restoring = false;
  private managementBusy = false;
  private mcpNeedsReconnect = false;
  private opening = new Set<string>();
  private disposed = false;
  private broadcastTimer?: NodeJS.Timeout;
  private diffs: ProposedDiffs;
  private closedThreads: string[] = [];
  private edits: NativeEdits;
  /** CODEX_HOME reported by the most recent runtime connection. */
  private codexHome?: string;
  get coordinator() {
    return this.tabs.get(this.tabs.active);
  }
  get review() {
    return this.channels.get(this.tabs.active)!.review;
  }
  constructor(
    private context: vscode.ExtensionContext,
    private root: string,
    private output: vscode.OutputChannel,
    private workspaceUri: string,
  ) {
    this.diffs = new ProposedDiffs(root);
    context.subscriptions.push(this.diffs);
    this.edits = new NativeEdits(join(context.globalStorageUri.fsPath, 'native-edits', contentHash(root)), root);
    this.tabs = new SessionTabs(
      context.workspaceState,
      (id, store, metadata, changed) => {
        let coordinator!: Coordinator;
        const review = new EditorReview(
          root,
          join(context.globalStorageUri.fsPath, 'checkpoints', contentHash(root)),
          () => this.checkWorkspace(),
          value => {
            coordinator.state.review = value;
            changed();
          },
        );
        const editor = new ActiveEditorContext(root, () => this.broadcast());
        this.channels.set(id, {
          review,
          editor,
          connecting: false,
          selectedSkills: [],
          images: new PastedImages(),
          enabledMcp: [],
        });
        coordinator = new Coordinator(
          root,
          store,
          changed,
          async entries => {
            this.checkWorkspace();
            if (this.restoring || this.managementBusy || this.authPending())
              throw new Error('Wait for checkpoint restoration or integration changes.');
            if (this.mcpNeedsReconnect)
              throw new Error('Reconnect sessions from the MCP panel before sending; integration permissions changed.');
            await this.saveWorkspaceEdits();
            await validateEditorState(root, entries);
            this.checkWorkspace();
            if (this.restoring || this.managementBusy || this.authPending() || this.mcpNeedsReconnect)
              throw new Error('Integration or workspace state changed during validation. Reconnect before continuing.');
          },
          message => this.output.appendLine(message),
          (call, signal) => review.propose(call, signal),
          metadata,
          {
            fileChange: (phase, threadId, turnId, item) => {
              const work =
                phase === 'started'
                  ? this.edits.started(threadId, turnId, item.id, item.changes)
                  : this.edits.completed(item.id, item.status, { threadId, turnId, changes: item.changes });
              void work.catch(error => this.output.appendLine(`Edit checkpoint skipped: ${error}`));
            },
            settled: token => void this.diffs.settle(token),
            fileApproval: (requestId, token, changes) => {
              if (!this.views.size || !changes.length) return;
              const first = coordinator.state.decisions.find(d => d.token === token)?.changes?.[0];
              if (first)
                void this.diffs
                  .open({ channelId: id, id: requestId, token }, changes, first.path, true)
                  .catch(error => this.output.appendLine(`Diff preview unavailable: ${error}`));
            },
            diagnostics: async args => workspaceDiagnostics(root, args),
          },
        );
        return coordinator;
      },
      () => this.broadcast(),
    );
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('independentCodex')) this.broadcast();
      }),
    );
  }
  private checkWorkspace() {
    if (this.disposed) throw new Error('Extension host closed.');
    const folders = vscode.workspace.workspaceFolders;
    if (
      !vscode.workspace.isTrusted ||
      vscode.env.remoteName ||
      // A projectless window (no folder) stays valid only while it still has no folder.
      (this.workspaceUri ? !folders?.some(f => f.uri.toString() === this.workspaceUri) : Boolean(folders?.length))
    )
      throw new Error('Workspace trust or folder changed. Reload this window before continuing.');
  }
  bind(
    webview: vscode.Webview,
    onDispose: vscode.Event<void>,
    visible: () => boolean,
    onVisibility: (listener: () => void) => vscode.Disposable,
    surface: BoundView['surface'] = 'chat',
  ) {
    const bound: BoundView = { surface, channelId: this.tabs.active, files: new WorkspaceFiles(this.root), visible };
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    const nonce = randomBytes(24).toString('base64');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
    webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src data:; font-src 'none'; connect-src 'none';"><title>Codex for VS Code</title><link rel="stylesheet" href="${css}"></head><body data-surface="${surface}"><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
    this.views.set(webview, bound);
    // Per-view listeners end with the view; keeping them in the extension's subscriptions leaked one set per panel.
    const listeners: vscode.Disposable[] = [
      onVisibility(() => {
        if (!visible()) void this.cancelVoice(bound.channelId, webview);
        bound.sentItems = undefined;
        this.broadcast();
      }),
    ];
    listeners.push(
      onDispose(() => {
        void this.cancelVoice(bound.channelId, webview);
        this.views.delete(webview);
        bound.files.dispose();
        for (const listener of listeners) listener.dispose();
        this.broadcast();
      }),
    );
    listeners.push(
      webview.onDidReceiveMessage(input => {
        let message: ReturnType<typeof parseMessage>;
        try {
          message = parseMessage(input);
        } catch {
          this.broadcast();
          return;
        }
        void this.action(message.action, message.channelId, webview, bound)
          .catch(error => {
            const action = message.action;
            if (action.type === 'findFiles')
              void webview.postMessage({
                type: 'fileResults',
                channelId: message.channelId,
                requestId: action.requestId,
                files: [],
                limited: false,
                failed: true,
              });
            if (action.type === 'attachFile')
              void webview.postMessage({
                type: 'fileAttached',
                channelId: message.channelId,
                id: action.id,
                ok: false,
              });
            if (action.type === 'selectSkill')
              void webview.postMessage({
                type: 'skillAttached',
                channelId: message.channelId,
                id: action.id,
                ok: false,
              });
            const target = action.type === 'selectTab' ? action.id : message.channelId;
            if (target && this.tabs.sessions.has(target)) this.tabs.get(target).setError(error);
          })
          .finally(() => {
            if (message.action.type === 'refreshIntegrations')
              void webview.postMessage({
                type: 'integrationsRefreshed',
                channelId: message.channelId,
                requestId: message.action.requestId,
              });
          });
      }),
    );
    this.broadcast();
    if (surface === 'chat') this.chatReady.emit('ready', webview);
  }
  private broadcast() {
    if (this.disposed || this.broadcastTimer) return;
    // Coalesce streaming bursts; state and approvals remain authoritative in the host.
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined;
      this.flushBroadcast();
    }, 16);
  }
  private flushBroadcast() {
    if (!this.tabs || this.disposed) return;
    const config = vscode.workspace.getConfiguration('independentCodex');
    this.tabs.setVisible(
      [...this.views.values()].filter(v => v.surface !== 'sidebar' && v.visible()).map(v => v.channelId),
    );
    const tabs = this.tabs.summary();
    for (const [view, bound] of this.views) {
      if (!bound.visible()) {
        void this.cancelVoice(bound.channelId, view);
        continue;
      }
      if (bound.surface === 'sidebar') bound.channelId = this.tabs.active;
      if (!this.tabs.sessions.has(bound.channelId)) bound.channelId = this.tabs.active;
      const c = this.tabs.get(bound.channelId),
        channel = this.channels.get(bound.channelId)!;
      c.state.locale = resolveLocale(config.get('locale', 'auto'), vscode.env.language);
      c.state.sendKey = config.get('sendKey', 'enter');
      const state = {
        ...c.state,
        // Hidden panels receive a fresh snapshot on reveal; the manager never needs transcript bytes.
        items:
          bound.surface === 'sidebar'
            ? []
            : bound.sentChannel === bound.channelId && bound.sentItems === c.state.items
              ? undefined
              : c.state.items,
        ...(bound.surface === 'sidebar'
          ? {
              side: undefined,
              agents: undefined,
              review: undefined,
              decisions: [],
              contexts: [],
              annotations: [],
              turnChanges: undefined,
            }
          : {}),
        channelId: bound.channelId,
        tabs,
        groups: this.tabs.groups,
        groupAssignments: this.tabs.assignments,
        activeEditor: channel.editor.preview(c.state.contexts),
        editorContextPending: channel.editor.pending,
        editorContextUnavailable: channel.editor.unavailable,
        auth: channel.auth?.state,
        memories: channel.memories?.state,
        integrations: channel.integrations?.state,
        ecosystem: channel.integrations?.ecosystem,
        integrationBusy: this.managementBusy || this.restoring || channel.connecting || c.state.operationBusy,
        integrationMutationBusy: this.anyBusy(),
        selectedSkills: channel.selectedSkills,
        voice: channel.voice,
        projectless: this.workspaceUri ? undefined : this.root.replace(homedir(), '~'),
        images: channel.images.list(c.state.threadId).map(({ id, name }) => ({ id, name })),
        enabledMcp: channel.enabledMcp,
      };
      bound.sentChannel = bound.channelId;
      bound.sentItems = c.state.items;
      try {
        void view.postMessage({ type: 'state', state }).then(
          delivered => {
            if (!delivered) bound.sentItems = undefined;
          },
          () => {
            void this.cancelVoice(bound.channelId, view);
            this.views.delete(view);
            bound.files.dispose();
          },
        );
      } catch {
        void this.cancelVoice(bound.channelId, view);
        this.views.delete(view);
        bound.files.dispose();
      }
    }
  }
  private async select(view: vscode.Webview, id: string) {
    this.tabs.get(id);
    const bound = this.views.get(view);
    if (!bound) throw new Error('Chat view closed.');
    if (bound.surface === 'sidebar') {
      const existing = [...this.views].find(([, view]) => view.surface === 'chat')?.[0];
      // Focusing a VS Code view can finish before its async provider binds the webview.
      const [chatView] = await Promise.all([
        existing ??
          once(this.chatReady, 'ready', { signal: AbortSignal.timeout(10000) }).then(
            ([view]) => view as vscode.Webview,
          ),
        vscode.commands.executeCommand('independentCodex.chat.focus'),
      ]);
      const chat = this.views.get(chatView);
      if (!chat) throw new Error('Chat view closed.');
      if (chat.channelId !== id) await this.cancelVoice(chat.channelId, chatView);
      // Reset local navigation even when selecting the already active chat.
      await chatView.postMessage({ type: 'showChat' });
      chat.files.dispose();
      chat.files = new WorkspaceFiles(this.root);
      chat.channelId = id;
    }
    if (bound.channelId !== id) await this.cancelVoice(bound.channelId, view);
    bound.files.dispose();
    bound.files = new WorkspaceFiles(this.root);
    bound.channelId = id;
    await this.tabs.select(id);
    this.broadcast();
    const session = this.tabs.get(id),
      channel = this.channels.get(id);
    if (
      vscode.workspace.isTrusted &&
      session.state.status === 'offline' &&
      !session.state.runtimeVersion &&
      channel &&
      !channel.connecting &&
      !this.managementBusy &&
      !this.restoring
    )
      await this.connectChannel(id);
  }
  private async cancelVoice(channelId: string, owner?: vscode.Webview) {
    const channel = this.channels.get(channelId);
    if (!channel || (owner && channel.voiceView !== owner)) return;
    const dictation = channel.dictation,
      view = channel.voiceView;
    channel.dictation = undefined;
    channel.microphone?.release();
    channel.microphone = undefined;
    channel.voice = { status: 'idle' };
    channel.voiceTarget = undefined;
    channel.voiceView = undefined;
    try {
      if (view) void Promise.resolve(view.postMessage({ type: 'voiceFailed', channelId })).catch(() => {});
    } catch {
      /* The recording's view may already be disposed. */
    }
    await dictation?.dispose();
    this.broadcast();
  }
  private grants() {
    return this.context.workspaceState.get<Record<string, string>>('mcpGrants', {});
  }
  private async connectChannel(id: string) {
    const startedAt = performance.now();
    const c = this.tabs.get(id),
      channel = this.channels.get(id)!;
    if (channel.connecting || c.state.operationBusy || busy(c.state.status))
      throw new Error('Wait for this chat operation to finish before reconnecting.');
    channel.connecting = true;
    c.state.status = 'connecting';
    c.state.error = undefined;
    this.broadcast();
    try {
      const runtime = await connect(
        vscode.workspace.getConfiguration('independentCodex').get('runtimePath', 'codex'),
        this.root,
        this.grants(),
      );
      try {
        this.checkWorkspace();
        this.tabs.get(id);
      } catch (error) {
        runtime.client.stop();
        throw error;
      }
      channel.auth?.dispose();
      channel.memories?.clear();
      channel.enabledMcp = runtime.enabledMcp;
      const mode = vscode.workspace
        .getConfiguration('independentCodex')
        .get<string>('initialPermissionMode', 'askBeforeEdits');
      if (runtime.settings && mode !== 'codexConfig')
        runtime.settings.approval = mode === 'editAutomatically' ? 'on-request' : 'untrusted';
      await c.attach(runtime.client, runtime.version, runtime.settings);
      this.output.appendLine(
        `Performance: connection ready in ${Math.round(performance.now() - startedAt)} ms (${runtime.version}).`,
      );
      this.codexHome = runtime.codexHome;
      const control = sharedConnection(() =>
        connect(vscode.workspace.getConfiguration('independentCodex').get('runtimePath', 'codex'), this.root, {}, true),
      );
      const writer = {
        request: <T>(method: string, params?: unknown) =>
          control(async connection => {
            const file = join(runtime.codexHome, 'config.toml');
            if (
              [
                'config/value/write',
                'config/batchWrite',
                'skills/config/write',
                'plugin/install',
                'plugin/uninstall',
              ].includes(method)
            )
              await this.assertManagementWrite(file);
            else await this.assertConfigClean(file);
            return connection.client.request<T>(method, params);
          }),
      };
      channel.integrations = new Integrations(
        c,
        this.root,
        runtime.codexHome,
        () => this.grants(),
        () => this.checkWorkspace(),
        () => this.broadcast(),
        () => this.assertManagementWrite(join(runtime.codexHome, 'config.toml')),
        writer,
      );
      channel.memories = new MemoryBrowser(
        runtime.codexHome,
        () => this.checkWorkspace(),
        () => this.broadcast(),
      );
      channel.auth = new NativeAuth(runtime.client, () => this.broadcast());
      const catalog = channel.integrations;
      // Optional inventory must not gate Send or turn a healthy connection into an offline chat.
      void catalog.refresh(c.state.writable ? c.state.threadId : undefined).catch(() => {
        if (!this.disposed && this.channels.get(id)?.integrations === catalog) {
          catalog.state.notice = 'Integration inventory unavailable. Open Skills or MCP and refresh to retry.';
          this.output.appendLine('Integration inventory refresh failed.');
          this.broadcast();
        }
      });
    } catch (error) {
      c.state.status = c.state.threadId ? 'unknown' : 'offline';
      throw error;
    } finally {
      channel.connecting = false;
      this.broadcast();
    }
  }
  async addContext(
    document: vscode.TextDocument,
    selection?: vscode.Range,
    expectedThread?: string | null,
    channelId = this.tabs.active,
  ) {
    this.checkWorkspace();
    const c = this.tabs.get(channelId),
      thread = expectedThread === undefined ? (c.state.threadId ?? null) : expectedThread;
    if (busy(c.state.status)) throw new Error('Finish this turn before adding a file.');
    const entry = await editorContext(this.root, document, selection);
    this.checkWorkspace();
    if (this.tabs.get(channelId) !== c || thread !== (c.state.threadId ?? null) || busy(c.state.status))
      throw new Error('Chat changed while adding context. Choose the file again.');
    c.state.contexts = [...c.state.contexts.filter(e => e.uri !== entry.uri && e.path !== entry.path), entry].slice(-8);
    this.broadcast();
  }
  private async saveWorkspaceEdits() {
    if (!vscode.workspace.getConfiguration('independentCodex').get('autosave', true)) return;
    for (const document of vscode.workspace.textDocuments)
      if (document.isDirty && document.uri.scheme === 'file' && within(this.root, document.uri.fsPath))
        await document.save();
  }
  private async decide(channelId: string, action: Extract<Action, { type: 'decision' }>) {
    const c = this.tabs.get(channelId),
      decision = c.decision(action.id, action.token);
    if (action.accept && decision.method !== 'mcpServer/elicitation/request') {
      await this.saveWorkspaceEdits();
      await validateEditorState(this.root, []);
    }
    this.checkWorkspace();
    if (action.accept && decision.method === 'mcpServer/elicitation/request' && !decision.form) {
      const url = c.authorization(action.id, action.token);
      try {
        if (!(await vscode.env.openExternal(vscode.Uri.parse(url)))) throw new Error();
      } catch {
        throw new Error('Could not open the MCP authorization page. No acceptance was sent.');
      }
    }
    this.checkWorkspace();
    c.decide(action.id, action.token, action.answers, action.cancel, action.accept, action.content, action.session);
  }
  async reopenClosed() {
    const threadId = this.closedThreads.pop();
    if (!threadId) throw new Error('No closed chat to reopen.');
    const view = [...this.views].find(([, bound]) => bound.surface === 'chat')?.[0];
    if (!view) throw new Error('Open the Codex chat view first.');
    const existing = this.tabs.find(threadId);
    if (existing) return this.select(view, existing);
    const id = await this.tabs.add();
    await this.select(view, id);
    await this.tabs.get(id).openThread(threadId);
  }
  /** Accept or reject the pending change shown in the active diff editor. */
  async decideActiveDiff(accept: boolean) {
    const owner = this.diffs.activeOwner();
    if (!owner || !this.tabs.sessions.has(owner.channelId)) throw new Error('This change is no longer pending.');
    const c = this.tabs.get(owner.channelId),
      paths = c.decision(owner.id, owner.token).changes?.map(change => change.path) ?? [];
    if (accept && paths.length > 1) {
      const chinese = c.state.locale === 'zh-CN',
        label = chinese ? `接受全部 ${paths.length} 个文件` : `Accept all ${paths.length} files`;
      if (
        (await vscode.window.showWarningMessage(
          chinese
            ? `此请求会一起修改这些文件：\n${paths.join('\n')}`
            : `This request changes all of these files together:\n${paths.join('\n')}`,
          { modal: true },
          label,
        )) !== label
      )
        return;
    }
    await this.decide(owner.channelId, { type: 'decision', id: owner.id, token: owner.token, accept });
  }
  private async openTurnFile(c: Coordinator, turnId: string, path: string) {
    const full = join(this.root, path);
    if (!within(this.root, full)) throw new Error('This file is outside the workspace.');
    const record = (await this.edits.list(c.state.threadId)).find(r => r.turnId === turnId && r.path === path);
    if (record) await this.diffs.openSnapshot(path, record.before, full);
    else await vscode.window.showTextDocument(vscode.Uri.file(full));
  }
  private async openTurnChanges(c: Coordinator, turnId: string, chinese: boolean) {
    const threadId = c.state.threadId;
    const files = c.state.turnChanges?.[turnId] ?? [];
    if (!files.length) return;
    const selected =
      files.length === 1
        ? { label: files[0].path }
        : await vscode.window.showQuickPick(
            files.map(file => ({ label: file.path, description: `+${file.added} −${file.removed}` })),
            { placeHolder: chinese ? '选择要查看的文件变更' : 'Choose a file to review its changes' },
          );
    if (selected && c.state.threadId === threadId) await this.openTurnFile(c, turnId, selected.label);
  }
  private async undoTurns(c: Coordinator, turnIds: string[], chinese: boolean, confirm = true) {
    const records = (await this.edits.list(c.state.threadId)).filter(
      r => turnIds.includes(r.turnId) && r.state === 'applied',
    );
    if (!records.length) {
      if (confirm)
        void vscode.window.showInformationMessage(
          chinese ? '这一轮没有可以撤销的已记录文件改动。' : 'No recorded file edits to undo for this turn.',
        );
      return;
    }
    const files = [...new Set(records.map(r => r.path))];
    const label = chinese ? '撤销改动' : 'Undo changes';
    if (
      confirm &&
      (await vscode.window.showWarningMessage(
        chinese
          ? `撤销 Codex 对这些文件的改动？\n${files.join('\n')}`
          : `Undo Codex changes to these files?\n${files.join('\n')}`,
        { modal: true },
        label,
      )) !== label
    )
      return;
    this.checkWorkspace();
    // A rewind runs inside this chat's own exclusive operation, so only other chats must be idle.
    if (this.anyBusy(confirm ? undefined : c) || this.restoring)
      throw new Error('Finish active tasks before restoring files.');
    this.restoring = true;
    try {
      return (
        await this.edits.restore(records, full =>
          vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.scheme === 'file' && d.uri.fsPath === full),
        )
      ).rollback;
    } catch (error) {
      if (error instanceof RestoreConflict)
        throw new Error(
          chinese ? `这些文件在 Codex 修改后又被改过，未做任何恢复：${error.paths.join('、')}` : error.message,
        );
      throw error;
    } finally {
      this.restoring = false;
      this.broadcast();
    }
  }
  async instructions() {
    const uri = vscode.Uri.file(join(this.root, 'AGENTS.md'));
    try {
      if (!within(this.root, await realpath(uri.fsPath)))
        throw new Error('Instruction path is outside this workspace.');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument({ language: 'markdown', content: '# Project instructions\n' }),
      );
    }
  }
  private authPending() {
    return [...this.channels.values()].some(channel => channel.auth?.state?.status === 'pending');
  }
  private anyBusy(except?: Coordinator) {
    return (
      [...this.tabs.sessions.values()].some(
        c =>
          c !== except &&
          (c.unresolvedWork ||
            c.state.operationBusy ||
            busy(c.state.status) ||
            c.state.agents?.busy ||
            c.state.agents?.tasks.some(t => ['running', 'active', 'pendingInit'].includes(t.status))),
      ) || [...this.channels.values()].some(channel => channel.connecting)
    );
  }
  /** Creates a git worktree from HEAD and opens it in a new window, where a new chat starts. */
  async newWorktree() {
    this.checkWorkspace();
    const chinese = vscode.env.language.toLowerCase().startsWith('zh');
    const branch = await vscode.window.showInputBox({
      title: chinese ? '在新的 worktree 中开始对话' : 'New chat in a worktree',
      prompt: chinese ? '新分支名称（留空则为 detached HEAD）' : 'New branch name (leave empty for a detached HEAD)',
    });
    if (branch === undefined) return;
    const plan = await planWorktree(
      this.root,
      this.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      branch.trim() || undefined,
    );
    const create = chinese ? '创建并打开' : 'Create and open';
    const detail = [
      `${chinese ? '仓库' : 'Repository'}: ${plan.repository}`,
      `${chinese ? '基于' : 'Base'}: HEAD ${plan.head}${plan.branch ? ` → ${plan.branch}` : ''}`,
      `${chinese ? '位置' : 'Location'}: ${plan.path}`,
      ...(plan.dirty
        ? [
            chinese
              ? '当前有未提交的修改，它们会留在原目录，不会带到新的 worktree。'
              : 'Uncommitted changes stay in this folder; they are not copied into the worktree.',
          ]
        : []),
    ].join('\n');
    if (
      (await vscode.window.showInformationMessage(
        chinese ? '创建 git worktree？' : 'Create a git worktree?',
        { modal: true, detail },
        create,
      )) !== create
    )
      return;
    await plan.create();
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(plan.path), { forceNewWindow: true });
  }
  /** Plans are reviewed as real files in extension storage (not the workspace), so editing and dirty state are native. */
  private plan(c: Coordinator, itemId: string) {
    const item = c.state.items.find(i => i.id === itemId && i.type === 'plan');
    if (!item || item.truncated || !c.state.threadId) throw new Error('That plan is no longer loaded in full.');
    if (item.status === 'inProgress') throw new Error('Wait for the plan to finish before reviewing it.');
    const name = createHash('sha256').update(`${c.state.threadId}/${itemId}`).digest('hex').slice(0, 24);
    return { item, path: join(this.context.globalStorageUri.fsPath, 'plans', `${name}.md`) };
  }
  async openPlan(c: Coordinator, itemId: string) {
    const { item, path } = this.plan(c, itemId);
    await mkdir(join(this.context.globalStorageUri.fsPath, 'plans'), { recursive: true });
    // Keep earlier edits: only the first open writes the plan as the runtime produced it.
    await writeFile(path, item.text, { flag: 'wx' }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false });
  }
  /** Sends exactly the saved plan revision the user confirmed; unsaved edits block instead of being guessed at. */
  async proceedPlan(c: Coordinator, itemId: string, chinese: boolean) {
    const { item, path } = this.plan(c, itemId);
    if (vscode.workspace.textDocuments.some(d => d.uri.fsPath === path && d.isDirty))
      throw new Error(chinese ? '请先保存计划文档，再继续执行。' : 'Save the plan document before proceeding.');
    const text = await readFile(path, 'utf8').catch(() => item.text);
    if (!text.trim() || text.length > 90_000)
      throw new Error(chinese ? '计划为空或过长。' : 'The plan is empty or too long.');
    const revision = createHash('sha256').update(text).digest('hex').slice(0, 8);
    const go = chinese ? '按此计划执行' : 'Proceed';
    const detail = [
      text === item.text
        ? chinese
          ? '使用 Codex 给出的原始计划。'
          : 'Uses the plan as Codex wrote it.'
        : chinese
          ? '使用你编辑并保存过的计划。'
          : 'Uses your edited, saved plan.',
      c.state.mode === 'plan'
        ? chinese
          ? '会先退出规划模式，按当前权限设置执行。'
          : 'Leaves Plan mode first and runs with the current permission settings.'
        : chinese
          ? '按当前权限设置执行。'
          : 'Runs with the current permission settings.',
    ].join('\n');
    const title = chinese ? `按计划修订版 ${revision} 执行？` : `Proceed with plan revision ${revision}?`;
    const threadId = c.state.threadId;
    if ((await vscode.window.showInformationMessage(title, { modal: true, detail }, go)) !== go) return;
    if (c.state.threadId !== threadId)
      throw new Error(chinese ? '对话已切换，计划没有发送。' : 'The chat changed; the plan was not sent.');
    if (c.state.mode === 'plan') await c.configure(c.state.model, c.state.effort, 'default');
    await c.send(
      `Implement the following reviewed plan (revision ${revision}). If it no longer fits the code, stop and explain instead of improvising.\n\n${text}`,
    );
  }
  /** Opens a redacted local report as an untitled document; nothing is sent. */
  async diagnosticReport() {
    const tabs = [];
    for (const c of this.tabs.sessions.values()) {
      let diagnostics: unknown, error: string | undefined;
      if (c.state.runtimeVersion && !['offline', 'connecting'].includes(c.state.status))
        try {
          diagnostics = await c.request('server/diagnostics');
        } catch (e) {
          error = e instanceof Error ? e.message : 'unavailable';
        }
      tabs.push({
        status: c.state.status,
        account: c.state.account,
        provider: c.provider,
        runtimeVersion: c.state.runtimeVersion,
        writable: c.state.writable,
        owned: c.state.owned,
        diagnostics,
        error,
      });
    }
    const content = diagnosticReport({
      extensionVersion,
      vscodeVersion: vscode.version,
      platform: process.platform,
      arch: process.arch,
      tabs,
      log: recentLog,
      home: homedir(),
    });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content, language: 'markdown' }));
  }
  async checkpoints(channelId = this.tabs.active) {
    this.checkWorkspace();
    if (this.anyBusy() || this.restoring || this.managementBusy || this.authPending())
      throw new Error('Finish active tasks before restoring workspace files.');
    const c = this.tabs.get(channelId),
      review = this.channels.get(channelId)!.review,
      chinese = c.state.locale === 'zh-CN';
    const records = (await review.journal.list()).filter(r => r.state !== 'restored');
    if (!records.length) {
      void vscode.window.showInformationMessage(
        chinese ? '此工作区还没有编辑检查点。' : 'No edit checkpoints in this workspace.',
      );
      return;
    }
    const choice = await vscode.window.showQuickPick(
      records.map(record => ({
        label: record.path,
        description: record.createdAt,
        detail: `${record.state} · ${record.threadId}`,
        record,
      })),
      { placeHolder: chinese ? '选择检查点以恢复此前文本' : 'Choose a checkpoint to restore previous text' },
    );
    if (!choice) return;
    await review.previewRestore(choice.record.id);
    const label = chinese ? '恢复文本' : 'Restore text';
    if (
      (await vscode.window.showWarningMessage(
        chinese
          ? '恢复此次编辑之前的文本？后续手工改动会阻止恢复。保存仍由你或编辑器控制。'
          : 'Restore text from before this edit? Later manual changes block restoration. You or editor autosave control saving.',
        { modal: true },
        label,
      )) !== label
    )
      return;
    this.checkWorkspace();
    if (this.anyBusy() || this.managementBusy || this.restoring)
      throw new Error('A task, configuration change or restoration started. Finish it before restoring.');
    this.restoring = true;
    try {
      await review.restore(choice.record.id);
    } finally {
      this.restoring = false;
      this.broadcast();
    }
  }
  private catalog(id: string) {
    const catalog = this.channels.get(id)?.integrations;
    if (!catalog) throw new Error('Connect this chat to load Skills and MCP servers.');
    return catalog;
  }
  private async assertConfigClean(path: string) {
    this.checkWorkspace();
    let canonical = path;
    try {
      canonical = await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme !== 'file' || !document.isDirty) continue;
      let target = document.uri.fsPath;
      try {
        target = await realpath(target);
      } catch {
        /* Unsaved new files still compare by their intended path. */
      }
      if (target === canonical)
        throw new Error('Save or discard the open Codex configuration before changing integrations.');
    }
  }
  private async manage(id: string, job: (catalog: Integrations) => Promise<void>, endAuth = false) {
    this.checkWorkspace();
    if (this.managementBusy || this.restoring || this.anyBusy() || (!endAuth && this.authPending()))
      throw new Error('Finish active turns before changing integrations.');
    const catalog = this.catalog(id);
    this.managementBusy = true;
    this.broadcast();
    try {
      await this.assertConfigClean(catalog.configPath);
      await job(catalog);
    } finally {
      this.managementBusy = false;
      this.broadcast();
    }
  }
  private async assertManagementWrite(file: string) {
    await this.assertConfigClean(file);
    if (this.restoring || this.anyBusy())
      throw new Error(
        'A Codex task or connection started during confirmation. Finish it before changing shared configuration.',
      );
  }
  private async reconnectSessions() {
    this.mcpNeedsReconnect = true;
    for (const [id, session] of this.tabs.sessions) if (session.state.runtimeVersion) await this.connectChannel(id);
    this.mcpNeedsReconnect = false;
  }
  private async action(action: Action, channelId: string | null, webview: vscode.Webview, bound: BoundView) {
    if (
      bound.surface === 'sidebar' &&
      ![
        'ready',
        'settings',
        'connect',
        'refresh',
        'refreshUsage',
        'search',
        'moreSessions',
        'newTab',
        'selectTab',
        'open',
      ].includes(action.type)
    )
      throw new Error('This action is not available in the session sidebar.');
    if (action.type === 'ready') {
      bound.sentItems = undefined;
      this.broadcast();
      // Like Claudian, start the runtime as soon as a chat is shown; it reuses this machine's Codex sign-in.
      const id = bound.channelId,
        session = this.tabs.sessions.get(id),
        channel = this.channels.get(id);
      if (
        vscode.workspace.isTrusted &&
        session?.state.status === 'offline' &&
        !session.state.runtimeVersion &&
        channel &&
        !channel.connecting
      )
        void this.connectChannel(id).catch(error => {
          session.setError(error);
          this.broadcast();
        });
      return;
    }
    if (action.type === 'settings') {
      await vscode.commands.executeCommand('independentCodex.settings');
      return;
    }
    if (action.type === 'diagnostics') return this.diagnosticReport();
    if (action.type === 'worktree') return this.newWorktree();
    if (action.type === 'logs') {
      this.output.show();
      return;
    }
    this.checkWorkspace();
    if (!channelId || (bound.channelId !== channelId && action.type !== 'draft'))
      throw new Error('This action belongs to another chat tab.');
    const c = this.tabs.get(channelId),
      channel = this.channels.get(channelId)!,
      chinese = c.state.locale === 'zh-CN';
    if ((this.restoring || this.managementBusy || channel.connecting) && !['draft', 'selectTab'].includes(action.type))
      throw new Error('Wait for connection, restoration or integration changes.');
    switch (action.type) {
      case 'selectTab':
        await this.select(webview, action.id);
        break;
      case 'newTab': {
        if (this.mcpNeedsReconnect) throw new Error('Reconnect integrations before creating a chat.');
        // An empty tab already is a new chat; reuse it instead of piling up tabs.
        if (!c.state.threadId && !c.state.draft.trim() && !c.state.contexts.length && !busy(c.state.status)) {
          await this.select(webview, channelId);
          break;
        }
        const id = await this.tabs.add();
        await this.select(webview, id);
        // The chat itself starts with the first message (see 'send'), saving a thread/start per tab.
        break;
      }
      case 'closeTab':
      case 'closeChat': {
        const id = action.type === 'closeTab' ? action.id : channelId;
        if (action.type === 'closeChat' && c.state.threadId !== action.threadId) throw new Error('Chat changed.');
        const closedThread = this.tabs.get(id).state.threadId;
        await this.cancelVoice(id);
        await this.tabs.close(id);
        if (closedThread)
          this.closedThreads = [...this.closedThreads.filter(t => t !== closedThread), closedThread].slice(-10);
        // Detach first so work finishing during disposal sees the tab as closed.
        const closing = this.channels.get(id);
        this.channels.delete(id);
        closing?.auth?.dispose();
        closing?.memories?.clear();
        closing?.editor.dispose();
        closing?.review.dispose();
        const dictation = closing?.dictation;
        closing?.microphone?.release();
        if (closing) closing.dictation = closing.microphone = undefined;
        await dictation?.dispose();
        await closing?.images.dispose();
        for (const view of this.views.values())
          if (view.channelId === id) {
            view.channelId = this.tabs.active;
            view.files.dispose();
            view.files = new WorkspaceFiles(this.root);
          }
        this.broadcast();
        const next = this.tabs.active;
        if (this.tabs.get(next).state.status === 'offline' && !this.tabs.get(next).state.runtimeVersion)
          await this.connectChannel(next).catch(error => this.tabs.get(next).setError(error));
        break;
      }
      case 'connect':
        await this.connectChannel(channelId);
        break;
      case 'new':
        if (this.mcpNeedsReconnect) throw new Error('Reconnect integrations before creating a chat.');
        await this.cancelVoice(channelId);
        await c.newThread();
        channel.images.adopt(c.state.threadId);
        break;
      case 'newReviewed': {
        if (c.state.threadId) {
          const id = await this.tabs.add();
          await this.select(webview, id);
          await this.tabs.get(id).newThread(true);
        } else {
          await this.cancelVoice(channelId);
          await c.newThread(true);
          channel.images.adopt(c.state.threadId);
        }
        break;
      }
      case 'continue':
      case 'fork': {
        if (this.mcpNeedsReconnect) throw new Error('Reconnect integrations before continuing.');
        const thread = c.state.threadId,
          label = chinese ? '继续聊天' : 'Continue chat';
        // Chats this extension created resume without a prompt; foreign history still asks first.
        if (
          action.type === 'continue' &&
          !c.state.owned &&
          (await vscode.window.showWarningMessage(
            c.state.locale === 'zh-CN'
              ? '继续将使用当前 Codex 原生权限和工具，并可能运行会话中已有的排队任务。请先检查历史并关闭其他客户端中的写入者。'
              : 'Continue with native Codex permissions and tools? Existing queued work may run. Inspect history and close other writing clients first.',
            { modal: true },
            label,
          )) !== label
        )
          break;
        if (thread !== c.state.threadId) throw new Error('Chat changed during confirmation.');
        if (action.type === 'fork') {
          const id = await this.tabs.add(),
            next = this.tabs.get(id);
          await this.select(webview, id);
          await next.configure(c.state.model, c.state.effort, c.state.mode);
          await next.configurePolicy(c.state.profile, c.state.approval, c.state.reviewer);
          await next.continueThread(true, thread);
        } else await c.continueThread();
        break;
      }
      case 'nativePolicy': {
        if (action.profile === ':danger-full-access') {
          const label = chinese ? '使用完全访问' : 'Use full access';
          if (
            (await vscode.window.showWarningMessage(
              c.state.locale === 'zh-CN'
                ? '完全访问会允许原生 Agent 在沙箱之外执行操作。'
                : 'Full access lets the native agent operate outside the sandbox.',
              { modal: true },
              label,
            )) !== label
          )
            break;
        }
        await c.configurePolicy(action.profile, action.approval, action.reviewer);
        break;
      }
      case 'permissionMode': {
        if (action.value === 'plan') {
          await c.configure(c.state.model, c.state.effort, 'plan');
          break;
        }
        // The official presets: approval policy, reviewer and, for Full access, the sandbox profile.
        if (action.value === 'full') {
          const label = chinese ? '使用完全访问' : 'Use full access';
          if (
            (await vscode.window.showWarningMessage(
              chinese
                ? '完全访问会允许 Codex 不受限制地访问网络和电脑上的任何文件。'
                : 'Full access lets Codex use the internet and any file on your computer without restriction.',
              { modal: true },
              label,
            )) !== label
          )
            break;
        }
        if (c.state.mode !== 'default') await c.configure(c.state.model, c.state.effort, 'default');
        const sandboxed = c.state.profile === ':danger-full-access' ? ':workspace' : c.state.profile;
        if (action.value === 'full') await c.configurePolicy(':danger-full-access', 'never', 'user');
        else
          await c.configurePolicy(
            sandboxed,
            action.value === 'review' ? 'untrusted' : 'on-request',
            action.value === 'auto' ? 'auto_review' : 'user',
          );
        break;
      }
      case 'memory':
        await c.memory(action.enabled);
        break;
      case 'followup':
        if (action.threadId !== c.state.threadId || this.mcpNeedsReconnect)
          throw new Error('Chat or integration state changed.');
        else {
          const images = channel.images.list(action.threadId);
          await c.followup(
            action.text,
            action.delivery,
            images.map(i => i.path),
          );
          channel.images.sent(action.threadId, images);
          this.broadcast();
        }
        break;
      case 'removeQueued':
        await c.removeQueued(action.id);
        break;
      case 'refresh':
        await c.listSessions();
        break;
      case 'moreSessions':
        await c.listSessions(true);
        break;
      case 'moreHistory':
        if (!busy(c.state.status)) await c.loadHistory();
        break;
      case 'refreshUsage':
        await c.refreshUsage();
        break;
      case 'open': {
        const existing = this.tabs.find(action.threadId);
        if (existing) {
          const target = this.tabs.get(existing);
          try {
            await this.select(webview, existing);
          } catch (error) {
            target.setError(error);
          }
          break;
        }
        if (!c.state.sessions.some(s => s.id === action.threadId))
          throw new Error('Choose a loaded workspace session.');
        if (this.opening.has(action.threadId)) throw new Error('This conversation is already opening.');
        this.opening.add(action.threadId);
        let target: Coordinator | undefined;
        try {
          const id = await this.tabs.add(),
            next = this.tabs.get(id);
          target = next;
          await this.select(webview, id);
          await next.openThread(action.threadId);
          const group = this.tabs.assignments[action.threadId];
          if (group) await this.tabs.assign(id, group);
        } catch (error) {
          if (!target) throw error;
          target.setError(error);
        } finally {
          this.opening.delete(action.threadId);
        }
        break;
      }
      case 'send': {
        // The first message in an empty tab starts its chat, like typing into a fresh Claude Code panel.
        const started = action.threadId === null && !c.state.threadId;
        const editor = channel.editor.capture(action.contextId, c.state.contexts);
        if (started) {
          if (this.mcpNeedsReconnect) throw new Error('Reconnect integrations before creating a chat.');
          const pinned = c.state.contexts;
          await c.newThread();
          c.state.contexts = pinned;
          channel.images.adopt(c.state.threadId);
        } else if (action.threadId !== c.state.threadId) throw new Error('This message belongs to another chat.');
        const images = channel.images.list(c.state.threadId);
        const selected = channel.selectedSkills.map(s => s.id);
        await c.send(
          action.text,
          editor,
          () => (selected.length ? this.catalog(channelId).selected(selected) : Promise.resolve([])),
          images.map(i => i.path),
        );
        if (started) await c.setDraft('', null);
        channel.selectedSkills = channel.selectedSkills.filter(s => !selected.includes(s.id));
        channel.images.sent(c.state.threadId!, images);
        this.broadcast();
        break;
      }
      case 'cancel':
        await c.cancel();
        break;
      case 'draft':
        // No full-state broadcast per keystroke: the typing view already shows the text, and an echo
        // arriving after newer keystrokes would overwrite them. Other views of this chat get the text only.
        await c.setDraft(action.text, action.threadId, true);
        for (const [view, other] of this.views)
          if (view !== webview && other.channelId === channelId)
            void view.postMessage({ type: 'draftSync', channelId, threadId: action.threadId, text: action.text });
        break;
      case 'search':
        await c.listSessions(false, action.text, action.archived, action.deep);
        break;
      case 'bookmark':
        await c.bookmark(action.threadId);
        break;
      case 'unarchive':
        await c.unarchive(action.threadId);
        break;
      case 'rename':
        // The title is edited in place in the webview; the coordinator re-validates it.
        if (action.threadId !== c.state.threadId) throw new Error('Chat changed.');
        await c.rename(action.title);
        break;
      case 'archive': {
        if (action.threadId !== c.state.threadId) throw new Error('Chat changed.');
        const label = c.state.locale === 'zh-CN' ? '归档聊天' : 'Archive chat';
        if (
          (await vscode.window.showWarningMessage(
            c.state.locale === 'zh-CN'
              ? '归档此聊天？可以从已归档历史中恢复。'
              : 'Archive this chat? It can be restored from archived history.',
            { modal: true },
            label,
          )) === label
        ) {
          if (action.threadId !== c.state.threadId) throw new Error('Chat changed.');
          await this.cancelVoice(channelId);
          await c.archive();
        }
        break;
      }
      case 'permission':
        if (!busy(c.state.status) && !c.agents.active) {
          c.state.permission = action.value;
          this.broadcast();
        }
        break;
      case 'configure': {
        await c.configure(action.model, action.effort, action.mode);
        break;
      }
      case 'reviewApply': {
        const outcome = await channel.review.apply(action.id, action.accepted);
        if (outcome) {
          c.state.notice = {
            declined: chinese ? '已拒绝：没有修改任何文件。' : 'Declined: no file was changed.',
            buffer: chinese ? '已应用到编辑缓冲区，尚未保存。' : 'Applied to buffer — not saved.',
            saved: chinese ? '已保存到磁盘。' : 'Saved to disk.',
          }[outcome];
          this.broadcast();
        }
        break;
      }
      case 'reviewPreview':
        await channel.review.preview(action.id, action.accepted);
        break;
      case 'checkpoints':
        await this.checkpoints(channelId);
        break;
      case 'addAnnotation':
        await c.annotate(action.threadId, 'add', action.annotation);
        break;
      case 'commentAnnotation':
        await c.annotate(action.threadId, 'comment', action.id, action.text);
        break;
      case 'removeAnnotation':
        await c.annotate(action.threadId, 'remove', action.id);
        break;
      case 'removeContext': {
        const pinned = c.state.contexts.find(e => e.id === action.id);
        if (pinned) channel.editor.dismissFile(pinned.uri, pinned.path);
        else channel.editor.dismiss(action.id);
        c.state.contexts = c.state.contexts.filter(e => e.id !== action.id);
        this.broadcast();
        break;
      }
      case 'attach': {
        const thread = c.state.threadId ?? null;
        const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist}/**', 2000);
        const file = await vscode.window.showQuickPick(
          files.filter(f => attachable(f.fsPath)).map(uri => ({ label: vscode.workspace.asRelativePath(uri), uri })),
          { placeHolder: c.state.locale === 'zh-CN' ? '选择工作区文本文件' : 'Choose a workspace text file' },
        );
        if (file)
          await this.addContext(await vscode.workspace.openTextDocument(file.uri), undefined, thread, channelId);
        break;
      }
      case 'attachImage': {
        const thread = c.state.threadId ?? null;
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: chinese ? '添加图片' : 'Add images',
          filters: { [chinese ? '图片' : 'Images']: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
        });
        for (const uri of picked ?? []) {
          if (thread !== (c.state.threadId ?? null)) throw new Error('Chat changed. Choose the images again.');
          if ((await stat(uri.fsPath)).size > 10 * 1024 * 1024)
            throw new Error(chinese ? '图片不能超过 10 MB。' : 'Images must be 10 MB or smaller.');
          const extension = uri.fsPath.split('.').pop()!.toLowerCase().replace(/^jpg$/, 'jpeg');
          // The dialog filter is only a hint on some platforms; any other file is refused before reading it.
          if (!['png', 'jpeg', 'gif', 'webp'].includes(extension))
            throw new Error(
              chinese ? '只支持 PNG、JPEG、GIF 和 WebP 图片。' : 'Only PNG, JPEG, GIF and WebP images are supported.',
            );
          const data = `data:image/${extension};base64,${(await readFile(uri.fsPath)).toString('base64')}`;
          await channel.images.add(thread, randomBytes(8).toString('hex'), uri.fsPath.split(/[\\/]/).pop()!, data);
        }
        this.broadcast();
        break;
      }
      case 'setGoal': {
        if (!c.state.threadId || !c.state.writable)
          throw new Error(
            chinese ? '请先在这里继续一个对话，再设置目标。' : 'Continue a chat here before setting a goal.',
          );
        const threadId = c.state.threadId;
        const objective = await vscode.window.showInputBox({
          title: chinese ? '设置目标' : 'Set a goal',
          prompt: chinese
            ? 'Codex 会持续推进这个目标，直到完成或你清除它'
            : 'Codex keeps pursuing this goal until it is done or you clear it',
        });
        if (!objective?.trim()) break;
        if (c.state.threadId !== threadId) throw new Error('Chat changed. Set the goal again.');
        await c.request('thread/goal/set', { threadId, objective: objective.trim() });
        c.state.notice = (chinese ? '目标已设置：' : 'Goal set: ') + objective.trim();
        this.broadcast();
        break;
      }
      case 'findFiles': {
        const result = await bound.files.search(action.query);
        this.checkWorkspace();
        if (result)
          await webview.postMessage({ type: 'fileResults', channelId, requestId: action.requestId, ...result });
        break;
      }
      case 'attachFile': {
        if (busy(c.state.status) || action.threadId !== (c.state.threadId ?? null))
          throw new Error('Chat changed. Choose the file again.');
        const uri = await bound.files.resolve(action.id);
        await this.addContext(await vscode.workspace.openTextDocument(uri), undefined, action.threadId, channelId);
        await webview.postMessage({ type: 'fileAttached', channelId, id: action.id, ok: true });
        break;
      }
      case 'decision':
        await this.decide(channelId, action);
        break;
      case 'openChange':
        await this.diffs.open(
          { channelId, id: action.id, token: action.token },
          c.pendingChanges(action.id, action.token),
          action.path,
        );
        break;
      case 'openTurnFile':
        await this.openTurnFile(c, action.turnId, action.path);
        break;
      case 'openTurnChanges':
        await this.openTurnChanges(c, action.turnId, chinese);
        break;
      case 'undoTurn':
        await this.undoTurns(c, [action.turnId], chinese);
        break;
      case 'rewind': {
        const label = chinese ? '回退' : 'Rewind';
        if (
          (await vscode.window.showWarningMessage(
            chinese
              ? '回退到这条消息之前？会删除这条及之后的对话记录；本扩展记录过的 Codex 文件改动会一并恢复，其他改动不受影响。'
              : 'Rewind to before this message? This message and later ones are removed from the chat. Codex file edits recorded by this extension are restored; other changes are left alone.',
            { modal: true },
            label,
          )) !== label
        )
          break;
        await c.revert(action.turnId, () => this.undoTurns(c, c.turnsFrom(action.turnId), chinese, false));
        break;
      }
      case 'planOpen':
        await this.openPlan(c, action.itemId);
        break;
      case 'planProceed':
        await this.proceedPlan(c, action.itemId, chinese);
        break;
      case 'copy': {
        const item = c.state.items.find(i => i.id === action.itemId && i.type === 'agentMessage');
        const threadId = c.state.threadId;
        if (item && !item.truncated) {
          await vscode.env.clipboard.writeText(item.text);
          await webview.postMessage({ type: 'copied', channelId, threadId, itemId: item.id });
        }
        break;
      }
      case 'export': {
        const content = await c.exportConversation(action.threadId);
        this.checkWorkspace();
        if (action.destination === 'clipboard') await vscode.env.clipboard.writeText(content);
        else
          await vscode.window.showTextDocument(
            await vscode.workspace.openTextDocument({ content, language: 'markdown' }),
            { preview: false },
          );
        c.state.notice = chinese
          ? '已导出当前会话的全部消息和计划；工具活动与附件原文件不包含在内。'
          : 'Exported all messages and plans in this chat. Tool activity and attachment bytes are excluded.';
        c.update();
        break;
      }
      case 'link':
        await vscode.env.openExternal(vscode.Uri.parse(action.url));
        break;
      case 'instructions':
        await this.instructions();
        break;
      case 'refreshAgents':
        await c.agents.refresh();
        break;
      case 'agentOutput':
      case 'moreAgentOutput':
        await c.agents.open(action.id, action.type === 'moreAgentOutput');
        break;
      case 'closeAgentOutput':
        c.agents.close();
        break;
      case 'stopAgent':
        this.checkWorkspace();
        await c.stopAgent(action.id);
        break;
      case 'browseMemories': {
        if (!channel.memories) throw new Error('Connect to Codex first.');
        await channel.memories.list();
        break;
      }
      case 'readMemory': {
        if (!channel.memories) throw new Error('Connect to Codex first.');
        await channel.memories.read(action.id);
        break;
      }
      case 'closeMemory':
        channel.memories?.clear();
        break;
      case 'closeMemoryPreview':
        channel.memories?.closePreview();
        break;
      case 'addGroup': {
        const name = await vscode.window.showInputBox({
          title: c.state.locale === 'zh-CN' ? '新建会话分组' : 'New session group',
        });
        if (name !== undefined) await this.tabs.group('add', undefined, name);
        break;
      }
      case 'group': {
        let value: string | boolean | undefined = action.collapsed;
        if (action.operation === 'rename')
          value = await vscode.window.showInputBox({
            title: c.state.locale === 'zh-CN' ? '重命名分组' : 'Rename group',
            value: this.tabs.groups.find(g => g.id === action.id)?.name,
          });
        if (action.operation !== 'rename' || value !== undefined)
          await this.tabs.group(action.operation, action.id, value);
        break;
      }
      case 'assignGroup':
        await this.tabs.assign(action.id, action.groupId);
        break;
      case 'refreshIntegrations':
        await this.catalog(channelId).refresh(c.state.writable ? c.state.threadId : undefined);
        break;
      case 'refreshEcosystem':
        await this.catalog(channelId).refreshEcosystem();
        break;
      case 'openEcosystem':
        await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument(vscode.Uri.file(this.catalog(channelId).file(action.id))),
        );
        break;
      case 'ecosystemFeature':
        await this.manage(channelId, async catalog => {
          const label = chinese
            ? action.enabled
              ? '启用功能'
              : '停用功能'
            : action.enabled
              ? 'Enable feature'
              : 'Disable feature';
          if (
            (await vscode.window.showWarningMessage(
              chinese
                ? `在共享 Codex 用户配置中${action.enabled ? '启用' : '停用'} ${action.name}？Hooks 和插件可以运行配置的命令；记忆和 Agent 可以使用账号额度。`
                : `Codex ${action.name}: ${action.enabled ? 'enable' : 'disable'} in shared user configuration? Hooks and plugins can run configured commands; memory and agents can use account quota.`,
              { modal: true },
              label,
            )) !== label
          )
            return;
          this.mcpNeedsReconnect = true;
          await catalog.feature(action.name, action.enabled);
          await this.reconnectSessions();
          await this.catalog(channelId).refreshEcosystem();
        });
        break;
      case 'trustHook':
      case 'hookToggle':
        await this.manage(channelId, async catalog => {
          const hook = catalog.hook(action.id);
          await this.assertConfigClean(hook.sourcePath);
          if (action.type === 'trustHook') {
            const label = chinese ? '信任此定义' : 'Trust this definition';
            if (
              (await vscode.window.showWarningMessage(
                `${hook.eventName}\n${hook.sourcePath}\n${hook.command ?? `${hook.server} / ${hook.tool}`}\nSHA-256: ${hook.currentHash}`,
                { modal: true },
                label,
              )) !== label
            )
              return;
          }
          await this.assertConfigClean(hook.sourcePath);
          this.mcpNeedsReconnect = true;
          await catalog.changeHook(
            action.id,
            action.type === 'trustHook' ? true : action.enabled,
            action.type === 'trustHook',
          );
          await this.reconnectSessions();
          await this.catalog(channelId).refreshEcosystem();
        });
        break;
      case 'pluginToggle':
      case 'removePlugin':
        await this.manage(channelId, async catalog => {
          const plugin = catalog.plugin(action.id),
            label = chinese
              ? action.type === 'removePlugin'
                ? '移除插件'
                : action.enabled
                  ? '启用插件'
                  : '停用插件'
              : action.type === 'removePlugin'
                ? 'Remove plugin'
                : action.enabled
                  ? 'Enable plugin'
                  : 'Disable plugin';
          if (
            (await vscode.window.showWarningMessage(
              chinese
                ? `${label}：${plugin.name}？这会修改共享 Codex 配置，并可能影响工具和 Hooks。`
                : `${label}: ${plugin.name}? This changes shared Codex configuration and may affect tools and hooks.`,
              { modal: true },
              label,
            )) !== label
          )
            return;
          this.mcpNeedsReconnect = true;
          if (action.type === 'removePlugin') await catalog.removePlugin(action.id);
          else await catalog.changePlugin(action.id, action.enabled);
          await this.reconnectSessions();
          await this.catalog(channelId).refreshEcosystem();
        });
        break;
      case 'browsePlugins':
        await this.manage(channelId, async catalog => {
          const choices = await catalog.availablePlugins();
          if (!choices.length) {
            void vscode.window.showInformationMessage(
              chinese ? '当前没有可安装的插件。' : 'No plugins are currently available to install.',
            );
            return;
          }
          const choice = await vscode.window.showQuickPick(
            choices as {
              label: string;
              description: string;
              pluginName: string;
              marketplacePath: string | null;
              remoteMarketplaceName: string | null;
            }[],
            { title: chinese ? 'Codex 插件目录' : 'Codex plugin catalog', matchOnDescription: true },
          );
          if (!choice) return;
          const label = chinese ? '安装插件' : 'Install plugin';
          if (
            (await vscode.window.showWarningMessage(
              chinese
                ? `将 ${choice.label} 安装到共享 Codex 配置？使用前请检查其权限和 Hooks。`
                : `Install ${choice.label} into shared Codex configuration? Review its permissions and hooks before use.`,
              { modal: true },
              label,
            )) !== label
          )
            return;
          this.mcpNeedsReconnect = true;
          await catalog.installPlugin({
            pluginName: choice.pluginName,
            marketplacePath: choice.marketplacePath,
            remoteMarketplaceName: choice.remoteMarketplaceName,
          });
          await this.reconnectSessions();
          await this.catalog(channelId).refreshEcosystem();
        });
        break;
      case 'newAgent':
        await this.manage(channelId, async catalog => {
          const name = await vscode.window.showInputBox({
            title: chinese ? '新建项目 Agent' : 'New project agent',
            prompt: chinese
              ? '使用字母、数字、连字符或下划线；使用前请编辑新建的 TOML 文件。'
              : 'Letters, numbers, hyphens and underscores; edit the new TOML file before use.',
          });
          if (name)
            await vscode.window.showTextDocument(
              await vscode.workspace.openTextDocument(vscode.Uri.file(await catalog.addAgent(name))),
            );
        });
        break;
      case 'selectSkill': {
        if (busy(c.state.status)) throw new Error('Finish the active turn before selecting a skill.');
        const skill = this.catalog(channelId).skill(action.id);
        if (!skill.enabled) throw new Error('Enable this skill first.');
        channel.selectedSkills = [
          ...channel.selectedSkills.filter(s => s.id !== action.id),
          { id: action.id, name: skill.name },
        ].slice(-8);
        this.broadcast();
        await webview.postMessage({ type: 'skillAttached', channelId, id: action.id, ok: true });
        break;
      }
      case 'pasteImage':
        if (action.threadId !== (c.state.threadId ?? null)) throw new Error('Chat changed. Paste the image again.');
        await channel.images.add(action.threadId, action.id, action.name, action.data);
        // A chat may have been created from this empty tab while the file was written.
        if (action.threadId === null) channel.images.adopt(c.state.threadId);
        this.broadcast();
        break;
      case 'sideAsk':
        await c.askSide(action.threadId, action.text);
        break;
      case 'voiceOffer': {
        if (channel.dictation || (channel.voice && channel.voice.status !== 'idle'))
          throw new Error('Voice input is already recording.');
        if (
          action.annotationId &&
          (action.threadId !== c.state.threadId || !c.state.annotations?.some(a => a.id === action.annotationId))
        )
          throw new Error('This annotation is no longer available.');
        const annotationId = action.annotationId;
        channel.voiceView = webview;
        channel.voiceTarget = annotationId ? { threadId: action.threadId!, annotationId } : undefined;
        const starting = (channel.voice = { status: 'starting', annotationId } as const);
        this.broadcast();
        let dictation: Dictation | undefined;
        let microphone: Microphone | undefined;
        try {
          const runtime = await preferredRuntime(
            vscode.workspace.getConfiguration('independentCodex').get('runtimePath', 'codex'),
          );
          if (channel.voice !== starting || this.channels.get(channelId) !== channel) break;
          dictation = channel.dictation = new Dictation(runtime, this.root);
          const sdp = await dictation.start(action.sdp);
          if (channel.dictation !== dictation || this.channels.get(channelId) !== channel) await dictation.dispose();
          else {
            await webview.postMessage({ type: 'voiceAnswer', channelId, sdp });
            if (channel.dictation !== dictation || this.channels.get(channelId) !== channel) {
              await dictation.dispose();
              break;
            }
            microphone = channel.microphone = new Microphone();
            await microphone.start((pcm, rate) => {
              if (channel.dictation !== dictation || this.channels.get(channelId) !== channel) return;
              void webview.postMessage({
                type: 'voiceAudio',
                channelId,
                rate,
                pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
              });
            });
            if (channel.dictation !== dictation || this.channels.get(channelId) !== channel) microphone.release();
            else channel.voice = { status: 'recording', annotationId };
          }
        } catch (error) {
          microphone?.release();
          if (channel.voice === starting) {
            channel.microphone = undefined;
            channel.dictation = undefined;
            await dictation?.dispose();
            if (channel.voice === starting) {
              channel.voice = { status: 'idle', error: error instanceof Error ? error.message : String(error) };
              await webview.postMessage({ type: 'voiceFailed', channelId });
            }
          }
        }
        this.broadcast();
        break;
      }
      case 'voiceStop': {
        const dictation = channel.dictation;
        if (!dictation || channel.voice?.status === 'transcribing') break;
        const target = channel.voiceTarget;
        channel.microphone?.release();
        channel.microphone = undefined;
        const transcribing = (channel.voice = { status: 'transcribing', annotationId: target?.annotationId } as const);
        this.broadcast();
        try {
          const text = await dictation.stop();
          if (channel.voice !== transcribing || this.channels.get(channelId) !== channel) break;
          if (!text) throw new Error(chinese ? '没有识别到语音。' : 'No speech was recognised.');
          else if (target) {
            const annotation = c.state.annotations?.find(a => a.id === target.annotationId);
            if (c.state.threadId !== target.threadId || !annotation)
              throw new Error(
                chinese
                  ? '引用已移除或会话已切换，未插入语音文字。'
                  : 'The annotation was removed or the chat changed. Dictation was not inserted.',
              );
            const comment = annotation.comment.trim() ? `${annotation.comment.trimEnd()} ${text}` : text;
            if (comment.length > 2000)
              throw new Error(
                chinese
                  ? '备注超过 2,000 字符，未插入语音文字。'
                  : 'The comment exceeds 2,000 characters. Dictation was not inserted.',
              );
            await c.annotate(target.threadId, 'comment', target.annotationId, comment);
          } else {
            const shown = [...this.views].filter(
              ([, view]) => view.surface !== 'sidebar' && view.channelId === channelId,
            );
            // The webview owns a visible draft; a chat that is not on screen gets the text in its stored draft.
            if (shown.length)
              for (const [view] of shown) await view.postMessage({ type: 'voiceTranscript', channelId, text });
            else await c.setDraft(c.state.draft.trim() ? `${c.state.draft.trimEnd()} ${text}` : text);
          }
          if (channel.voice === transcribing) channel.voice = { status: 'idle' };
        } catch (error) {
          if (channel.voice !== transcribing) break;
          channel.voice = { status: 'idle', error: error instanceof Error ? error.message : String(error) };
        } finally {
          if (channel.dictation === dictation) {
            try {
              if (channel.voiceView)
                void Promise.resolve(channel.voiceView.postMessage({ type: 'voiceFailed', channelId })).catch(() => {});
            } catch {
              /* The recording's view may already be disposed. */
            }
            channel.dictation = undefined;
            channel.voiceView = undefined;
          }
        }
        this.broadcast();
        break;
      }
      case 'voiceCancel': {
        if (
          action.annotationId &&
          (channel.voiceTarget?.annotationId !== action.annotationId ||
            channel.voiceTarget.threadId !== action.threadId)
        )
          break;
        await this.cancelVoice(channelId);
        break;
      }
      case 'refreshTerminals':
        await c.refreshTerminals();
        break;
      case 'stopTerminal':
        await c.stopTerminals(action.id);
        break;
      case 'stopAllTerminals': {
        const count = c.state.terminals?.items.length ?? 0;
        const stop = chinese ? '全部停止' : 'Stop all';
        if (
          (await vscode.window.showWarningMessage(
            chinese ? `停止本对话中全部 ${count} 个后台终端？` : `Stop all ${count} background terminals in this chat?`,
            {
              modal: true,
              detail: chinese
                ? '例如开发服务器也会被结束；已经做过的事情不会撤销。'
                : 'This also ends processes such as dev servers. Nothing they already did is undone.',
            },
            stop,
          )) === stop
        )
          await c.stopTerminals();
        break;
      }
      case 'sideClose':
        await c.closeSide();
        break;
      case 'removeImage':
        channel.images.remove(c.state.threadId ?? null, action.id);
        this.broadcast();
        break;
      case 'removeSkill':
        channel.selectedSkills = channel.selectedSkills.filter(s => s.id !== action.id);
        this.broadcast();
        break;
      case 'openSkill':
        await vscode.window.showTextDocument(vscode.Uri.file(this.catalog(channelId).skill(action.id).path));
        break;
      case 'skillToggle':
        await this.manage(channelId, catalog => catalog.toggleSkill(action.id, action.enabled));
        break;
      case 'openMcpConfig': {
        const uri = vscode.Uri.file(this.catalog(channelId).configPath);
        try {
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await vscode.window.showTextDocument(
            await vscode.workspace.openTextDocument({ language: 'toml', content: '# Codex user configuration\n' }),
          );
        }
        break;
      }
      case 'addMcp':
        await this.manage(channelId, async catalog => {
          const name = await vscode.window.showInputBox({
            title: 'MCP server name',
            validateInput: value =>
              /^[A-Za-z0-9_-]{1,100}$/.test(value) ? undefined : 'Use letters, numbers, hyphens and underscores.',
          });
          if (!name) return;
          const transport = await vscode.window.showQuickPick(['HTTP / OAuth', 'stdio'], {
            placeHolder: c.state.locale === 'zh-CN' ? '选择 MCP 连接类型' : 'Choose an MCP transport',
          });
          if (!transport) return;
          let config: Record<string, unknown>;
          if (transport === 'stdio') {
            const command = await vscode.window.showInputBox({
              title: c.state.locale === 'zh-CN' ? '可执行程序（不通过 shell）' : 'Executable (no shell)',
            });
            if (!command?.trim()) return;
            const argv = await vscode.window.showInputBox({
              title: c.state.locale === 'zh-CN' ? '参数（JSON 字符串数组）' : 'Arguments (JSON string array)',
              value: '[]',
            });
            if (argv === undefined) return;
            let args: unknown;
            try {
              args = JSON.parse(argv);
            } catch {
              throw new Error('Arguments must be a JSON string array.');
            }
            if (!Array.isArray(args) || args.length > 100 || args.some(a => typeof a !== 'string' || a.length > 4000))
              throw new Error('Invalid MCP arguments.');
            config = { command: command.trim(), args };
          } else {
            const entered = await vscode.window.showInputBox({ title: 'MCP HTTPS URL (OAuth supported)' });
            if (!entered) return;
            const url = new URL(entered);
            if (
              url.username ||
              url.password ||
              (url.protocol !== 'https:' &&
                !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
            )
              throw new Error('Use HTTPS or a local test endpoint, without credentials in the URL.');
            config = { url: url.toString() };
          }
          await catalog.addServer(name, config);
        });
        break;
      case 'mcpToggle':
        await this.manage(channelId, async catalog => {
          const server = catalog.server(action.id);
          if (action.enabled && !server.editable && server.config.enabled === false)
            throw new Error('This server is disabled by its project or administrator configuration.');
          const grants = { ...this.grants() };
          if (action.enabled) {
            const label = c.state.locale === 'zh-CN' ? '允许此服务器' : 'Allow this server';
            if (
              (await vscode.window.showWarningMessage(
                c.state.locale === 'zh-CN'
                  ? `允许 MCP 服务器 ${server.name}？它的工具可能访问外部服务或修改工作区之外的数据，不受本地文本编辑审查保护。仅启用你信任的服务器。`
                  : `Allow MCP server ${server.name}? Its tools can access external services or change data outside the workspace. Local text-edit review does not cover those actions. Enable only servers you trust.`,
                { modal: true },
                label,
              )) !== label
            )
              return;
            grants[server.name] = mcpFingerprint(server.config);
          } else delete grants[server.name];
          this.mcpNeedsReconnect = true;
          // A project or managed server keeps its own configuration; only this workspace's grant changes.
          if (server.editable) await catalog.changeServer(action.id, action.enabled);
          await this.tabs.store.update('mcpGrants', grants);
          await this.reconnectSessions();
        });
        break;
      case 'mcpRemove':
        await this.manage(channelId, async catalog => {
          const server = catalog.server(action.id),
            label = c.state.locale === 'zh-CN' ? '移除配置' : 'Remove configuration';
          if (
            (await vscode.window.showWarningMessage(
              c.state.locale === 'zh-CN'
                ? `移除用户配置中的 ${server.name}？不会删除服务器文件或远程数据。`
                : `Remove ${server.name} from user configuration? Server files and remote data are retained.`,
              { modal: true },
              label,
            )) !== label
          )
            return;
          this.mcpNeedsReconnect = true;
          await catalog.changeServer(action.id, null);
          const grants = { ...this.grants() };
          delete grants[server.name];
          await this.tabs.store.update('mcpGrants', grants);
          await this.reconnectSessions();
        });
        break;
      case 'mcpLogin':
        await this.manage(channelId, async catalog => {
          const server = catalog.server(action.id);
          if (typeof server.config.url !== 'string') throw new Error('OAuth requires an HTTP MCP server.');
          const fingerprint = mcpFingerprint(server.config);
          if (
            this.mcpNeedsReconnect ||
            server.config.enabled === false ||
            !channel.enabledMcp.includes(server.name) ||
            this.grants()[server.name] !== fingerprint
          )
            throw new Error('Enable and trust this MCP server, then reconnect before signing in.');
          // The connection enforces workspace grants; a reviewed thread deliberately disables MCP.
          const url = await channel.auth!.oauth(server.name, null, fingerprint);
          this.checkWorkspace();
          try {
            if (!(await vscode.env.openExternal(vscode.Uri.parse(url)))) throw new Error();
          } catch {
            throw new Error('Browser could not open. Reconnect to end the pending sign-in before trying again.');
          }
        });
        break;
      case 'reconnectMcp':
        await this.manage(
          channelId,
          async () => {
            await this.reconnectSessions();
            await this.catalog(channelId).refresh(c.state.writable ? c.state.threadId : undefined);
          },
          true,
        );
        break;
    }
  }
  async dispose() {
    this.disposed = true;
    clearTimeout(this.broadcastTimer);
    const voices = [...this.channels.keys()].map(id => this.cancelVoice(id));
    await this.tabs.dispose();
    await Promise.allSettled(voices);
    for (const channel of this.channels.values()) {
      channel.auth?.dispose();
      channel.memories?.clear();
      channel.editor.dispose();
      channel.review.dispose();
      await channel.images.dispose();
      channel.microphone?.release();
      await channel.dictation?.dispose();
    }
  }
}
