import { mcpFingerprint } from '../integrations';
import type { RuntimeClient, RpcMessage } from './client';
import type { AuthState } from '../shared';

export function authorizationUrl(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Unsupported authorization URL.');
  return url.toString();
}

export class NativeAuth {
  state?: AuthState;
  private usedMcp = new Set<string>();
  private pending?: {
    name: string;
    threadId: string | null;
    fingerprint?: string;
    timer?: NodeJS.Timeout;
  };
  constructor(
    private client: RuntimeClient,
    private changed: () => void,
    private seconds = 90,
  ) {
    client.on('notification', this.notification);
    client.on('disconnect', this.disconnected);
  }
  private disconnected = () => {
    if (this.pending) this.finish('unknown');
  };
  private finish(status: AuthState['status']) {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = undefined;
    if (this.state) this.state = { ...this.state, status };
    this.changed();
  }
  private notification = (message: RpcMessage) => {
    const pending = this.pending,
      p = message.params as any;
    if (!pending || !p) return;
    if (
      message.method === 'mcpServer/oauthLogin/completed' &&
      p.name === pending.name &&
      (p.threadId ?? null) === pending.threadId
    ) {
      if (!p.success) {
        this.finish('failed');
        return;
      }
      void Promise.all([
        this.client.request<any>('mcpServerStatus/list', {
          threadId: pending.threadId,
          limit: 100,
          detail: 'toolsAndAuthOnly',
        }),
        this.client.request<any>('config/read', { includeLayers: false }),
      ]).then(
        ([result, config]) => {
          if (this.pending === pending)
            this.finish(
              mcpFingerprint(config.config?.mcp_servers?.[pending.name!] ?? {}) === pending.fingerprint &&
                result.data?.some((server: any) => server.name === pending.name && server.authStatus === 'oAuth')
                ? 'success'
                : 'unknown',
            );
        },
        () => {
          if (this.pending === pending) this.finish('unknown');
        },
      );
    }
  };
  private start(name: string, threadId: string | null) {
    if (this.pending || this.state?.status === 'unknown')
      throw new Error('Finish sign-in or reconnect before starting another flow.');
    const pending = {
      name,
      threadId,
      timer: undefined as NodeJS.Timeout | undefined,
      fingerprint: undefined as string | undefined,
    };
    this.pending = pending;
    this.state = { kind: 'mcp', name, status: 'pending' };
    this.changed();
    return pending;
  }
  async oauth(name: string, threadId: string | null, fingerprint: string) {
    if (this.usedMcp.has(name)) throw new Error('Reconnect before starting another sign-in for this server.');
    const pending = this.start(name, threadId);
    this.usedMcp.add(name);
    try {
      const config = await this.client.request<any>('config/read', { includeLayers: false });
      if (
        this.pending !== pending ||
        !config.config?.mcp_servers?.[name] ||
        config.config.mcp_servers[name].enabled === false
      )
        throw new Error('MCP configuration changed or is disabled.');
      pending.fingerprint = mcpFingerprint(config.config.mcp_servers[name]);
      if (pending.fingerprint !== fingerprint) throw new Error('MCP configuration changed after trust.');
      const result = await this.client.request<{ authorizationUrl: string }>('mcpServer/oauth/login', {
        name,
        threadId,
        timeoutSecs: this.seconds,
      });
      const url = authorizationUrl(result.authorizationUrl);
      if (this.pending === pending)
        pending.timer = setTimeout(
          () => {
            if (this.pending === pending) this.finish('unknown');
          },
          (this.seconds + 5) * 1000,
        );
      return url;
    } catch {
      if (this.pending === pending) this.finish('unknown');
      throw new Error('Could not start native MCP sign-in. Reconnect before trying again.');
    }
  }
  dispose() {
    this.client.off('notification', this.notification);
    this.client.off('disconnect', this.disconnected);
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = undefined;
  }
}
