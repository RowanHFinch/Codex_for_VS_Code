import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Renderer fixture only; the packaged webview always uses VS Code's real bridge.
const state = {
  locale: 'en',
  sendKey: 'enter',
  status: 'waiting',
  runtimeVersion: '0.152.0',
  account: 'chatgpt',
  models: [
    {
      id: 'fixture',
      model: 'fixture',
      displayName: 'Fixture model',
      isDefault: true,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
    },
  ],
  model: 'fixture',
  effort: 'low',
  mode: 'default',
  permission: 'reviewed',
  threadId: 'fixture-thread',
  owned: true,
  title: 'Renderer verification',
  items: [
    {
      id: 'user',
      turnId: 'turn',
      type: 'userMessage',
      text: 'Update the first setting and leave the second one alone.',
    },
    {
      id: 'agent',
      turnId: 'turn',
      type: 'agentMessage',
      text: 'I have prepared two replacements for review.\n\n```ts\nconst alpha = "before";\n```\n\n<script>window.fixtureInjected = true</script>\n[unsafe](javascript:alert(1))',
    },
  ],
  sessions: [
    {
      id: 'fixture-thread',
      title: 'Renderer verification',
      updatedAt: 1,
      owned: true,
      bookmarked: false,
      snippet: 'Synthetic message search result',
    },
    { id: 'external-thread', title: 'External history', updatedAt: 1, owned: false, bookmarked: false },
  ],
  sessionsSearch: '',
  sessionsArchived: false,
  sessionsCursor: null,
  historyCursor: null,
  decisions: [],
  contexts: [],
  draft: '',
  activeEditor: {
    id: 'context-fixture',
    path: 'main.ts',
    label: 'main.ts:18-26',
    startLine: 18,
    endLine: 26,
    selected: true,
  },
  editorContextPending: false,
  editorContextUnavailable: false,
  review: {
    id: 'fixture-review',
    path: 'src/example.ts',
    hunks: [
      { id: 'A', before: 'alpha=before', after: 'alpha=after' },
      { id: 'B', before: 'beta=keep', after: 'beta=rejected' },
    ],
  },
};
function fixtureBridge(initial) {
  const catalog = {
    loading: false,
    uncertain: false,
    skills: [
      {
        id: 'skill-review',
        name: 'code-review',
        description: 'Review the current changes for correctness, clarity and regressions.',
        scope: 'repo',
        enabled: true,
      },
      {
        id: 'skill-design',
        name: 'ui-review',
        description: 'Check the interface in the current editor theme.',
        scope: 'user',
        enabled: false,
      },
    ],
    servers: [
      {
        id: 'mcp-docs',
        name: 'project_docs',
        transport: 'HTTP',
        scope: 'user',
        enabled: false,
        allowed: false,
        status: 'notConnected',
        auth: 'notLoggedIn',
        tools: ['search_docs', 'read_page'],
        editable: true,
      },
      {
        id: 'mcp-managed',
        name: 'team_tools',
        transport: 'stdio',
        scope: 'managed/project',
        enabled: true,
        allowed: false,
        status: 'notConnected',
        auth: 'unsupported',
        tools: [],
        editable: false,
      },
    ],
  };
  const channels = new Map([
    [
      'channel-alpha',
      {
        ...initial,
        channelId: 'channel-alpha',
        integrations: catalog,
        selectedSkills: [],
        enabledMcp: [],
        integrationBusy: false,
      },
    ],
  ]);
  let active = 'channel-alpha',
    saved = {},
    serial = 1;
  const groups = [],
    assignments = {};
  const choices = [
    { id: 'file-main', path: 'src/main.ts' },
    { id: 'file-context', path: 'src/context.ts' },
    { id: 'file-spaces', path: 'src/a name with spaces.ts' },
  ];
  const fixture = (window.__fixture = {
    state: channels.get(active),
    actions: [],
    holdSearch: false,
    holdAttachment: false,
    holdIntegrationRefresh: false,
  });
  const memoryFiles = [{ id: 'memory-fixture', path: 'memories/MEMORY.md', bytes: 64, updatedAt: 1 }];
  const emit = () => {
    const state = channels.get(active);
    fixture.state = state;
    state.tabs = [...channels.values()].map(c => ({
      id: c.channelId,
      threadId: c.threadId,
      title: c.title,
      status: c.status,
      unread: false,
      groupId: c.groupId,
    }));
    state.groups = groups;
    state.groupAssignments = assignments;
    window.postMessage({ type: 'state', state: structuredClone(state) }, '*');
  };
  fixture.emit = emit;
  fixture.completeLogin = status => {
    const state = channels.get(active);
    state.auth.status = status;
    state.integrationMutationBusy = false;
    if (status === 'success' && state.auth.kind === 'mcp')
      catalog.servers.find(s => s.name === state.auth.name).auth = 'oAuth';
    emit();
  };
  fixture.attach = (id, ok = true, channelId = active) => {
    const state = channels.get(channelId),
      file = choices.find(f => f.id === id);
    if (ok && file) {
      state.contexts.push({
        ...file,
        label: file.path + ':1-3',
        text: 'Synthetic fixture',
        uri: 'file:///fixture/' + file.path,
        version: 1,
        startLine: 1,
        endLine: 3,
        kind: 'file',
      });
      emit();
    }
    window.postMessage({ type: 'fileAttached', channelId, id, ok }, '*');
  };
  window.acquireVsCodeApi = () => ({
    getState: () => saved,
    setState: value => {
      saved = value;
      fixture.saved = value;
    },
    postMessage: message => {
      fixture.actions.push(message);
      const a = message.action,
        state = channels.get(message.channelId) ?? channels.get(active);
      if (a.type === 'findFiles' && !fixture.holdSearch)
        window.postMessage(
          {
            type: 'fileResults',
            channelId: message.channelId,
            requestId: a.requestId,
            files: choices.filter(f => f.path.toLowerCase().includes(a.query.toLowerCase())),
            limited: false,
          },
          '*',
        );
      if (a.type === 'attachFile' && !fixture.holdAttachment) fixture.attach(a.id, true, message.channelId);
      if (a.type === 'addAnnotation') state.annotations = [...(state.annotations ?? []), a.annotation];
      if (a.type === 'commentAnnotation')
        state.annotations = state.annotations.map(item => (item.id === a.id ? { ...item, comment: a.text } : item));
      if (a.type === 'removeAnnotation') state.annotations = state.annotations.filter(item => item.id !== a.id);
      if (a.type === 'draft') state.draft = a.text;
      if (a.type === 'copy' && !fixture.holdCopy)
        window.postMessage(
          { type: 'copied', channelId: message.channelId, threadId: state.threadId, itemId: a.itemId },
          '*',
        );
      if (a.type === 'permission') state.permission = a.value;
      if (a.type === 'nativePolicy')
        for (const key of ['profile', 'approval', 'reviewer']) if (a[key] !== undefined) state[key] = a[key];
      if (a.type === 'memory') state.memoryEnabled = a.enabled;
      if (a.type === 'decision') {
        state.decisions = state.decisions.filter(d => d.id !== a.id || d.token !== a.token);
        state.status = 'completed';
      }
      if (a.type === 'removeQueued') state.queued = state.queued.filter(q => q.id !== a.id);
      if (a.type === 'configure') Object.assign(state, { model: a.model, effort: a.effort, mode: a.mode });
      if (a.type === 'sideClose') delete state.side;
      if (a.type === 'removeContext') {
        if (state.activeEditor?.id === a.id) delete state.activeEditor;
        state.contexts = state.contexts.filter(c => c.id !== a.id);
      }
      if (a.type === 'search') {
        state.sessionsSearch = a.text;
        state.sessionsArchived = a.archived;
      }
      if (a.type === 'bookmark')
        state.sessions = state.sessions.map(s => (s.id === a.threadId ? { ...s, bookmarked: !s.bookmarked } : s));
      if (a.type === 'reviewApply') {
        state.review = undefined;
        state.status = 'completed';
      }
      if (a.type === 'new')
        Object.assign(state, { threadId: 'thread-' + ++serial, title: '', items: [], contexts: [], decisions: [] });
      if (a.type === 'selectTab') active = a.id;
      if (a.type === 'newTab') {
        const id = 'channel-' + ++serial;
        channels.set(id, {
          ...structuredClone(initial),
          channelId: id,
          threadId: 'thread-' + serial,
          title: 'New chat',
          status: 'idle',
          draft: '',
          items: [],
          decisions: [],
          review: undefined,
          contexts: [],
          activeEditor: undefined,
          integrations: catalog,
          selectedSkills: [],
          enabledMcp: [],
          integrationBusy: false,
        });
        active = id;
      }
      if (a.type === 'closeTab') {
        channels.delete(a.id);
        if (!channels.has(active)) active = channels.keys().next().value;
      }
      if (a.type === 'addGroup')
        groups.push({
          id: 'group-' + (groups.length + 1),
          name: groups.length ? 'Product work' : 'Research',
          collapsed: false,
        });
      if (a.type === 'assignGroup') {
        const c = channels.get(a.id);
        c.groupId = a.groupId;
        if (a.groupId) assignments[c.threadId] = a.groupId;
        else delete assignments[c.threadId];
      }
      if (a.type === 'group') {
        const i = groups.findIndex(g => g.id === a.id),
          g = groups[i];
        if (a.operation === 'collapse') g.collapsed = a.collapsed;
        if (a.operation === 'rename') g.name = 'Renamed group';
        if (a.operation === 'remove') {
          groups.splice(i, 1);
          for (const c of channels.values()) if (c.groupId === a.id) c.groupId = undefined;
        }
        if (a.operation === 'up' && i > 0) [groups[i - 1], groups[i]] = [groups[i], groups[i - 1]];
        if (a.operation === 'down' && i + 1 < groups.length) [groups[i + 1], groups[i]] = [groups[i], groups[i + 1]];
      }
      if (a.type === 'skillToggle') catalog.skills.find(s => s.id === a.id).enabled = a.enabled;
      if (a.type === 'selectSkill') {
        const skill = catalog.skills.find(s => s.id === a.id);
        state.selectedSkills = [...state.selectedSkills.filter(s => s.id !== a.id), { id: skill.id, name: skill.name }];
        window.postMessage({ type: 'skillAttached', channelId: message.channelId, id: a.id, ok: true }, '*');
      }
      if (a.type === 'removeSkill') state.selectedSkills = state.selectedSkills.filter(s => s.id !== a.id);
      if (a.type === 'pasteImage') state.images = [...(state.images ?? []), { id: a.id, name: a.name }];
      if (a.type === 'removeImage') state.images = state.images.filter(i => i.id !== a.id);
      if (a.type === 'mcpToggle') {
        const server = catalog.servers.find(s => s.id === a.id);
        server.enabled = server.allowed = a.enabled;
        server.status = a.enabled ? 'ready' : 'notConnected';
      }
      if (a.type === 'mcpRemove') catalog.servers = catalog.servers.filter(s => s.id !== a.id);
      if (a.type === 'agentOutput')
        state.agents.selected = {
          id: a.id,
          cursor: 'next',
          items: [
            {
              id: 'output',
              turnId: 'child-turn',
              type: 'agentMessage',
              status: 'completed',
              text: 'SYNTHETIC_CHILD_OUTPUT',
            },
          ],
        };
      if (a.type === 'moreAgentOutput') {
        state.agents.selected.items.push({
          id: 'older-output',
          turnId: 'child-turn',
          type: 'userMessage',
          text: 'SYNTHETIC_OLDER_OUTPUT',
        });
        state.agents.selected.cursor = null;
      }
      if (a.type === 'closeAgentOutput') delete state.agents.selected;
      if (a.type === 'stopAgent') {
        state.agents.tasks.find(t => t.id === a.id).status = 'interrupted';
        state.agents.busy = state.integrationMutationBusy = false;
      }
      if (a.type === 'browseMemories') state.memories = { files: memoryFiles, loading: false, limited: false };
      if (a.type === 'readMemory')
        state.memories.selected = {
          id: a.id,
          path: memoryFiles[0].path,
          text: 'SYNTHETIC_MEMORY_ONLY\n<script>window.fixtureInjected = true</script>',
        };
      if (a.type === 'closeMemoryPreview') delete state.memories?.selected;
      if (a.type === 'closeMemory') delete state.memories;
      if (a.type === 'mcpLogin') {
        state.auth = { kind: 'mcp', name: catalog.servers.find(s => s.id === a.id).name, status: 'pending' };
        state.integrationMutationBusy = true;
      }
      emit();
      if (a.type === 'refreshIntegrations' && !fixture.holdIntegrationRefresh)
        window.postMessage(
          { type: 'integrationsRefreshed', channelId: message.channelId, requestId: a.requestId },
          '*',
        );
    },
  });
}
function bridge(url) {
  const fixture = structuredClone(state);
  if (['design', 'plan', 'side'].includes(url.searchParams.get('scene'))) {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    Object.assign(fixture, {
      status: 'completed',
      permission: 'agent',
      nativeReady: true,
      writable: true,
      profile: ':workspace',
      approval: 'on-request',
      reviewer: 'user',
      profiles: [{ id: ':workspace', allowed: true }],
      review: undefined,
      title: 'Fix rounding edge cases',
      model: 'fixture-full',
      effort: 'high',
      models: Array.from({ length: url.searchParams.has('many') ? 18 : 3 }, (_, i) => ({
        id: `fixture-${i}`,
        model: i === 0 ? 'fixture-full' : `fixture-${i}`,
        displayName: i === 0 ? 'Fixture Full' : i === 1 ? 'Fixture Fast' : `Fixture Model ${i + 1}`,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: (i === 1 ? ['low', 'high'] : efforts).map(reasoningEffort => ({ reasoningEffort })),
      })),
      activeEditor: { ...fixture.activeEditor, path: 'math.ts', label: 'math.ts:8-15', startLine: 8, endLine: 15 },
      items: [
        {
          id: 'user',
          turnId: 'turn',
          type: 'userMessage',
          text: 'Fix the rounding bug in math.ts and add a regression test.',
        },
        ...['Read math.ts', 'Read math.test.ts', 'Update rounding'].map((detail, i) => ({
          id: `tool-${i}`,
          turnId: 'turn',
          type: 'commandExecution',
          title: 'read',
          detail,
          status: 'completed',
          exitCode: 0,
          text: 'Synthetic fixture. No file was read or changed.',
        })),
        {
          id: 'agent',
          turnId: 'turn',
          type: 'agentMessage',
          text: '### Fixed the boundary case.\n\nRounding now happens once, after applying precision. Added coverage for negative values and exact halves.',
        },
      ],
      turnChanges: {
        turn: [
          { path: 'src/math.ts', added: 4, removed: 1 },
          { path: 'tests/math.test.ts', added: 12, removed: 0 },
        ],
      },
    });
    if (url.searchParams.get('scene') === 'plan') {
      fixture.mode = 'plan';
      fixture.items = [
        {
          id: 'plan',
          turnId: 'turn',
          type: 'plan',
          status: 'completed',
          text: '## Validate before sending\n\n1. Handle empty input and length limits.\n2. Explain what to fix beside the field.\n3. Test rapid submit and input composition.',
        },
      ];
      fixture.turnChanges = {};
    }
    if (url.searchParams.get('scene') === 'side')
      fixture.side = {
        parentId: fixture.threadId,
        status: 'completed',
        items: [
          {
            id: 'question',
            turnId: 'side-turn',
            type: 'userMessage',
            text: 'Why round after multiplying by the precision factor?',
          },
          {
            id: 'answer',
            turnId: 'side-turn',
            type: 'agentMessage',
            text: '### Keep precision until the final step.\n\nMultiplying shifts the decimal point to the required precision. Rounding once avoids losing information too early.',
          },
        ],
      };
  }
  if (['conversation', 'details'].includes(url.searchParams.get('scene'))) {
    Object.assign(fixture, {
      title: '解释 Python 断言示例',
      status: 'completed',
      review: undefined,
      permission: 'agent',
      nativeReady: true,
      writable: true,
      profile: ':workspace',
      approval: 'on-request',
      reviewer: 'user',
      profiles: [{ id: ':workspace', allowed: true }],
      items: [
        {
          id: 'question',
          turnId: 'turn',
          type: 'userMessage',
          text: '这个文件是什么意思？\n\n[Referenced file: /workspace/test.py]',
        },
        {
          id: 'progress',
          turnId: 'turn',
          type: 'agentMessage',
          phase: 'commentary',
          text: '我先查看文件内容，确认这两个断言示例的作用。',
        },
        {
          id: 'read',
          turnId: 'turn',
          type: 'commandExecution',
          title: 'read',
          detail: 'test.py',
          text: 'Synthetic fixture: file content remains available here.',
          status: 'completed',
          exitCode: 0,
        },
        {
          id: 'reason',
          turnId: 'turn',
          type: 'reasoning',
          text: '检查成功与失败两条路径，并确认直接运行的入口。',
          status: 'completed',
        },
        { id: 'empty-reason', turnId: 'turn', type: 'reasoning', text: '', status: 'completed' },
        {
          id: 'title-tool',
          turnId: 'turn',
          type: 'dynamicToolCall',
          title: 'set_chat_title',
          text: 'Chat title saved.',
          status: 'completed',
        },
        {
          id: 'answer',
          turnId: 'turn',
          type: 'agentMessage',
          phase: 'final_answer',
          text: '这个 `test.py` 是一个 **Python 断言示例**，用来说明条件成立和不成立时的行为。\n\n- **条件成立**：继续执行后面的代码。\n- **条件不成立**：抛出 `AssertionError`，并附上错误说明。\n- **直接运行文件**：依次执行两个示例，确认结果符合预期。\n\n`assert` 适合检查程序内部假设。普通 `if` 可以处理各种分支，两者用途不同。\n\n注意：`python -O` 会跳过断言，因此不能用它代替必要的输入校验。',
        },
      ],
    });
  }
  if (url.searchParams.get('scene') === 'empty') {
    fixture.status = 'idle';
    fixture.items = [];
    delete fixture.review;
    fixture.permission = 'read-only';
  }
  if (url.searchParams.get('scene') === 'auth') {
    const account = url.searchParams.get('account');
    Object.assign(fixture, {
      status: account === 'unknown' ? 'connecting' : 'idle',
      account: ['unknown', 'chatgpt', 'apiKey', 'unavailable'].includes(account) ? account : 'unknown',
      items: [],
      review: undefined,
      threadId: undefined,
      title: 'CLI sign-in verification',
    });
  }
  if (url.searchParams.get('scene') === 'native') {
    Object.assign(fixture, {
      permission: 'agent',
      nativeReady: true,
      writable: true,
      profiles: [':read-only', ':workspace', ':danger-full-access'].map(id => ({
        id,
        description: null,
        allowed: true,
      })),
      profile: ':workspace',
      approval: 'on-request',
      reviewer: 'user',
      memoryAvailable: true,
      queued: [{ id: 'queued-fixture', text: 'Inspect the context regression after the current task.' }],
      review: undefined,
      effort: 'max',
    });
    fixture.models[0].supportedReasoningEfforts.push({ reasoningEffort: 'max' });
    fixture.decisions = [
      {
        id: 17,
        token: '00000000-0000-4000-a000-000000000017',
        kind: 'approval',
        method: 'item/permissions/requestApproval',
        threadId: fixture.threadId,
        turnId: 'fixture-turn',
        itemId: 'fixture-item',
        scope: 'turn',
        canAccept: true,
        summary: JSON.stringify(
          { reason: 'Synthetic network fixture', permissions: { network: { allowedDomains: ['example.test'] } } },
          null,
          2,
        ),
      },
    ];
    fixture.ecosystem = {
      loading: false,
      features: ['hooks', 'plugins', 'multi_agent', 'memories'].map(name => ({ name, enabled: true })),
      hooks: [
        {
          id: 'hook-fixture',
          event: 'sessionStart',
          source: 'project',
          enabled: true,
          managed: false,
          supported: true,
          trust: 'untrusted',
        },
      ],
      plugins: [
        {
          id: 'plugin-fixture',
          name: 'Context helper',
          description: 'Synthetic native plugin fixture.',
          enabled: true,
          installed: true,
        },
      ],
      agents: [{ id: 'agent-fixture', name: 'code_reviewer', scope: 'project' }],
    };
  }
  if (url.searchParams.get('scene') === 'form') {
    Object.assign(fixture, { permission: 'agent', status: 'waiting', review: undefined });
    fixture.decisions = [
      {
        id: 18,
        token: '00000000-0000-4000-a000-000000000018',
        kind: 'approval',
        method: 'mcpServer/elicitation/request',
        threadId: fixture.threadId,
        turnId: 'fixture-turn',
        itemId: 'fixture',
        canAccept: true,
        form: {
          serverName: 'issue-tracker',
          message: 'Choose where to create the issue. No external service is contacted in this fixture.',
          fields: [
            {
              name: 'title',
              title: 'Issue title',
              description: 'A short summary',
              type: 'string',
              required: true,
              minLength: 1,
            },
            {
              name: 'count',
              title: 'Retry count',
              type: 'integer',
              required: true,
              minimum: 0,
              maximum: 3,
              default: 0,
            },
            { name: 'confirmed', title: 'Notify the team?', type: 'boolean', required: true },
            {
              name: 'priority',
              title: 'Priority',
              type: 'string',
              required: true,
              options: [
                { value: 'low', label: 'Low' },
                { value: 'high', label: 'High' },
              ],
            },
            {
              name: 'labels',
              title: 'Labels',
              type: 'array',
              required: true,
              minItems: 1,
              options: [
                { value: 'bug', label: 'Bug' },
                { value: 'ui', label: 'UI' },
              ],
            },
          ],
        },
      },
    ];
  }
  fixture.usage = {
    loading: false,
    unavailable: false,
    fetchedAt: 1800000000000,
    buckets: [
      {
        id: 'codex',
        name: 'Codex',
        windows: [
          { usedPercent: 20, durationMins: 300, resetsAt: 1800001000 },
          { usedPercent: null, durationMins: 10080, resetsAt: null },
        ],
      },
    ],
  };
  fixture.tokenUsage = {
    total: { input: 100, cached: 20, output: 30, reasoning: 10 },
    lastTokens: url.searchParams.get('scene') === 'design' ? 72000 : 130,
    contextWindow: 400000,
  };
  if (url.searchParams.get('scene') === 'details') {
    fixture.tokenUsage.lastTokens = 230000;
    fixture.tokenUsage.contextWindow = 258000;
    fixture.turnChanges = {
      turn: [
        'webview/FileInput.tsx',
        'webview/index.tsx',
        'webview/style.css',
        'src/context.ts',
        'locales/en.json',
        'locales/zh-CN.json',
      ].map((path, index) => ({ path, added: index + 1, removed: index })),
    };
  }
  if (url.searchParams.get('scene') === 'local-data') {
    Object.assign(fixture, {
      status: 'completed',
      permission: 'agent',
      writable: true,
      review: undefined,
      integrationMutationBusy: true,
      agents: {
        loading: false,
        limited: false,
        busy: true,
        tasks: [
          {
            id: 'child-active',
            parentId: fixture.threadId,
            title: 'Review editor context',
            role: 'explorer',
            status: 'active',
            turnId: 'child-turn',
          },
          {
            id: 'child-done',
            parentId: fixture.threadId,
            title: 'Check native login',
            role: 'worker',
            status: 'completed',
            turnId: 'done-turn',
          },
        ],
      },
    });
  }
  if (url.searchParams.get('scene') === 'tools') {
    fixture.status = 'completed';
    delete fixture.review;
    fixture.title = 'Understand the context bridge';
    fixture.items = [
      {
        id: 'user',
        turnId: 'turn',
        type: 'userMessage',
        text: 'Explain how the selected code reaches the model, and check the context tests.',
      },
      {
        id: 'read',
        turnId: 'turn',
        type: 'commandExecution',
        title: 'read',
        detail: 'cat src/context.ts',
        status: 'completed',
        durationMs: 82,
        exitCode: 0,
        text: 'cat src/context.ts\nexport async function editorContext(root, document, selection) { … }',
      },
      {
        id: 'find',
        turnId: 'turn',
        type: 'commandExecution',
        title: 'search',
        detail: 'rg editorContext src tests',
        status: 'completed',
        durationMs: 49,
        exitCode: 0,
        text: 'src/context.ts\ntests/editor/context.ts',
      },
      {
        id: 'failed-test',
        turnId: 'turn',
        type: 'commandExecution',
        title: 'unknown',
        detail: 'npm run test:context',
        status: 'failed',
        durationMs: 130,
        exitCode: 1,
        text: 'Synthetic fixture: test script is unavailable. No command was run in this browser fixture.',
      },
      {
        id: 'agent',
        turnId: 'turn',
        type: 'agentMessage',
        text: 'The current selection is captured in the extension host. A file and line-range chip shows what will be sent.\n\n- Context IDs prevent stale selections.\n- The host validates the workspace before sending.\n- Selected text stays separate from the message draft.\n\nThe attempted test command was unavailable; its failure remains visible above.',
      },
    ];
  }
  if (url.searchParams.get('scene') === 'approval') {
    Object.assign(fixture, { permission: 'agent', status: 'waiting', review: undefined, title: 'Clean and rebuild' });
    fixture.items = fixture.items.slice(0, 1);
    fixture.decisions = [
      {
        id: 19,
        token: '00000000-0000-4000-a000-000000000019',
        kind: 'approval',
        method: 'item/commandExecution/requestApproval',
        threadId: fixture.threadId,
        turnId: 'turn',
        itemId: 'fixture-command',
        canAccept: true,
        reason: 'Synthetic fixture: no command runs in this browser.',
        command: 'rm -rf dist && npm run build',
        cwd: '/workspace/fixture',
        options: ['accept', 'acceptForSession', 'decline', 'cancel'],
      },
    ];
  }
  if (url.searchParams.has('modelLengths')) {
    const names = ['A', 'GPT-6.1 Sol', 'A deliberately long model display name that must truncate'];
    fixture.models.forEach((model, index) => {
      model.displayName = names[index % names.length];
    });
  }
  if (url.searchParams.get('locale') === 'zh-CN') fixture.locale = 'zh-CN';
  return '(' + fixtureBridge.toString() + ')(' + JSON.stringify(fixture) + ');';
}
const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex for VS Code renderer fixture</title><link rel="stylesheet" href="/host.css"><link rel="stylesheet" href="/webview.css"><link rel="stylesheet" href="/theme.css?theme=THEME"></head><body><div id="root"></div><script src="/fixture.js?SCENE"></script><script src="/webview.js"></script></body></html>`;
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  const assets = {
    '/webview.js': ['dist/webview.js', 'text/javascript'],
    '/webview.css': ['dist/webview.css', 'text/css'],
  };
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; font-src 'none'; connect-src 'none'",
  );
  try {
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        html
          .replace(
            'THEME',
            new URL(request.url, 'http://127.0.0.1').searchParams.get('theme') === 'light' ? 'light' : 'dark',
          )
          .replace('SCENE', new URL(request.url, 'http://127.0.0.1').searchParams.toString()),
      );
    } else if (path === '/host.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end('body{padding:0 20px}');
    } else if (path === '/theme.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end(
        request.url.includes('theme=light')
          ? ':root{color-scheme:light;--vscode-sideBar-background:#f3f3f3;--vscode-foreground:#222;--vscode-descriptionForeground:#666;--vscode-editor-background:#fff;--vscode-input-background:#fff;--vscode-input-foreground:#222;--vscode-widget-border:#ccc;--vscode-textCodeBlock-background:#e9e9e9;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-focusBorder:#0078d4;--vscode-button-secondaryBackground:#ddd;--vscode-button-secondaryForeground:#222;--vscode-textLink-foreground:#0062a3;--vscode-badge-background:#ddd;--vscode-errorForeground:#b5200d;--vscode-testing-iconPassed:#2e7d32;--vscode-progressBar-background:#0062a3;--vscode-editorWidget-background:#fff;--vscode-list-activeSelectionBackground:#0062a3;--vscode-list-activeSelectionForeground:#fff;}'
          : '',
      );
    } else if (path === '/fixture.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(bridge(new URL(request.url, 'http://127.0.0.1')));
    } else if (assets[path]) {
      response.setHeader('Content-Type', assets[path][1]);
      response.end(await readFile(resolve(assets[path][0])));
    } else {
      response.writeHead(404);
      response.end();
    }
  } catch {
    response.writeHead(500);
    response.end('Fixture asset unavailable');
  }
});
server.listen(Number(process.env.PORT) || 0, '127.0.0.1', () =>
  console.log(`http://127.0.0.1:${server.address().port} pid=${process.pid}`),
);
