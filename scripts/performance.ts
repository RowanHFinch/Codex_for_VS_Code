/** Native runtime benchmark with isolated storage and synthetic loopback responses; no paid inference. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/runtime/compatibility';
import { Coordinator } from '../src/sessions/coordinator';
import { Integrations } from '../src/integrations';

async function main() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-performance-')));
  const previousHome = process.env.CODEX_HOME;
  const samples: Record<string, number>[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Drain the native request without retaining prompts. */
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const id = randomUUID();
    const item = {
      id: randomUUID(),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: 'Synthetic benchmark paragraph with **Markdown** and `code`.\n\n'.repeat(80),
          annotations: [],
        },
      ],
    };
    const send = (type: string, value: unknown) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(value as object) })}\n\n`);
    send('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
    send('response.output_item.added', { output_index: 0, item });
    send('response.output_item.done', { output_index: 0, item });
    send('response.completed', {
      response: {
        id,
        object: 'response',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let history: string | undefined;
  try {
    const cwd = join(root, 'workspace'),
      home = join(root, 'home');
    await Promise.all([mkdir(cwd), mkdir(home)]);
    process.env.CODEX_HOME = home;
    await writeFile(
      join(home, 'config.toml'),
      `model="gpt-5.3-codex"
model_provider="synthetic"
cli_auth_credentials_store="file"
[model_providers.synthetic]
name="Local benchmark"
base_url="http://127.0.0.1:${(server.address() as { port: number }).port}/v1"
wire_api="responses"
requires_openai_auth=false
supports_websockets=false
[features]
hooks=false
plugins=false
apps=false
memories=false
multi_agent=false
`,
    );
    for (let run = 0; run < 5; run++) {
      const sample: Record<string, number> = {};
      const timed = async <T>(name: string, work: () => Promise<T>) => {
        const start = performance.now();
        const result = await work();
        sample[name] = Math.round((performance.now() - start) * 10) / 10;
        return result;
      };
      const runtime = await timed('connect', () => connect(process.env.CODEX_RUNTIME_PATH || 'codex', cwd));
      const data = new Map<string, unknown>();
      const c = new Coordinator(
        cwd,
        {
          get: (key, fallback) => (data.get(key) ?? fallback) as any,
          update: async (key, value) => {
            data.set(key, value);
          },
        },
        () => {},
        async () => {},
        () => {},
      );
      try {
        await timed('attach', () => c.attach(runtime.client, runtime.version, runtime.settings));
        const integrations = new Integrations(
          c,
          cwd,
          home,
          () => ({}),
          () => {},
          () => {},
        );
        await timed('integrations', () => integrations.refresh());
        await timed('newThread', () => c.newThread());
        const id = c.state.threadId!;
        assert.ok(id);
        await timed('readEmptyThread', () =>
          runtime.client.request('thread/read', { threadId: id, includeTurns: false }),
        );
        assert.ok(c.state.status === 'idle');
        if (!history) {
          for (let turn = 0; turn < 25; turn++) {
            await c.send(`Synthetic history turn ${turn}`);
            const deadline = Date.now() + 15000;
            while (String(c.state.status) !== 'completed' && Date.now() < deadline) {
              if (String(c.state.status) === 'failed') throw new Error('Synthetic turn failed: ' + c.state.error);
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(c.state.status, 'completed');
          }
          history = c.state.threadId;
        }
        await timed('openHistory', () => c.openThread(history!));
        assert.ok([10, 40].includes(c.state.items.length));
        assert.equal(c.state.writable, false);
        await timed('olderHistory', () => c.loadHistory());
        assert.equal(c.state.items.length, 50);
        samples.push(sample);
        console.log(JSON.stringify({ run: run + 1, runtime: runtime.version, ms: sample }));
      } finally {
        await c.dispose();
      }
    }
    const summary = Object.fromEntries(
      Object.keys(samples[0]).map(key => {
        const values = samples.map(s => s[key]).sort((a, b) => a - b);
        return [key, { medianMs: values[2], maxMs: values[4] }];
      }),
    );
    console.log(
      JSON.stringify({
        scope: 'isolated native runtime; 25 persisted turns, synthetic loopback model; no paid inference',
        platform: process.platform,
        arch: process.arch,
        summary,
      }),
    );
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
