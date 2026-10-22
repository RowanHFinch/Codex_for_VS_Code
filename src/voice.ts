import { RuntimeClient } from './runtime/client';
import { runtimeExecutable } from './runtime/executable';

const timeout = (message: string, ms = 15_000) =>
  new Promise<string>(resolve => setTimeout(() => resolve(message), ms).unref());

/**
 * Dictation through the runtime's realtime API over WebRTC, the transport the official clients use and the
 * one that works with a ChatGPT sign-in (the WebSocket transport needs an API key). The webview captures
 * the microphone and owns the peer connection; this host side only relays the SDP through the runtime and
 * keeps the user's transcript. It runs in its own short-lived runtime with `realtime_conversation`
 * enabled for that process only, on an ephemeral read-only thread with client-managed handoffs, so
 * speaking can never start work in a chat. Nothing is sent until the user sends the draft.
 */
export class Dictation {
  private client?: RuntimeClient;
  private threadId?: string;
  private transcript = '';
  error?: string;
  constructor(
    private executable: string,
    private cwd: string,
  ) {}
  /** Starts the realtime call for the webview's SDP offer and returns the answer. */
  async start(offer: string) {
    try {
      return await this.open(offer);
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }
  private async open(offer: string) {
    const client = (this.client = RuntimeClient.spawn(
      runtimeExecutable(this.executable),
      ['-c', 'features.realtime_conversation=true', 'app-server', '--listen', 'stdio://'],
      this.cwd,
    ));
    let answer: (result: { sdp?: string; error?: string }) => void = () => {};
    const answered = new Promise<{ sdp?: string; error?: string }>(resolve => (answer = resolve));
    client.on('notification', message => {
      const p = message.params as { threadId?: string; role?: string; delta?: string; sdp?: string; message?: string };
      if (!p || p.threadId !== this.threadId) return;
      if (message.method === 'thread/realtime/sdp' && p.sdp) answer({ sdp: p.sdp });
      if (message.method === 'thread/realtime/transcript/delta' && p.role === 'user' && p.delta)
        this.transcript += p.delta;
      if (message.method === 'thread/realtime/error') answer({ error: (this.error = p.message) });
    });
    await client.request('initialize', {
      clientInfo: { name: 'independent_codex_vscode_dictation', title: 'Codex for VS Code', version: '0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');
    const thread = await client.request<{ thread: { id: string } }>('thread/start', {
      cwd: this.cwd,
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    this.threadId = thread.thread.id;
    // WebRTC calls need realtime v1 or v3 and text output needs v2, so the call uses audio output; the
    // webview never plays the reply and only the user's transcript is kept (verified on 0.152.0).
    await client.request('thread/realtime/start', {
      threadId: this.threadId,
      outputModality: 'audio',
      version: 'v3',
      clientManagedHandoffs: true,
      prompt: 'You only transcribe the user. Never answer, act or hand off.',
      transport: { type: 'webrtc', sdp: offer },
    });
    const result = await Promise.race([
      answered,
      timeout('Realtime session did not start.').then(error => ({ error }) as { sdp?: string; error?: string }),
    ]);
    if (!result.sdp) throw new Error(result.error ?? 'Realtime session did not start.');
    return result.sdp;
  }
  /** Ends the call after the webview stopped sending audio and returns the user's transcript. */
  async stop(settleMs = 1500) {
    // Keep WebRTC alive for queued audio and VAD's final words; one quiet sample can precede the final delta.
    let last = this.transcript;
    for (let waited = 0; waited < 6000; waited += settleMs) {
      await new Promise(r => setTimeout(r, settleMs));
      if (waited >= settleMs && this.transcript === last) break;
      last = this.transcript;
    }
    await this.dispose();
    if (!this.transcript && this.error) throw new Error(this.error);
    return this.transcript.trim();
  }
  async dispose() {
    const client = this.client;
    this.client = undefined;
    if (client && this.threadId)
      await client.request('thread/realtime/stop', { threadId: this.threadId }).catch(() => {});
    await client?.shutdown();
  }
}

/**
 * Microphone capture in the extension host. VS Code never grants `media` to webviews, so like the official
 * Codex Audio extension this uses PvRecorder (16 kHz, 16-bit mono) and hands frames to the webview call.
 */
export class Microphone {
  private recorder?: { start(): void; stop(): void; release(): void; read(): Promise<Int16Array>; sampleRate: number };
  private loop?: Promise<void>;
  private running = false;
  async start(onFrame: (pcm: Int16Array, sampleRate: number) => void) {
    try {
      const { PvRecorder } = await import('@picovoice/pvrecorder-node');
      this.recorder = new PvRecorder(512);
      this.recorder.start();
    } catch (error) {
      this.release();
      throw new Error(
        `Microphone unavailable (${error instanceof Error ? error.message : String(error)}). Allow VS Code to use the microphone (macOS: System Settings › Privacy & Security › Microphone).`,
      );
    }
    const recorder = this.recorder;
    this.running = true;
    this.loop = (async () => {
      try {
        while (this.running) onFrame(await recorder.read(), recorder.sampleRate);
      } catch {
        /* stop() ends a pending read */
      } finally {
        // The native handle is freed only after the read loop has left it.
        try {
          recorder.release();
        } catch {}
      }
    })();
  }
  release() {
    this.running = false;
    const recorder = this.recorder;
    this.recorder = undefined;
    try {
      recorder?.stop();
    } catch {}
    if (recorder && !this.loop)
      try {
        recorder.release();
      } catch {}
  }
}
