import { Annotations } from './Annotations';
import { Sidebar } from './Sidebar';
import { Usage } from './Usage';
import { ContextMeter } from './ContextMeter';
import { McpForm } from './McpForm';
import { CliSignIn } from './SignIn';
import { SideChat } from './SideChat';
import { Terminals } from './Terminals';
import { Picker } from './Picker';
import { ModelControls } from './ModelControls';
import { LocalData } from './LocalData';
import { Hub } from './Hub';
import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { ResponseMarkdown } from './ResponseMarkdown';
import en from '../locales/en.json';
import zh from '../locales/zh-CN.json';
import {
  busy,
  signedIn,
  type Action,
  type Decision,
  type ViewState,
  type EditReview,
  type TimelineItem,
} from '../src/shared';
import { FileInput } from './FileInput';
import { Activity, ActivityGroup, activityState, activityLabel } from './Activity';
import './style.css';
import { Icon } from './icons';
import { SessionBar, SessionGroups } from './Sessions';
import { IntegrationPanel } from './Integrations';
import { NativeControls } from './NativeControls';
import { Ecosystem } from './Ecosystem';
import { ApprovalCard, TurnChanges } from './Approval';
import { UserMessage } from './UserMessage';
import { TITLE_TOOL } from '../src/sessions/title';

declare function acquireVsCodeApi(): {
  postMessage(message: { channelId: string | null; action: Action }): void;
  getState(): { draft?: string; focusView?: boolean } | undefined;
  setState(state: unknown): void;
};
const api = acquireVsCodeApi();
type Post = (action: Action) => void;
type Messages = typeof en;

function Question({ decision, t, post }: { decision: Decision; t: Messages; post: Post }) {
  const [answers, setAnswers] = useState<Record<string, { answers: string[] }>>({});
  return (
    <section className="decision" aria-label={t.question}>
      <h3>{t.question}</h3>
      <p>
        {t.decisionSource}: {decision.threadId}
      </p>
      {decision.questions!.map(q => (
        <fieldset key={q.id}>
          <legend>{q.question}</legend>
          {q.options?.map(option => (
            <label className="option" key={option.label}>
              <input
                type="radio"
                name={`${decision.id}/${q.id}`}
                value={option.label}
                checked={answers[q.id]?.answers[0] === option.label}
                onChange={() => setAnswers(a => ({ ...a, [q.id]: { answers: [option.label] } }))}
              />
              {option.label}
              <small>{option.description}</small>
            </label>
          ))}
          <label>
            {t.answer}
            <input
              type={q.isSecret ? 'password' : 'text'}
              value={
                q.options?.some(o => o.label === answers[q.id]?.answers[0]) ? '' : (answers[q.id]?.answers[0] ?? '')
              }
              onChange={e => setAnswers(a => ({ ...a, [q.id]: { answers: [e.target.value] } }))}
            />
          </label>
        </fieldset>
      ))}
      <div className="actions">
        <button
          disabled={decision.questions!.some(q => !answers[q.id]?.answers[0]?.trim())}
          onClick={() => post({ type: 'decision', id: decision.id, token: decision.token, answers })}
        >
          {t.submit}
        </button>
        <button
          className="secondary"
          onClick={() => post({ type: 'decision', id: decision.id, token: decision.token, cancel: true })}
        >
          {t.cancelQuestion}
        </button>
      </div>
    </section>
  );
}

function Review({ review, t, post }: { review: EditReview; t: Messages; post: Post }) {
  const [accepted, setAccepted] = useState(review.hunks.map(h => h.id));
  return (
    <section className="decision review" aria-label={t.reviewEdits}>
      <h3>
        {t.reviewEdits} · {review.path}
      </h3>
      <p>{t.reviewHelp}</p>
      {review.hunks.map((h, i) => (
        <fieldset key={h.id}>
          <legend>
            <label>
              <input
                type="checkbox"
                checked={accepted.includes(h.id)}
                onChange={e => setAccepted(ids => (e.target.checked ? [...ids, h.id] : ids.filter(id => id !== h.id)))}
              />
              {t.replacement} {i + 1}
            </label>
          </legend>
          <div className="replacement">
            <div>
              <small>{t.before}</small>
              <pre>{h.before || t.emptyText}</pre>
            </div>
            <div>
              <small>{t.after}</small>
              <pre>{h.after || t.emptyText}</pre>
            </div>
          </div>
        </fieldset>
      ))}
      <div className="actions">
        <button className="secondary" onClick={() => post({ type: 'reviewPreview', id: review.id, accepted })}>
          {t.previewDiff}
        </button>
        <button disabled={!accepted.length} onClick={() => post({ type: 'reviewApply', id: review.id, accepted })}>
          {t.applySelected}
        </button>
        <button className="secondary" onClick={() => post({ type: 'reviewApply', id: review.id, accepted: [] })}>
          {t.rejectAll}
        </button>
      </div>
    </section>
  );
}

function App() {
  const [state, setState] = useState<ViewState>();
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'state')
        setState(previous => {
          const next = event.data.state as ViewState;
          return {
            ...next,
            items: next.items ?? (previous && previous.channelId === next.channelId ? previous.items : []),
          };
        });
    };
    window.addEventListener('message', handler);
    api.postMessage({ channelId: null, action: { type: 'ready' } });
    return () => window.removeEventListener('message', handler);
  }, []);
  const post = useCallback(
    (action: Action) => api.postMessage({ channelId: state?.channelId ?? null, action }),
    [state?.channelId],
  );
  return state ? (
    document.body.dataset.surface === 'sidebar' ? (
      <Sidebar key={state.channelId} state={state} t={state.locale === 'zh-CN' ? zh : en} post={post} />
    ) : (
      <Chat key={state.channelId} state={state} />
    )
  ) : (
    <main>
      <p role="status">{en.connecting}</p>
    </main>
  );
}
/** C0/C1 controls (except tab and line breaks) and bidirectional overrides can hide what a prompt says. */
const invisibleControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
/** "5 min", "3 h", "2 d" or a date, in the user's locale. */
function relativeTime(seconds: number, locale: string) {
  const minutes = Math.max(0, (Date.now() / 1000 - seconds) / 60);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (minutes < 60) return format.format(-Math.round(minutes), 'minute');
  if (minutes < 60 * 24) return format.format(-Math.round(minutes / 60), 'hour');
  if (minutes < 60 * 24 * 7) return format.format(-Math.round(minutes / 1440), 'day');
  return new Date(seconds * 1000).toLocaleDateString(locale);
}
function Chat({ state }: { state: ViewState }) {
  const post = useCallback<Post>(action => api.postMessage({ channelId: state.channelId!, action }), [state.channelId]);
  const [pane, setPane] = useState<
    | 'chat'
    | 'hub'
    | 'skills'
    | 'mcp'
    | 'ecosystem'
    | 'agents'
    | 'memories'
    | 'usage'
    | 'settings'
    | 'side'
    | 'terminals'
  >('chat');
  const [menu, setMenu] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState<string>();
  useEffect(() => {
    if (!menu) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(false);
        moreButton.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [menu]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(undefined), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  // Thread being renamed in place; a different current thread cancels the edit.
  const [renaming, setRenaming] = useState<string>();
  const [integrationRequest, setIntegrationRequest] = useState<string>();
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === 'showChat') {
        setPane('chat');
        setHistory(false);
        setMenu(false);
      }
      if (data?.type === 'copied' && data.channelId === state.channelId && data.threadId === threadRef.current)
        setCopied(data.itemId);
      if (data?.type === 'voiceAnswer' && data.channelId === state.channelId)
        void call.current?.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp }).catch(() => endCall());
      if (data?.type === 'voiceFailed' && data.channelId === state.channelId) endCall();
      if (data?.type === 'voiceAudio' && data.channelId === state.channelId) playFrameRef.current(data.pcm, data.rate);
      if (data?.type === 'voiceTranscript' && data.channelId === state.channelId)
        changeDraftRef.current(text => (text.trim() ? `${text.trimEnd()} ${data.text}` : data.text));
      // Another view of this chat typed; mirror its text without posting it back.
      if (data?.type === 'draftSync' && data.channelId === state.channelId && data.threadId === threadRef.current)
        setDraft(data.text);
      if (data?.type === 'integrationsRefreshed' && data.channelId === state.channelId)
        setIntegrationRequest(current => (current === data.requestId ? undefined : current));
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [state.channelId]);
  useEffect(
    () => () => {
      if (pane === 'memories') post({ type: 'closeMemory' });
    },
    [pane, post],
  );
  const [draft, setDraft] = useState(state.draft);
  const threadRef = useRef(state.threadId ?? null);
  threadRef.current = state.threadId ?? null;
  const [history, setHistory] = useState(false);
  const [focusView, setFocusView] = useState(() => api.getState()?.focusView ?? false);
  const [attaching, setAttaching] = useState(false);
  const [imageError, setImageError] = useState<string>();
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const shownImages = useRef<string[]>([]);
  useEffect(() => {
    // Previews hold full data URLs: drop each one once its image leaves the composer (sent, removed or
    // another chat). Ids the host has not echoed yet are kept. ponytail: a paste the host refuses keeps its preview until reload.
    const now = state.images?.map(image => image.id) ?? [],
      gone = shownImages.current.filter(id => !now.includes(id));
    shownImages.current = now;
    if (gone.length)
      setPreviews(current => Object.fromEntries(Object.entries(current).filter(([id]) => !gone.includes(id))));
  }, [state.images]);
  const [following, setFollowing] = useState(true);
  const [filter, setFilter] = useState('');
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);
  const sessions = history ? state.sessions.filter(s => !bookmarkedOnly || s.bookmarked) : [];
  // Typing filters titles from the runtime's state DB, which answers in milliseconds; Enter searches messages.
  useEffect(() => {
    if (!history || filter === state.sessionsSearch) return;
    const timer = setTimeout(() => post({ type: 'search', text: filter, archived: state.sessionsArchived }), 250);
    return () => clearTimeout(timer);
  }, [filter, history]);
  const timeline = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const scrollPosition = useRef(0);
  const scrollThread = useRef(state.threadId);
  useLayoutEffect(() => {
    if (scrollThread.current !== state.threadId) {
      scrollThread.current = state.threadId;
      follow.current = true;
      scrollPosition.current = 0;
      setFollowing(true);
    }
    if (pane === 'chat' && !history && timeline.current)
      timeline.current.scrollTop = follow.current ? timeline.current.scrollHeight : scrollPosition.current;
  }, [state.threadId, pane, history]);
  useEffect(() => {
    setImageError(undefined);
    setMenu(false);
    setCopied(undefined);
    setRenaming(undefined);
  }, [state.threadId]);
  // Take the host's draft only when the host replaced it (send, chat switch, dictation); echoes of this
  // view's own keystrokes can arrive after newer ones and would overwrite them, breaking IME composition.
  const sent = useRef<string | undefined>(undefined);
  const shownThread = useRef(state.threadId);
  useEffect(() => {
    // A first message in an empty tab creates the chat; that is still the chat being typed into.
    const sameChat =
        shownThread.current === state.threadId || (shownThread.current === undefined && sent.current !== undefined),
      typedAfterSend = sent.current !== undefined && draft !== sent.current;
    shownThread.current = state.threadId;
    if (sent.current !== undefined && state.draft === '') setImageError(undefined);
    sent.current = undefined;
    // The host clears the draft once a send is acknowledged; text typed meanwhile stays and is resent to it.
    if (sameChat && state.draft === '' && typedAfterSend) changeDraft(draft);
    else setDraft(state.draft);
  }, [state?.draftEpoch, state?.threadId]);
  useEffect(() => {
    document.documentElement.lang = state?.locale ?? 'en';
  }, [state?.locale]);
  const renderedItems = useRef<TimelineItem[]>([]);
  useEffect(() => {
    const previous = renderedItems.current;
    renderedItems.current = state.items;
    // Host broadcasts clone items even when only the editor selection changes.
    const changed =
      previous.length !== state.items.length ||
      state.items.some(
        (item, index) =>
          Object.keys(item).length !== Object.keys(previous[index] ?? {}).length ||
          Object.entries(item).some(([key, value]) => value !== previous[index]?.[key as keyof TimelineItem]),
      );
    if (changed && follow.current && timeline.current && !state.decisions.length)
      timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [state.items]);
  const t = state?.locale === 'zh-CN' ? zh : en;
  const running = busy(state.status);
  // Native requests authenticate themselves; a slow account display must not block the chat.
  const online = Boolean(state.runtimeVersion) && !['offline', 'connecting', 'unknown'].includes(state.status);
  const model = state.models.find(m => m.model === state.model);
  const modelReady = Boolean(model?.supportedReasoningEfforts.some(option => option.reasoningEffort === state.effort));
  const canSend =
    modelReady &&
    (draft.trim() || state.images?.length || state.annotations?.length) &&
    !attaching &&
    !state.integrationBusy &&
    !running &&
    online &&
    !state.editorContextPending;
  const send = () => {
    if (canSend) {
      sent.current = draft;
      post({ type: 'send', text: draft, threadId: state.threadId ?? null, contextId: state.activeEditor?.id ?? null });
    }
  };
  const pasteImages = (event: React.ClipboardEvent) => {
    // Clipboard files must be collected while the paste event is dispatched.
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')),
      text = event.clipboardData.getData('text/plain');
    if (text) {
      const input = event.target as HTMLTextAreaElement,
        cleaned = text.replace(invisibleControls, '');
      // Office-style copies carry text plus a rendered image; the text is what was meant.
      setImageError(files.length ? t.imageAsText : undefined);
      if (cleaned !== text && input.id === 'composer') {
        event.preventDefault();
        changeDraft(draft.slice(0, input.selectionStart) + cleaned + draft.slice(input.selectionEnd));
        setImageError(t.pasteCleaned.replace('{count}', String(text.length - cleaned.length)));
      }
      return;
    }
    if (!files.length) return;
    event.preventDefault();
    setImageError(undefined);
    for (const file of files) {
      if (!/^image\/(?:png|jpeg|gif|webp)$/.test(file.type)) setImageError(t.imageType);
      else if (file.size > 10 * 1024 * 1024) setImageError(t.imageTooLarge);
      else {
        const reader = new FileReader(),
          threadId = state.threadId ?? null;
        reader.onload = () => {
          const id = crypto.randomUUID(),
            data = reader.result as string;
          setPreviews(current => ({ ...current, [id]: data }));
          post({ type: 'pasteImage', id, name: file.name || 'image', data, threadId });
        };
        reader.readAsDataURL(file);
      }
    }
  };
  // Voice: the host records (VS Code gives webviews no microphone) and streams PCM here; the webview turns it
  // into the audio track of a WebRTC call whose SDP the host relays through the runtime.
  const call = useRef<{
    pc: RTCPeerConnection;
    annotationId?: string;
    ctx: AudioContext;
    dest: MediaStreamAudioDestinationNode;
    next: number;
  } | null>(null);
  const endCall = useCallback(() => {
    call.current?.pc.close();
    void call.current?.ctx.close().catch(() => {});
    call.current = null;
  }, []);
  useEffect(() => endCall, [endCall]);
  useEffect(() => {
    if (state.voice?.status === 'idle') endCall();
  }, [state.voice?.status, endCall]);
  const playFrame = (base64: string, rate: number) => {
    const current = call.current;
    if (!current) return;
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    const buffer = current.ctx.createBuffer(1, pcm.length, rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    const source = current.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(current.dest);
    const at = Math.max(current.ctx.currentTime, current.next);
    source.start(at);
    current.next = at + buffer.duration;
  };
  const startCall = async (annotationId?: string) => {
    const threadId = state.threadId;
    if (typeof RTCPeerConnection === 'undefined' || typeof AudioContext === 'undefined')
      return setImageError(t.voiceUnsupported);
    if (call.current) return;
    const ctx = new AudioContext({ sampleRate: 16000 }),
      dest = ctx.createMediaStreamDestination(),
      pc = new RTCPeerConnection();
    call.current = { pc, ctx, dest, next: 0, annotationId };
    try {
      await ctx.resume().catch(() => {});
      if (call.current?.pc !== pc) return;
      dest.stream.getAudioTracks().forEach(track => pc.addTrack(track, dest.stream));
      pc.createDataChannel('oai-events');
      const offer = await pc.createOffer();
      if (call.current?.pc !== pc) return;
      await pc.setLocalDescription(offer);
      if (call.current?.pc !== pc) return;
      await new Promise<void>(resolve => {
        if (pc.iceGatheringState === 'complete') return resolve();
        pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && resolve());
        setTimeout(resolve, 3000);
      });
      if (call.current?.pc !== pc) return;
      setImageError(undefined);
      post({ type: 'voiceOffer', sdp: pc.localDescription!.sdp, ...(annotationId ? { annotationId, threadId } : {}) });
    } catch (error) {
      if (call.current?.pc !== pc) return;
      endCall();
      setImageError(error instanceof Error ? error.message : t.voiceUnsupported);
    }
  };
  // Message handlers registered once still reach the latest draft through this ref.
  const [voiceSeconds, setVoiceSeconds] = useState(0);
  useEffect(() => {
    if (state.voice?.status !== 'recording') return setVoiceSeconds(0);
    const started = Date.now();
    const timer = setInterval(() => setVoiceSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [state.voice?.status]);
  const playFrameRef = useRef(playFrame);
  playFrameRef.current = playFrame;
  const changeDraftRef = useRef<(update: (text: string) => string) => void>(() => {});
  changeDraftRef.current = update => changeDraft(update(draft));
  const changeDraft = (text: string) => {
    setDraft(text);
    api.setState({ draft: text, focusView });
    post({ type: 'draft', text, threadId: state.threadId ?? null });
  };
  /** Replaces or extends the draft, then focuses the end so the composer's @ / $ trigger detection sees it. */
  const insertDraft = (text: string, append = false) => {
    const next = append ? draft + (draft && !/\s$/.test(draft) ? ' ' : '') + text : text;
    changeDraft(next);
    requestAnimationFrame(() => {
      const input = document.getElementById('composer') as HTMLTextAreaElement | null;
      input?.setSelectionRange(next.length, next.length);
      input?.focus();
    });
  };
  const refreshIntegrations = () => {
    const requestId = crypto.randomUUID();
    setIntegrationRequest(requestId);
    post({ type: 'refreshIntegrations', requestId });
  };
  const openPane = (value: typeof pane) => {
    setPane(value);
    if (
      ['hub', 'settings', 'side', 'terminals'].includes(value) ||
      !state.runtimeVersion ||
      ['offline', 'connecting', 'unknown'].includes(state.status)
    )
      return;
    if (value === 'skills' || value === 'mcp') refreshIntegrations();
    else if (value !== 'chat' && (value !== 'agents' || state.threadId))
      post({
        type:
          value === 'usage'
            ? 'refreshUsage'
            : value === 'agents'
              ? 'refreshAgents'
              : value === 'memories'
                ? 'browseMemories'
                : 'refreshEcosystem',
      });
  };
  const activeTurn = state.items.at(-1)?.turnId;
  const inHub = ['skills', 'mcp', 'agents', 'memories', 'usage', 'ecosystem', 'settings', 'terminals'].includes(pane);
  const toggleFocusView = () => {
    setFocusView(!focusView);
    api.setState({ draft, focusView: !focusView });
  };
  // New chat replaces the current one in place, as in the official clients; the old chat stays in
  // History. Only a chat that is still working keeps its tab, and the new chat opens beside it.
  const startNewChat = () => {
    setPane('chat');
    setHistory(false);
    const working =
      running ||
      state.status === 'unknown' ||
      state.agents?.busy ||
      state.agents?.tasks.some(task => ['running', 'active', 'pendingInit'].includes(task.status));
    if (working) post({ type: 'newTab' });
    else if (state.threadId) post({ type: 'new' });
    else document.getElementById('composer')?.focus();
  };
  const paneTitles = {
    chat: t.chat,
    hub: t.hubTitle,
    skills: t.skills,
    mcp: t.mcp,
    agents: t.agentTasks,
    memories: t.memoryBrowser,
    usage: t.usage,
    ecosystem: t.ecosystem,
    settings: t.runtimePane,
    side: t.sideTitle,
    terminals: t.terminalsTitle,
  };
  const canRewind =
    state.permission === 'agent' &&
    state.owned &&
    state.writable !== false &&
    !running &&
    online &&
    !state.operationBusy;
  const approvalPreset =
    state.profile === ':danger-full-access'
      ? 'full'
      : state.approval === 'untrusted'
        ? 'review'
        : state.approval === 'on-request'
          ? state.reviewer === 'auto_review'
            ? 'auto'
            : 'ask'
          : 'custom';
  const approvalLabels = {
    review: t.approval_review,
    ask: t.approval_ask,
    auto: t.approval_auto,
    full: t.approval_full,
    custom: t.modeCustom,
  };
  // Catalog names read "GPT-6.1-Sol"; the official clients show "GPT-6.1 Sol".
  const modelName = (name: string) => name.replace(/-([A-Za-z][a-z]+)$/, ' $1');
  const effortLabel = (effort: string) => (t as Record<string, string>)[`effort_${effort}`] ?? effort;
  // Runs of 2+ settled tool calls within one turn fold into a single summary line.
  const activityGroups = new Map<number, TimelineItem[]>(),
    grouped = new Set<number>();
  let run: number[] = [];
  const flush = () => {
    if (run.length > 1) {
      activityGroups.set(
        run[0],
        run.map(i => state.items[i]),
      );
      run.forEach(i => grouped.add(i));
    }
    run = [];
  };
  const hiddenActivity = (item: TimelineItem) =>
    (item.type === 'reasoning' && !item.text.trim() && item.status === 'completed') ||
    (item.type === 'dynamicToolCall' && item.title === TITLE_TOOL && item.status !== 'failed');
  state.items.forEach((item, index) => {
    if (hiddenActivity(item)) return;
    const tool = !['agentMessage', 'userMessage', 'plan'].includes(item.type);
    const status = activityState(item, running && item.turnId === activeTurn);
    if (tool && focusView && status === 'completed') return;
    if (!tool || status === 'running' || (run.length && state.items[run[0]].turnId !== item.turnId)) flush();
    if (tool && status !== 'running') run.push(index);
  });
  flush();
  const currentActivity = state.items
    .filter(item => !hiddenActivity(item) && item.turnId === activeTurn && activityState(item) === 'running')
    .at(-1);
  return (
    <main className={`app${history && pane === 'chat' ? ' history-open' : ''}`}>
      <header>
        {pane !== 'chat' || history ? (
          <button
            className="icon-button"
            aria-label={inHub && pane !== 'hub' ? t.backToHub : t.backToChat}
            title={inHub && pane !== 'hub' ? t.backToHub : t.backToChat}
            onClick={() => {
              setHistory(false);
              setPane(inHub && pane !== 'hub' ? 'hub' : 'chat');
            }}
          >
            <Icon name="back" />
          </button>
        ) : null}
        <div className="header-heading">
          {pane !== 'chat' ? (
            <strong>{paneTitles[pane]}</strong>
          ) : history ? (
            <strong>{t.history}</strong>
          ) : state.threadId && state.owned ? (
            renaming === state.threadId ? (
              <input
                className="conversation-title-input"
                aria-label={t.renameChat}
                defaultValue={state.title || ''}
                maxLength={200}
                autoFocus
                onFocus={e => e.currentTarget.select()}
                onKeyDown={e => {
                  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                  if (e.key === 'Escape') e.currentTarget.value = state.title || '';
                  if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
                }}
                onBlur={e => {
                  const title = e.currentTarget.value.trim();
                  setRenaming(undefined);
                  if (title && title !== state.title) post({ type: 'rename', threadId: renaming, title });
                }}
              />
            ) : (
              <button
                className="conversation-title"
                title={t.renameChat}
                disabled={running}
                onClick={() => setRenaming(state.threadId)}
              >
                {state.title || t.newChat}
              </button>
            )
          ) : (
            <strong title={state.title}>{state.title || t.newChat}</strong>
          )}
        </div>
        <div className="toolbar">
          <button
            className="icon-button"
            aria-label={t.history}
            title={t.history}
            onClick={() => {
              setPane('chat');
              if (!history && online) post({ type: 'refresh' });
              setHistory(!history);
            }}
            aria-expanded={history}
          >
            <Icon name="history" />
          </button>
          <button
            className="icon-button"
            aria-label={t.newChat}
            title={t.newChat}
            disabled={state.integrationBusy}
            onClick={startNewChat}
          >
            <Icon name="plus" />
          </button>
          <button
            className="icon-button"
            aria-label={t.moreActions}
            ref={moreButton}
            title={t.moreActions}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(open => !open)}
          >
            <Icon name="more" />
          </button>
        </div>
        {menu ? (
          <>
            <div className="menu-backdrop" onClick={() => setMenu(false)} />
            <div className="menu" role="menu" onClick={() => setMenu(false)}>
              {state.threadId && online ? (
                <button role="menuitem" onClick={() => setPane('side')}>
                  {t.sideTitle}
                </button>
              ) : null}
              <button role="menuitem" disabled={running} onClick={() => post({ type: 'checkpoints' })}>
                {t.checkpoints}
              </button>
              {state.threadId && state.permission === 'agent' && online && !running ? (
                <button role="menuitem" disabled={state.integrationBusy} onClick={() => post({ type: 'fork' })}>
                  {t.forkChat}
                </button>
              ) : null}
              {state.threadId && online && !running ? (
                <>
                  <button
                    role="menuitem"
                    onClick={() => post({ type: 'export', threadId: state.threadId!, destination: 'clipboard' })}
                  >
                    {t.copyChat}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => post({ type: 'export', threadId: state.threadId!, destination: 'document' })}
                  >
                    {t.exportChat}
                  </button>
                  {state.owned ? (
                    <button role="menuitem" onClick={() => post({ type: 'archive', threadId: state.threadId! })}>
                      {t.archiveChat}
                    </button>
                  ) : null}
                </>
              ) : null}
              <hr />
              <button role="menuitem" onClick={() => post({ type: 'worktree' })}>
                {t.newWorktree}
              </button>
              <button role="menuitem" onClick={() => openPane('hub')}>
                {t.hubTitle}
              </button>
            </div>
          </>
        ) : null}
      </header>
      {(state.tabs?.length ?? 0) > 1 ? <SessionBar state={state} t={t} post={post} /> : null}
      {state.auth ? (
        <aside className="auth-state" role="status">
          <span>
            {state.auth.name ? `${state.auth.name}: ` : ''}
            {state.auth.status === 'pending'
              ? t.authPending
              : state.auth.status === 'success'
                ? t.authSuccess
                : state.auth.status === 'failed'
                  ? t.authFailed
                  : t.authUnknown}
          </span>
        </aside>
      ) : null}
      {pane !== 'chat' && state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      {pane !== 'chat' && state.decisions.length ? (
        <button className="secondary" onClick={() => setPane('chat')}>
          {t.pendingDecisions} ({state.decisions.length})
        </button>
      ) : null}
      {pane === 'hub' ? (
        <Hub state={state} t={t} post={post} open={openPane} focusView={focusView} toggleFocusView={toggleFocusView} />
      ) : pane === 'settings' ? (
        <section className="settings-pane">
          {state.permission === 'agent' && state.nativeReady ? (
            <NativeControls state={state} t={t} post={post} open />
          ) : null}
          {state.permission !== 'agent' ? <p className="context-note">{t.boundary}</p> : null}
          <p className="context-note">{t.coexistence}</p>
          <p className="context-note">{state.runtimeVersion ? `${t.version} ${state.runtimeVersion}` : t.offline}</p>
          {state.threadId ? (
            <button
              className="secondary"
              disabled={running}
              onClick={() => post({ type: 'closeChat', threadId: state.threadId! })}
            >
              {t.closeChat}
            </button>
          ) : null}
        </section>
      ) : pane === 'side' ? (
        <SideChat key={state.threadId ?? 'none'} state={state} t={t} post={post} />
      ) : pane === 'terminals' ? (
        <Terminals state={state} t={t} post={post} />
      ) : pane === 'usage' ? (
        <Usage state={state} t={t} post={post} />
      ) : pane === 'agents' || pane === 'memories' ? (
        <LocalData key={pane} kind={pane} state={state} t={t} post={post} />
      ) : pane === 'ecosystem' ? (
        <Ecosystem state={state} t={t} post={post} />
      ) : pane !== 'chat' ? (
        <IntegrationPanel
          key={pane}
          state={state}
          t={t}
          kind={pane}
          pending={integrationRequest !== undefined}
          refresh={refreshIntegrations}
          post={post}
          back={() => setPane('chat')}
        />
      ) : (
        <>
          {!online || ['failed', 'interrupted'].includes(state.status) ? (
            <div className="connection">
              <span role="status" aria-live="polite">
                <i
                  className={`status-dot ${['failed', 'interrupted'].includes(state.status) ? state.status : online ? 'online' : ''}`}
                />
                {t[state.status]}
              </span>
              <span>{state.runtimeVersion ? `Codex ${state.runtimeVersion}` : ''}</span>
            </div>
          ) : null}
          {state.items.length && !signedIn(state.account) ? <CliSignIn state={state} t={t} post={post} /> : null}
          {history ? (
            <section className="history" aria-label={t.history}>
              <form
                className="history-search"
                onSubmit={e => {
                  e.preventDefault();
                  if (!filter.trim()) return;
                  post({ type: 'search', text: filter, archived: state.sessionsArchived, deep: true });
                }}
              >
                <Icon name="search" />
                <input
                  aria-label={t.searchChats}
                  placeholder={t.searchChats}
                  value={filter}
                  autoFocus
                  onChange={e => setFilter(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Escape') setHistory(false);
                  }}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t.close}
                  title={t.close}
                  onClick={() => setHistory(false)}
                >
                  <Icon name="close" />
                </button>
              </form>
              <div className="history-filters" role="group" aria-label={t.historyScope}>
                {(['all', 'bookmarked', 'archived'] as const).map(scope => (
                  <button
                    key={scope}
                    className="text-button"
                    aria-pressed={
                      scope === (state.sessionsArchived ? 'archived' : bookmarkedOnly ? 'bookmarked' : 'all')
                    }
                    onClick={() => {
                      setBookmarkedOnly(scope === 'bookmarked');
                      const archived = scope === 'archived';
                      if (archived !== state.sessionsArchived) post({ type: 'search', text: filter, archived });
                    }}
                  >
                    {scope === 'all' ? t.allChats : scope === 'bookmarked' ? t.bookmarkedOnly : t.archived}
                  </button>
                ))}
              </div>
              {filter.trim() ? (
                <p className="history-hint" role="status">
                  {state.sessionsSearching ? t.searchingMessages : t.deepSearchHint}
                </p>
              ) : null}
              {sessions.length === 0 ? (
                <p className="context-note">{filter.trim() || bookmarkedOnly ? t.noMatches : t.noHistory}</p>
              ) : (
                <ul className="history-list">
                  {sessions.map(s => (
                    <li key={s.id} className={state.threadId === s.id ? 'current' : undefined}>
                      <button
                        disabled={state.sessionsArchived || state.integrationBusy}
                        className="session"
                        aria-current={state.threadId === s.id ? 'true' : undefined}
                        onClick={() => {
                          post({ type: 'open', threadId: s.id });
                          setHistory(false);
                        }}
                      >
                        <span className="session-title">{s.title || t.newChat}</span>
                        <small className="session-time">{relativeTime(s.updatedAt, state.locale)}</small>
                        {s.snippet ? <small className="snippet">{s.snippet}</small> : null}
                      </button>
                      <button
                        className={`icon-button bookmark${s.bookmarked ? ' active' : ''}`}
                        aria-pressed={s.bookmarked}
                        aria-label={s.bookmarked ? t.removeBookmark : t.bookmark}
                        title={s.bookmarked ? t.removeBookmark : t.bookmark}
                        onClick={() => post({ type: 'bookmark', threadId: s.id })}
                      >
                        <Icon name="bookmark" />
                      </button>
                      {state.sessionsArchived && s.owned ? (
                        <button
                          className="text-button"
                          disabled={running || !online}
                          onClick={() => post({ type: 'unarchive', threadId: s.id })}
                        >
                          {t.restoreChat}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {state.sessionsCursor ? (
                <button className="text-button" onClick={() => post({ type: 'moreSessions' })}>
                  {t.more}
                </button>
              ) : null}
              <SessionGroups state={state} t={t} post={post} />
            </section>
          ) : null}
          <div
            className={`timeline ${!state.items.length ? 'is-empty' : ''}`}
            ref={timeline}
            onScroll={() => {
              const el = timeline.current!;
              if (!el.clientHeight) return;
              scrollPosition.current = el.scrollTop;
              follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              setFollowing(follow.current);
            }}
          >
            {!state.items.length ? (
              <>
                <section className="welcome">
                  <h1>
                    <svg className="welcome-logo" viewBox="90 90 844 844" fill="currentColor" aria-hidden="true">
                      <path d="M195 372 512 160V399L341 512V715L195 609Z M683 309 829 414V652L512 864V625L683 511Z" />
                    </svg>
                    <span>{t.welcome}</span>
                  </h1>
                  <p>{online ? t.emptyHint : t.intro}</p>
                  {!online &&
                  !(
                    state.runtimeVersion &&
                    state.account === 'unavailable' &&
                    !['offline', 'connecting', 'unknown'].includes(state.status)
                  ) ? (
                    <button disabled={running || state.integrationBusy} onClick={() => post({ type: 'connect' })}>
                      {state.runtimeVersion ? t.reconnect : t.connect}
                    </button>
                  ) : null}
                  {online && signedIn(state.account) && !draft ? (
                    <div className="starters">
                      {(
                        [
                          ['bulb', t.starterExplain, t.starterExplainPrompt],
                          ['search', t.starterDebug, t.starterDebugPrompt],
                          ['list', t.starterPlan, t.starterPlanPrompt],
                        ] as const
                      ).map(([icon, label, prompt]) => (
                        <button key={label} className="starter" onClick={() => insertDraft(prompt)}>
                          <Icon name={icon} />
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {state.projectless ? (
                    <p className="context-note">{t.projectless.replace('{path}', state.projectless)}</p>
                  ) : null}
                </section>
                <CliSignIn state={state} t={t} post={post} />
              </>
            ) : null}
            {state.historyCursor ? (
              <button className="secondary" disabled={running} onClick={() => post({ type: 'moreHistory' })}>
                {t.more}
              </button>
            ) : null}
            {state.items.map((item, index) => (
              <React.Fragment key={`${item.turnId}/${item.id}`}>
                {item.type === 'agentMessage' || item.type === 'userMessage' || item.type === 'plan' ? (
                  <article
                    className={`message ${item.type}${item.phase === 'commentary' ? ' commentary' : ''}`}
                    tabIndex={0}
                    aria-label={item.type === 'userMessage' ? t.user : item.type === 'plan' ? t.plan : t.agent}
                  >
                    {item.type === 'plan' ? <div className="message-label">{t.plan}</div> : null}
                    {item.truncated ? <p className="notice">{t.truncated}</p> : null}
                    {item.type === 'userMessage' ? (
                      <UserMessage text={item.text} t={t} />
                    ) : (
                      <div
                        className={item.type === 'agentMessage' ? 'assistant-quote-source' : undefined}
                        data-item-id={item.id}
                        data-turn-id={item.turnId}
                      >
                        <ResponseMarkdown text={item.text} post={post} />
                      </div>
                    )}
                    {item.type === 'plan' && !item.truncated && state.permission === 'agent' ? (
                      <div className="plan-review">
                        <div className="actions plan-actions">
                          <button className="secondary" onClick={() => post({ type: 'planOpen', itemId: item.id })}>
                            {t.planOpen}
                          </button>
                          <button
                            disabled={running || !online || state.writable === false}
                            title={t.planProceedHelp}
                            onClick={() => post({ type: 'planProceed', itemId: item.id })}
                          >
                            {t.planProceed}
                          </button>
                        </div>
                        <p className="context-note">{t.planProceedHelp}</p>
                      </div>
                    ) : null}
                    {item.type === 'agentMessage' || (item.type === 'userMessage' && canRewind) ? (
                      <div className="message-actions">
                        {item.type === 'agentMessage' ? (
                          <button
                            className="icon-button"
                            aria-label={copied === item.id ? t.copied : t.copy}
                            title={copied === item.id ? t.copied : t.copy}
                            disabled={item.truncated}
                            onClick={() => post({ type: 'copy', itemId: item.id })}
                          >
                            <Icon name={copied === item.id ? 'check' : 'copy'} />
                          </button>
                        ) : (
                          <button
                            className="text-button rewind"
                            title={t.rewindHelp}
                            onClick={() => post({ type: 'rewind', turnId: item.turnId })}
                          >
                            {t.rewind}
                          </button>
                        )}
                      </div>
                    ) : null}
                  </article>
                ) : hiddenActivity(item) ? null : activityGroups.has(index) ? (
                  <ActivityGroup items={activityGroups.get(index)!} t={t} />
                ) : grouped.has(index) ||
                  (focusView && activityState(item, running && item.turnId === activeTurn) === 'completed') ? null : (
                  <Activity item={item} t={t} active={running && item.turnId === activeTurn} />
                )}
                {state.turnChanges?.[item.turnId]?.length && state.items[index + 1]?.turnId !== item.turnId ? (
                  <TurnChanges
                    turnId={item.turnId}
                    files={state.turnChanges[item.turnId]}
                    t={t}
                    post={post}
                    disabled={running || state.permission !== 'agent'}
                  />
                ) : null}
              </React.Fragment>
            ))}
            {state.decisions.map(decision =>
              decision.form ? (
                <McpForm key={decision.token} decision={decision} t={t} post={post} />
              ) : decision.kind === 'question' ? (
                <Question key={decision.token} decision={decision} t={t} post={post} />
              ) : decision.kind === 'approval' &&
                ['item/fileChange/requestApproval', 'item/commandExecution/requestApproval'].includes(
                  decision.method,
                ) ? (
                <ApprovalCard key={decision.token} decision={decision} t={t} post={post} />
              ) : (
                <section className="decision" key={decision.token}>
                  <p>
                    {t.decisionSource}:{' '}
                    {state.agents?.tasks.find(task => task.id === decision.threadId)?.title ?? decision.threadId}
                  </p>
                  <p>{decision.kind === 'approval' ? t.approvalRequest : t.blocked}</p>
                  {decision.scope ? (
                    <p>
                      {decision.scope === 'turn'
                        ? t.approvalTurn
                        : decision.scope === 'session'
                          ? t.approvalSession
                          : t.approvalRequestOnly}
                    </p>
                  ) : null}
                  {decision.truncated ? <p role="alert">{t.approvalTruncated}</p> : null}
                  {decision.summary ? <pre>{decision.summary}</pre> : null}
                  <div className="actions">
                    {decision.canAccept ? (
                      <button
                        onClick={() => post({ type: 'decision', id: decision.id, token: decision.token, accept: true })}
                      >
                        {decision.method === 'mcpServer/elicitation/request'
                          ? t.openAuthorization
                          : decision.scope === 'turn'
                            ? t.approveTurn
                            : decision.scope === 'session'
                              ? t.approveRoot
                              : t.approveOnce}
                      </button>
                    ) : null}
                    <button
                      className="secondary"
                      onClick={() => post({ type: 'decision', id: decision.id, token: decision.token })}
                    >
                      {t.decline}
                    </button>
                    <button
                      className="text-button"
                      onClick={() => post({ type: 'decision', id: decision.id, token: decision.token, cancel: true })}
                    >
                      {t.cancelTurn}
                    </button>
                  </div>
                </section>
              ),
            )}
            {state.review ? <Review key={state.review.id} review={state.review} t={t} post={post} /> : null}
          </div>
          {!following && state.items.length ? (
            <button
              className="jump-latest secondary"
              onClick={() => {
                follow.current = true;
                setFollowing(true);
                if (timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
              }}
            >
              {t.jumpLatest}
            </button>
          ) : null}
          <footer>
            {state.queued?.length ? (
              <div className="queued-messages">
                <small>{t.queued}</small>
                {state.queued.map(q => (
                  <div key={q.id}>
                    <span>{q.text}</span>
                    <button className="text-button" onClick={() => post({ type: 'removeQueued', id: q.id })}>
                      {t.remove}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {running ? (
              <div className="live-activity" role="status">
                <Icon name="spinner" />
                <span>
                  {currentActivity
                    ? `${activityLabel(currentActivity, t)}${currentActivity.detail ? ` · ${currentActivity.detail}` : ''}`
                    : t[state.status]}
                </span>
              </div>
            ) : null}
            {state.error ? (
              <div role="alert" className="banner error">
                <span>{state.error}</span>
                {!running && ['offline', 'unknown'].includes(state.status) ? (
                  <button className="secondary" onClick={() => post({ type: 'connect' })}>
                    {t.reconnect}
                  </button>
                ) : null}
              </div>
            ) : null}
            {state.notice ? <p className="banner">{state.notice}</p> : null}
            {state.modelFallback && online ? (
              <p className="banner" role="status">
                {t.modelFallback
                  .replace('{requested}', state.modelFallback.requested)
                  .replace('{used}', state.modelFallback.used)}
              </p>
            ) : online && !modelReady ? (
              <p className="banner" role="status">
                {t.modelUnavailable}
              </p>
            ) : null}
            <div className={`composer-card${state.decisions.length ? ' blocked' : ''}`} onPaste={pasteImages}>
              {state.voice?.error && state.voice.status === 'idle' ? (
                <p role="alert" className="image-error">
                  {state.voice.error}
                </p>
              ) : null}
              {imageError ? (
                <p role="alert" className="image-error">
                  {imageError}
                </p>
              ) : null}
              <Annotations
                state={state}
                t={t}
                post={post}
                cancelDictation={id => {
                  if (call.current?.annotationId === id || state.voice?.annotationId === id) {
                    endCall();
                    post({ type: 'voiceCancel', annotationId: id, threadId: state.threadId });
                  }
                }}
                dictate={id => {
                  if (state.voice?.status === 'recording' && state.voice.annotationId === id) {
                    post({ type: 'voiceStop' });
                  } else void startCall(id);
                }}
              />
              {state.activeEditor || state.contexts.length || state.selectedSkills?.length || state.images?.length ? (
                <ul
                  className={`contexts${state.selectedSkills?.length ? ' skill-contexts' : ''}`}
                  aria-label={t.context}
                >
                  {state.selectedSkills?.map(skill => (
                    <li key={skill.id} className="skill-context">
                      <span>${skill.name}</span>
                      <button
                        className="icon-button"
                        aria-label={`${t.remove} ${skill.name}`}
                        onClick={() => post({ type: 'removeSkill', id: skill.id })}
                      >
                        <Icon name="close" />
                      </button>
                    </li>
                  ))}
                  {state.activeEditor ? (
                    <li className="active-context" title={state.activeEditor.label}>
                      <Icon name="file" />
                      <span className="context-name">{state.activeEditor.path.split('/').at(-1)}</span>
                      <small>
                        {state.activeEditor.selected
                          ? `${state.activeEditor.startLine}-${state.activeEditor.endLine}`
                          : t.currentFile}
                      </small>
                      <button
                        className="icon-button"
                        aria-label={`${t.remove} ${state.activeEditor.label}`}
                        title={t.remove}
                        onClick={() => post({ type: 'removeContext', id: state.activeEditor!.id })}
                      >
                        <Icon name="close" />
                      </button>
                    </li>
                  ) : null}
                  {state.images?.map(image => (
                    <li key={image.id} title={image.name}>
                      {previews[image.id] ? (
                        <img className="image-thumb" src={previews[image.id]} alt="" />
                      ) : (
                        <Icon name="image" />
                      )}
                      <span className="context-name">{image.name}</span>
                      <button
                        className="icon-button"
                        aria-label={`${t.remove} ${image.name}`}
                        title={t.remove}
                        onClick={() => post({ type: 'removeImage', id: image.id })}
                      >
                        <Icon name="close" />
                      </button>
                    </li>
                  ))}
                  {state.contexts.map(c => (
                    <li key={c.id} title={c.label}>
                      <Icon name="file" />
                      <span className="context-name">{(c.path ?? c.label).split('/').at(-1)}</span>
                      <button
                        className="icon-button"
                        aria-label={`${t.remove} ${c.label}`}
                        title={t.remove}
                        onClick={() => post({ type: 'removeContext', id: c.id })}
                      >
                        <Icon name="close" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <FileInput
                draft={draft}
                threadId={state.threadId}
                disabled={Boolean(state.integrationBusy)}
                sendKey={state.sendKey}
                t={t}
                changeDraft={changeDraft}
                send={send}
                post={post}
                onBusy={setAttaching}
                recall={
                  // Strip the editor context this client appended when sending.
                  [...state.items]
                    .reverse()
                    .find(item => item.type === 'userMessage')
                    ?.text.split(/\n\n(?:--- Selected code: |\[Referenced file: )/)[0]
                }
                skills={state.integrations?.skills ?? []}
                commands={
                  online
                    ? ['new', 'history', 'skills', 'mcp', 'plan', 'chat', ...(state.threadId ? ['side', 'ps'] : [])]
                    : ['new', 'history', 'skills', 'mcp']
                }
                command={name => {
                  if (name === 'new') post({ type: 'newTab' });
                  if (name === 'history') {
                    if (online) post({ type: 'refresh' });
                    setHistory(true);
                  }
                  if (name === 'side') setPane('side');
                  if (name === 'ps') setPane('terminals');
                  if (name === 'skills' || name === 'mcp') openPane(name);
                  if (name === 'plan' || name === 'chat')
                    post({
                      type: 'configure',
                      model: state.model,
                      effort: state.effort,
                      mode: name === 'plan' ? 'plan' : 'default',
                    });
                }}
              />
              <div className="composer-bar">
                <Picker
                  className="add-picker"
                  buttonClassName="icon-button"
                  ariaLabel={t.add}
                  label=""
                  icon={<Icon name="plus" />}
                  disabled={running}
                  sections={[
                    {
                      title: t.add,
                      items: [
                        {
                          key: 'files',
                          label: t.addFiles,
                          detail: t.addFilesHelp,
                          onSelect: () => post({ type: 'attach' }),
                        },
                        {
                          key: 'images',
                          label: t.addImages,
                          detail: t.addImagesHelp,
                          onSelect: () => post({ type: 'attachImage' }),
                        },
                        ...(state.permission === 'agent' && online
                          ? [
                              {
                                key: 'plan',
                                label: t.planMode,
                                detail: state.mode === 'plan' ? t.planModeOff : t.planModeOn,
                                checked: state.mode === 'plan',
                                onSelect: () =>
                                  post({
                                    type: 'permissionMode',
                                    value:
                                      state.mode === 'plan'
                                        ? approvalPreset === 'custom'
                                          ? 'ask'
                                          : approvalPreset
                                        : 'plan',
                                  }),
                              },
                            ]
                          : []),
                        ...(state.threadId && state.writable && state.permission === 'agent'
                          ? [
                              {
                                key: 'goal',
                                label: t.goal,
                                detail: t.goalHelp,
                                onSelect: () => post({ type: 'setGoal' }),
                              },
                            ]
                          : []),
                      ],
                    },
                  ]}
                />
                <button
                  className="icon-button"
                  aria-label={t.mentionFile}
                  title={t.mentionFile}
                  disabled={Boolean(state.integrationBusy)}
                  onClick={() => insertDraft('@', true)}
                >
                  <Icon name="at" />
                </button>
                <span className="spacer" />
                {state.tokenUsage ? <ContextMeter key={state.threadId} usage={state.tokenUsage} t={t} /> : null}
                {running && state.permission === 'agent' && (draft.trim() || state.images?.length) ? (
                  <>
                    <button
                      className="text-button"
                      title={state.annotations?.length ? t.annotationWait : t.followupHelp}
                      disabled={state.integrationBusy || Boolean(state.annotations?.length)}
                      onClick={() =>
                        post({
                          type: 'followup',
                          text: (sent.current = draft),
                          threadId: state.threadId!,
                          delivery: 'steer',
                        })
                      }
                    >
                      {t.steer}
                    </button>
                    <button
                      className="text-button"
                      title={state.annotations?.length ? t.annotationWait : t.followupHelp}
                      disabled={state.integrationBusy || Boolean(state.annotations?.length)}
                      onClick={() =>
                        post({
                          type: 'followup',
                          text: (sent.current = draft),
                          threadId: state.threadId!,
                          delivery: 'queue',
                        })
                      }
                    >
                      {t.queue}
                    </button>
                  </>
                ) : null}
                {state.voice?.status && state.voice.status !== 'idle' ? (
                  <div className={`voice-pill ${state.voice.status}`} role="status" aria-live="polite">
                    {state.voice.status === 'recording' ? (
                      <span className="voice-dot" aria-hidden="true" />
                    ) : (
                      <Icon name="spinner" />
                    )}
                    <span className="voice-label">
                      {state.voice.status === 'recording'
                        ? `${Math.floor(voiceSeconds / 60)}:${String(voiceSeconds % 60).padStart(2, '0')}`
                        : state.voice.status === 'starting'
                          ? t.voice_starting
                          : t.voice_transcribing}
                    </span>
                    {state.voice.status === 'recording' ? (
                      <button
                        className="voice-done"
                        title={t.voiceStop}
                        onClick={() => {
                          post({ type: 'voiceStop' });
                        }}
                      >
                        {t.voiceDone}
                      </button>
                    ) : null}
                    {state.voice.status !== 'transcribing' ? (
                      <button
                        className="icon-button"
                        aria-label={t.cancel}
                        title={t.cancel}
                        onClick={() => {
                          endCall();
                          post({ type: 'voiceCancel' });
                        }}
                      >
                        <Icon name="close" />
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <button
                    className="icon-button"
                    aria-label={t.voiceStart}
                    title={t.voiceStart}
                    disabled={!online}
                    onClick={() => void startCall()}
                  >
                    <Icon name="mic" />
                  </button>
                )}
                {running && state.status !== 'connecting' ? (
                  <button
                    className="send-button"
                    aria-label={t.stop}
                    title={t.stop}
                    disabled={state.status === 'starting' || state.status === 'interrupting'}
                    onClick={() => post({ type: 'cancel' })}
                  >
                    <Icon name="stop" />
                  </button>
                ) : (
                  <button
                    className="send-button"
                    aria-label={t.send}
                    title={state.sendKey === 'enter' ? t.sendEnterHint : t.sendHint}
                    disabled={!canSend}
                    onClick={send}
                  >
                    <Icon name="send" />
                  </button>
                )}
              </div>
            </div>
            <div className="run-settings">
              {state.permission === 'agent' ? (
                <Picker
                  className="approval-picker"
                  ariaLabel={t.approvalTitle}
                  label={approvalLabels[approvalPreset]}
                  icon={<Icon name="shield" />}
                  disabled={running || !online || state.integrationBusy || Boolean(state.queued?.length)}
                  sections={[
                    {
                      title: t.approvalTitle,
                      items: (['review', 'ask', 'auto', 'full'] as const).map(value => ({
                        key: value,
                        label: approvalLabels[value],
                        detail: t[`approval_${value}_help`],
                        checked: approvalPreset === value,
                        warning: value === 'full',
                        onSelect: () => post({ type: 'permissionMode', value }),
                      })),
                    },
                  ]}
                />
              ) : (
                <select
                  className="pill"
                  aria-label={t.permissions}
                  title={t.boundary}
                  value={state.permission}
                  disabled={running || !online}
                  onChange={e => post({ type: 'permission', value: e.target.value as 'read-only' | 'reviewed' })}
                >
                  <option value="read-only">{t.readOnly}</option>
                  <option value="reviewed">{t.reviewEdits}</option>
                </select>
              )}
              {state.mode === 'plan' && state.permission === 'agent' ? (
                <button
                  className="pill plan-chip"
                  title={t.planExit}
                  disabled={running || state.integrationBusy}
                  onClick={() =>
                    post({ type: 'permissionMode', value: approvalPreset === 'custom' ? 'ask' : approvalPreset })
                  }
                >
                  {t.plan} ×
                </button>
              ) : null}
              <Picker
                className="model-picker"
                ariaLabel={t.model}
                label={
                  model
                    ? `${modelName(model.displayName || model.model)} · ${effortLabel(state.effort)}`
                    : state.model || t.model
                }
                disabled={running || state.integrationBusy || Boolean(state.queued?.length) || !state.models.length}
              >
                <ModelControls
                  modelLabel={t.selectModel}
                  effortLabel={t.effort}
                  models={state.models.map(m => ({
                    key: m.model,
                    label: modelName(m.displayName || m.model),
                    checked: m.model === state.model,
                    onSelect: () =>
                      post({
                        type: 'configure',
                        model: m.model,
                        effort: m.supportedReasoningEfforts.some(e => e.reasoningEffort === state.effort)
                          ? state.effort
                          : m.defaultReasoningEffort,
                        mode: state.mode,
                      }),
                  }))}
                  efforts={(model?.supportedReasoningEfforts ?? []).map(e => ({
                    key: e.reasoningEffort,
                    label: effortLabel(e.reasoningEffort),
                    checked: e.reasoningEffort === state.effort,
                    onSelect: () =>
                      post({ type: 'configure', model: state.model, effort: e.reasoningEffort, mode: state.mode }),
                  }))}
                />
              </Picker>
              {state.permission !== 'agent' ? (
                <select
                  className="pill mode-select"
                  aria-label={t.mode}
                  title={t.mode}
                  value={state.mode}
                  disabled={running || state.integrationBusy || Boolean(state.queued?.length) || !online}
                  onChange={e =>
                    post({
                      type: 'configure',
                      model: state.model,
                      effort: state.effort,
                      mode: e.target.value as ViewState['mode'],
                    })
                  }
                >
                  <option value="default">{t.default}</option>
                  <option value="plan">{t.plan}</option>
                </select>
              ) : null}
            </div>
            {state.enabledMcp?.length ? (
              <p className="external-tools">
                MCP: {state.enabledMcp.join(', ')} · {t.externalTools}
              </p>
            ) : null}
          </footer>
        </>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
