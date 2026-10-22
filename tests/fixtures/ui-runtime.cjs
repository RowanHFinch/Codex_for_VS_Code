// Test-only native transport adapter. Never packaged. No account or external model is used.
const { createServer } = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { dirname } = require('node:path');
const runtime = process.env.CODEX_FIXTURE_RUNTIME;
if (!runtime || !process.env.CODEX_HOME?.includes('ic-editor-'))
  throw Error('Isolated editor fixture environment required');
if (process.argv.includes('--version')) {
  const result = spawnSync(runtime, ['--version'], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const server = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw),
      output = body.input?.findLast(item => item.type === 'function_call_output');
    const tool = body.tools
      ?.flatMap(tool =>
        tool.type === 'namespace'
          ? tool.tools.map(t => ({ name: t.name, namespace: tool.name }))
          : [{ name: tool.name }],
      )
      .find(t => t.name?.includes('collect'));
    if (!tool) throw Error('Synthetic MCP tool missing');
    const item = output
      ? {
          id: 'message-fixture',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(output.output), annotations: [] }],
        }
      : { id: 'fc-fixture', type: 'function_call', call_id: 'call-fixture', ...tool, arguments: '{}' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    send('response.created', {
      response: { id: 'fixture', object: 'response', status: 'in_progress', model: body.model, output: [] },
    });
    send('response.output_item.added', { output_index: 0, item });
    send('response.output_item.done', { output_index: 0, item });
    send('response.completed', {
      response: {
        id: 'fixture',
        object: 'response',
        status: 'completed',
        model: body.model,
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    });
    response.end();
  } catch {
    response.writeHead(500);
    response.end('Isolated fixture failed');
  }
});
server.listen(0, '127.0.0.1', () => {
  const flags = [
    'model_provider="synthetic"',
    'model_providers.synthetic.name="Isolated UI fixture"',
    `model_providers.synthetic.base_url="http://127.0.0.1:${server.address().port}/v1"`,
    'model_providers.synthetic.wire_api="responses"',
    'model_providers.synthetic.requires_openai_auth=false',
    'model_providers.synthetic.supports_websockets=false',
    'cli_auth_credentials_store="file"',
    'features.hooks=false',
    'features.plugins=false',
    'features.apps=false',
    'features.memories=false',
    'features.multi_agent=false',
  ];
  const child = spawn(runtime, [...process.argv.slice(2), ...flags.flatMap(flag => ['-c', flag])], {
    env: { ...process.env, HOME: dirname(process.env.CODEX_HOME), USERPROFILE: dirname(process.env.CODEX_HOME) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const methods = new Map();
  const write = message => process.stdout.write(JSON.stringify(message) + '\n');
  createInterface({ input: process.stdin })
    .on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'account/read') {
        write({
          id: message.id,
          result: {
            account: { type: 'chatgpt', email: 'synthetic@example.test', planType: 'plus' },
            requiresOpenaiAuth: true,
          },
        });
        return;
      }
      if (message.method === 'account/rateLimits/read') {
        write({
          id: message.id,
          result: {
            rateLimits: {
              limitId: 'codex',
              limitName: 'Synthetic acceptance',
              primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1800000000 },
            },
          },
        });
        return;
      }
      if (message.id !== undefined && message.method) methods.set(message.id, message.method);
      if (message.method === 'thread/start') message.params.modelProvider = 'synthetic';
      child.stdin.write(JSON.stringify(message) + '\n');
    })
    .on('close', () => child.stdin.end());
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line),
      method = methods.get(message.id);
    if (message.result && method === 'model/list')
      message.result.data = [
        {
          ...message.result.data[0],
          id: 'gpt-5.3-codex',
          model: 'gpt-5.3-codex',
          displayName: 'Isolated synthetic model',
          isDefault: true,
          hidden: false,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Synthetic acceptance only' }],
        },
      ];
    if (!message.method) methods.delete(message.id);
    write(message);
  });
  child.stderr.resume();
  child.on('exit', code => {
    server.closeAllConnections();
    server.close();
    process.exit(code ?? 0);
  });
  process.on('SIGTERM', () => child.kill());
});
