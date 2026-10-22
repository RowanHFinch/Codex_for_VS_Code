import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = process.argv[2];
appendFileSync(log, 'started\n');
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize')
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'isolated-fixture', version: '1.0.0' },
    };
  else if (request.method === 'tools/list')
    result = {
      tools: [
        {
          name: 'echo',
          description: 'Return synthetic fixture text',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          annotations: { readOnlyHint: true },
        },
      ],
    };
  else if (request.method === 'tools/call') {
    appendFileSync(log, 'called\n');
    result = { content: [{ type: 'text', text: String(request.params.arguments.text) }] };
  } else if (request.method === 'resources/list') result = { resources: [] };
  else if (request.method === 'resources/templates/list') result = { resourceTemplates: [] };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
