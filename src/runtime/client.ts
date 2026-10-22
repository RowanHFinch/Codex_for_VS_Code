import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message?: string };
};
/** Sanitized detail for a definitive "no such thread" rejection, e.g. a chat that never got a message. */
export const THREAD_NOT_FOUND = 'Thread not found in this runtime.';
export class DeliveryError extends Error {
  constructor(
    public readonly delivery: 'not-sent' | 'unknown' | 'rejected',
    public readonly method: string,
    public readonly requestId: number,
    detail: string,
  ) {
    super(`${method} (#${requestId}): ${detail}`);
  }
}

// JSONL frames can split in the middle of a UTF-8 character.
export class JsonLines {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  constructor(
    private receive: (message: RpcMessage) => void,
    private maxBytes = 16 * 1024 * 1024,
  ) {}
  push(chunk: Buffer) {
    this.buffer += this.decoder.write(chunk);
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error('Runtime frame exceeds limit');
      const message: unknown = JSON.parse(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid runtime frame');
      const m = message as RpcMessage;
      if (m.id !== undefined && typeof m.id !== 'number' && typeof m.id !== 'string')
        throw new Error('Invalid RPC identity');
      if (m.method !== undefined && typeof m.method !== 'string') throw new Error('Invalid RPC method');
      if (m.method === undefined && m.id === undefined) throw new Error('Unaddressed runtime frame');
      this.receive(m);
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes) throw new Error('Runtime frame exceeds limit');
  }
}

/** Requests that read or rewrite a whole rollout; large histories take far longer than an ordinary call. */
const SLOW = new Set(['thread/resume', 'thread/fork', 'thread/search', 'thread/turns/list', 'thread/items/list']);
export class RuntimeClient extends EventEmitter {
  private nextId = 0;
  private closed = false;
  private pending = new Map<
    number,
    { method: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(
    private process: ChildProcessWithoutNullStreams,
    private timeoutMs = 30_000,
  ) {
    super();
    const frames = new JsonLines(m => this.receive(m));
    process.stdout.on('data', data => {
      try {
        frames.push(data);
      } catch {
        this.fail('Invalid runtime stream');
        this.stop();
      }
    });
    // Never forward stderr: upstream diagnostics can include personal config or tokens.
    process.stderr.resume();
    process.stdin.on('error', () => this.fail('Runtime input pipe failed; outcome unknown'));
    process.stdout.on('error', () => this.fail('Runtime output pipe failed; outcome unknown'));
    process.stderr.on('error', () => this.fail('Runtime diagnostic pipe failed; outcome unknown'));
    process.on('error', () => this.fail('Runtime process unavailable'));
    process.on('exit', () => this.fail('Runtime disconnected; reconcile history before sending again'));
  }
  static spawn(executable: string, args: string[], cwd: string) {
    // Native MCP env_vars and shell policies resolve against the editor's environment.
    return new RuntimeClient(
      spawn(executable, args, {
        cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      }),
    );
  }
  get connected() {
    return !this.closed && !this.process.killed;
  }
  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = ++this.nextId;
    if (!this.connected || !this.process.stdin.writable)
      return Promise.reject(new DeliveryError('not-sent', method, id, 'Runtime is offline'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new DeliveryError('unknown', method, id, 'Timed out; do not replay automatically'));
        },
        this.timeoutMs * (SLOW.has(method) ? 4 : 1),
      );
      this.pending.set(id, { method, resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) this.fail('Runtime write failed; outcome unknown');
      });
    });
  }
  notify(method: string, params?: unknown) {
    this.send({ method, params });
  }
  respond(id: string | number, result: unknown) {
    this.send({ id, result });
  }
  reject(id: string | number) {
    this.send({ id, error: { code: -32601, message: 'Unsupported by this client' } });
  }
  private send(message: RpcMessage) {
    if (!this.connected) throw new Error('Runtime offline');
    this.process.stdin.write(JSON.stringify(message) + '\n', error => {
      if (error) this.fail('Runtime write failed');
    });
  }
  private receive(message: RpcMessage) {
    if (message.method) {
      this.emit(message.id === undefined ? 'notification' : 'request', message);
      return;
    }
    const p = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!p) return;
    this.pending.delete(message.id as number);
    clearTimeout(p.timer);
    // Raw provider errors are not a safe logging or webview boundary.
    if (message.error) {
      const raw = message.error.message ?? '';
      const detail = /^thread [a-zA-Z0-9-]+ already has an active writer$/.test(raw)
        ? 'Thread has an active writer in another Codex client. Close it before resuming.'
        : /^thread not loaded: [a-zA-Z0-9-]+$/.test(raw)
          ? THREAD_NOT_FOUND
          : `Runtime rejected request (${message.error.code})`;
      p.reject(new DeliveryError('rejected', p.method, message.id as number, detail));
    } else p.resolve(message.result);
  }
  private fail(detail: string) {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new DeliveryError('unknown', p.method, id, detail));
    }
    this.pending.clear();
    this.emit('disconnect');
  }
  stop() {
    this.fail('Runtime stopped; reconcile history before sending again');
    this.process.stdin.destroy();
    this.process.kill();
    const timer = setTimeout(() => {
      if (this.process.exitCode === null) this.process.kill('SIGKILL');
    }, 2000);
    timer.unref();
  }
  async shutdown() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) {
      this.stop();
      return;
    }
    // Wait for the runtime itself to exit, not 'close': its background terminals and tool processes can keep
    // the inherited stdio pipes open for minutes, which made closing a tab look unresponsive.
    const exited = new Promise<void>(resolve => {
      this.process.once('exit', () => resolve());
      setTimeout(resolve, 3000).unref();
    });
    this.stop();
    await exited;
  }
}
