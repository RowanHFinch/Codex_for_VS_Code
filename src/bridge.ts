import { validAnnotation } from './annotations';
import type { Action } from './shared';
const simple = new Set([
  'ready',
  'connect',
  'new',
  'newReviewed',
  'continue',
  'fork',
  'refresh',
  'moreSessions',
  'moreHistory',
  'cancel',
  'logs',
  'attach',
  'instructions',
  'checkpoints',
  'settings',
  'newTab',
  'addGroup',
  'addMcp',
  'reconnectMcp',
  'openMcpConfig',
  'sideClose',
  'diagnostics',
  'worktree',
  'voiceStop',
  'attachImage',
  'setGoal',
  'refreshTerminals',
  'stopAllTerminals',
]);
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function parseAction(input: unknown): Action {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid UI message');
  const a = input as Record<string, unknown>;
  if (typeof a.type !== 'string') throw new Error('Invalid UI action');
  if (simple.has(a.type)) return { type: a.type } as Action;
  const bounded = (key: string, max: number) => typeof a[key] === 'string' && (a[key] as string).length <= max;
  const threadId = bounded('threadId', 100) && /^[a-zA-Z0-9-]+$/.test(a.threadId as string);
  const id = bounded('id', 100) && /^[A-Za-z0-9-]+$/.test(a.id as string);
  if (
    a.type === 'voiceCancel' &&
    (a.annotationId === undefined ||
      (threadId && bounded('annotationId', 200) && (a.annotationId as string).length > 0))
  )
    return {
      type: 'voiceCancel',
      ...(a.annotationId === undefined
        ? {}
        : { annotationId: a.annotationId as string, threadId: a.threadId as string }),
    };
  if (a.type === 'addAnnotation' && threadId && validAnnotation(a.annotation)) return a as Action;
  if (a.type === 'commentAnnotation' && threadId && bounded('id', 200) && bounded('text', 2000)) return a as Action;
  if (a.type === 'removeAnnotation' && threadId && bounded('id', 200)) return a as Action;
  if (a.type === 'refreshIntegrations' && bounded('requestId', 100) && /^[A-Za-z0-9-]+$/.test(a.requestId as string))
    return { type: 'refreshIntegrations', requestId: a.requestId as string };
  if (
    [
      'refreshEcosystem',
      'browsePlugins',
      'newAgent',
      'refreshAgents',
      'closeAgentOutput',
      'browseMemories',
      'closeMemory',
      'closeMemoryPreview',
      'refreshUsage',
    ].includes(a.type)
  )
    return { type: a.type } as Action;
  if (['agentOutput', 'moreAgentOutput', 'stopAgent', 'readMemory'].includes(a.type) && id)
    return { type: a.type, id: a.id as string } as Action;
  if (['openEcosystem', 'trustHook', 'removePlugin'].includes(a.type) && id)
    return { type: a.type, id: a.id as string } as Action;
  if (['hookToggle', 'pluginToggle'].includes(a.type) && id && typeof a.enabled === 'boolean')
    return { type: a.type, id: a.id as string, enabled: a.enabled } as Action;
  if (
    a.type === 'ecosystemFeature' &&
    ['hooks', 'plugins', 'multi_agent', 'memories'].includes(a.name as string) &&
    typeof a.enabled === 'boolean'
  )
    return { type: 'ecosystemFeature', name: a.name as 'hooks', enabled: a.enabled };
  if (
    a.type === 'nativePolicy' &&
    (a.profile !== undefined || a.approval !== undefined || a.reviewer !== undefined) &&
    (a.profile === undefined || bounded('profile', 200)) &&
    (a.approval === undefined || ['on-request', 'never', 'untrusted'].includes(a.approval as string)) &&
    (a.reviewer === undefined || ['user', 'auto_review'].includes(a.reviewer as string))
  )
    return {
      type: 'nativePolicy',
      profile: a.profile as string | undefined,
      approval: a.approval as 'on-request' | undefined,
      reviewer: a.reviewer as 'user' | undefined,
    };
  if (a.type === 'memory' && typeof a.enabled === 'boolean') return { type: 'memory', enabled: a.enabled };
  if (a.type === 'permissionMode' && ['review', 'ask', 'auto', 'full', 'plan'].includes(a.value as string))
    return { type: 'permissionMode', value: a.value as 'ask' };
  if (
    a.type === 'followup' &&
    bounded('text', 100_000) &&
    threadId &&
    ['queue', 'steer'].includes(a.delivery as string)
  )
    return {
      type: 'followup',
      text: a.text as string,
      threadId: a.threadId as string,
      delivery: a.delivery as 'queue',
    };
  if (
    a.type === 'pasteImage' &&
    id &&
    (threadId || a.threadId === null) &&
    bounded('name', 200) &&
    // 10 MiB of image bytes as base64, plus the data URL prefix.
    bounded('data', 14_000_100) &&
    /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(a.data as string)
  )
    return {
      type: 'pasteImage',
      id: a.id as string,
      name: a.name as string,
      data: a.data as string,
      threadId: a.threadId as string | null,
    };
  if (['planOpen', 'planProceed'].includes(a.type) && bounded('itemId', 200))
    return { type: a.type as 'planOpen', itemId: a.itemId as string };
  if (a.type === 'stopTerminal' && bounded('id', 200)) return { type: 'stopTerminal', id: a.id as string };
  if (
    a.type === 'voiceOffer' &&
    bounded('sdp', 100_000) &&
    (a.sdp as string).startsWith('v=0') &&
    (a.annotationId === undefined ||
      (threadId && bounded('annotationId', 200) && (a.annotationId as string).length > 0))
  )
    return {
      type: 'voiceOffer',
      sdp: a.sdp as string,
      ...(a.annotationId === undefined
        ? {}
        : { annotationId: a.annotationId as string, threadId: a.threadId as string }),
    };
  if (a.type === 'sideAsk' && threadId && bounded('text', 100_000))
    return { type: 'sideAsk', threadId: a.threadId as string, text: a.text as string };
  if (a.type === 'removeQueued' && bounded('id', 200)) return { type: 'removeQueued', id: a.id as string };
  if (
    [
      'selectTab',
      'closeTab',
      'selectSkill',
      'removeSkill',
      'openSkill',
      'mcpRemove',
      'mcpLogin',
      'removeImage',
    ].includes(a.type) &&
    id
  )
    return { type: a.type, id: a.id as string } as Action;
  if (['skillToggle', 'mcpToggle'].includes(a.type) && id && typeof a.enabled === 'boolean')
    return { type: a.type, id: a.id as string, enabled: a.enabled } as Action;
  if (
    a.type === 'assignGroup' &&
    id &&
    (a.groupId === null || (bounded('groupId', 100) && /^[A-Za-z0-9-]+$/.test(a.groupId as string)))
  )
    return { type: 'assignGroup', id: a.id as string, groupId: a.groupId as string | null };
  if (
    a.type === 'group' &&
    id &&
    ['rename', 'remove', 'up', 'down', 'collapse'].includes(a.operation as string) &&
    (a.operation !== 'collapse' || typeof a.collapsed === 'boolean')
  )
    return {
      type: 'group',
      id: a.id as string,
      operation: a.operation as 'rename',
      collapsed: a.collapsed as boolean | undefined,
    };
  if (
    a.type === 'findFiles' &&
    bounded('requestId', 100) &&
    /^[a-zA-Z0-9-]+$/.test(a.requestId as string) &&
    bounded('query', 200)
  )
    return { type: 'findFiles', requestId: a.requestId as string, query: a.query as string };
  if (
    a.type === 'attachFile' &&
    bounded('id', 100) &&
    /^[a-zA-Z0-9-]+$/.test(a.id as string) &&
    (threadId || a.threadId === null)
  )
    return { type: 'attachFile', id: a.id as string, threadId: a.threadId as string | null };
  if (
    a.type === 'send' &&
    bounded('text', 100_000) &&
    (threadId || a.threadId === null) &&
    (a.contextId === null || (bounded('contextId', 100) && /^[a-zA-Z0-9-]+$/.test(a.contextId as string)))
  )
    return {
      type: 'send',
      text: a.text as string,
      threadId: a.threadId as string | null,
      contextId: a.contextId as string | null,
    };
  if (a.type === 'draft' && bounded('text', 100_000) && (threadId || a.threadId === null))
    return { type: 'draft', text: a.text as string, threadId: a.threadId as string | null };
  if (a.type === 'rename' && threadId && bounded('title', 200) && (a.title as string).trim())
    return { type: 'rename', threadId: a.threadId as string, title: a.title as string };
  if (['open', 'bookmark', 'unarchive', 'archive', 'closeChat'].includes(a.type) && threadId)
    return { type: a.type, threadId: a.threadId as string } as Action;
  if (a.type === 'export' && threadId && ['clipboard', 'document'].includes(a.destination as string))
    return { type: 'export', threadId: a.threadId as string, destination: a.destination as 'clipboard' | 'document' };
  if (
    a.type === 'search' &&
    bounded('text', 1000) &&
    typeof a.archived === 'boolean' &&
    (a.deep === undefined || typeof a.deep === 'boolean')
  )
    return { type: 'search', text: a.text as string, archived: a.archived, deep: a.deep === true };
  if (a.type === 'permission' && (a.value === 'read-only' || a.value === 'reviewed'))
    return { type: 'permission', value: a.value };
  if (
    (a.type === 'reviewApply' || a.type === 'reviewPreview') &&
    bounded('id', 100) &&
    Array.isArray(a.accepted) &&
    a.accepted.length <= 40 &&
    a.accepted.every(id => typeof id === 'string' && id.length <= 100) &&
    new Set(a.accepted).size === a.accepted.length
  )
    return { type: a.type, id: a.id as string, accepted: a.accepted };
  if (
    a.type === 'configure' &&
    bounded('model', 100) &&
    efforts.has(a.effort as string) &&
    (a.mode === 'default' || a.mode === 'plan')
  )
    return { type: 'configure', model: a.model as string, effort: a.effort as any, mode: a.mode };
  if ((a.type === 'removeContext' && bounded('id', 100)) || (a.type === 'copy' && bounded('itemId', 200)))
    return a as Action;
  if (a.type === 'link' && bounded('url', 4096)) {
    const url = new URL(a.url as string);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Unsupported link');
    if (url.username || url.password) throw new Error('Credential-bearing link refused');
    return { type: 'link', url: url.href };
  }
  if (
    a.type === 'decision' &&
    ((typeof a.id === 'string' && a.id.length <= 200) || (typeof a.id === 'number' && Number.isSafeInteger(a.id))) &&
    bounded('token', 100) &&
    /^[A-Za-z0-9-]{36}$/.test(a.token as string) &&
    (a.cancel === undefined || typeof a.cancel === 'boolean')
  ) {
    if (a.answers !== undefined) {
      if (!a.answers || typeof a.answers !== 'object' || Array.isArray(a.answers) || Object.keys(a.answers).length > 20)
        throw new Error('Invalid answers');
      for (const v of Object.values(a.answers)) {
        if (
          !v ||
          typeof v !== 'object' ||
          !Array.isArray(v.answers) ||
          v.answers.length > 20 ||
          v.answers.some((s: unknown) => typeof s !== 'string' || s.length > 10_000)
        )
          throw new Error('Invalid answer');
      }
    }
    if (a.accept !== undefined && typeof a.accept !== 'boolean') throw new Error('Invalid decision');
    if (a.session !== undefined && (typeof a.session !== 'boolean' || (a.session && !a.accept)))
      throw new Error('Invalid decision');
    if (a.cancel && a.accept) throw new Error('Conflicting decision');
    if (a.content !== undefined) {
      if (
        !a.content ||
        typeof a.content !== 'object' ||
        Array.isArray(a.content) ||
        Object.keys(a.content).length > 20 ||
        JSON.stringify(a.content).length > 100_000
      )
        throw new Error('Invalid form content');
      for (const value of Object.values(a.content))
        if (!(
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value)) ||
          (typeof value === 'string' && value.length <= 10_000) ||
          (Array.isArray(value) && value.length <= 50 && value.every(v => typeof v === 'string' && v.length <= 1000))
        ))
          throw new Error('Invalid form value');
    }
    return {
      type: 'decision',
      id: a.id,
      token: a.token as string,
      cancel: a.cancel as boolean | undefined,
      accept: a.accept as boolean | undefined,
      answers: a.answers as any,
      content: a.content as any,
      ...(a.session ? { session: true } : {}),
    };
  }
  const requestId =
    typeof a.id === 'string' ? bounded('id', 200) : typeof a.id === 'number' && Number.isSafeInteger(a.id);
  const path = bounded('path', 4096) && !(a.path as string).includes('\0');
  const turnId = bounded('turnId', 200) && /^[A-Za-z0-9_-]+$/.test(a.turnId as string);
  if (a.type === 'openChange' && requestId && /^[A-Za-z0-9-]{36}$/.test(String(a.token)) && path)
    return { type: 'openChange', id: a.id as string | number, token: a.token as string, path: a.path as string };
  if (a.type === 'openTurnFile' && turnId && path)
    return { type: 'openTurnFile', turnId: a.turnId as string, path: a.path as string };
  if ((a.type === 'undoTurn' || a.type === 'rewind' || a.type === 'openTurnChanges') && turnId)
    return { type: a.type, turnId: a.turnId as string };
  throw new Error('Unsupported UI action');
}

export function parseMessage(input: unknown): { channelId: string | null; action: Action } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid view message.');
  const message = input as Record<string, unknown>;
  if (
    message.channelId !== null &&
    (typeof message.channelId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(message.channelId))
  )
    throw new Error('Invalid chat channel.');
  const action = parseAction(message.action);
  if (message.channelId === null && !['ready', 'settings', 'logs'].includes(action.type))
    throw new Error('Choose a chat tab first.');
  return { channelId: message.channelId as string | null, action };
}
