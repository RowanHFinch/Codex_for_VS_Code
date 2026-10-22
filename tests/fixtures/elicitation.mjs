import { createInterface } from 'node:readline';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
let pending;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === 'form-request' && !request.method) {
    const result = request.result;
    if (
      result?.action === 'accept' &&
      (result.content?.count !== 0 || result.content?.confirmed !== false || result.content?.label !== 'SYNTHETIC_FORM')
    )
      throw new Error('Native form response changed types or content');
    send({
      id: pending,
      result: { content: [{ type: 'text', text: 'SYNTHETIC_FORM_' + result.action.toUpperCase() }] },
    });
    continue;
  }
  if (request.id === undefined) continue;
  if (request.method === 'tools/call') {
    pending = request.id;
    send({
      id: 'form-request',
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: 'Synthetic MCP input request',
        requestedSchema: {
          type: 'object',
          properties: {
            label: { type: 'string', minLength: 1, title: 'Label' },
            count: { type: 'integer', minimum: 0, maximum: 3 },
            confirmed: { type: 'boolean' },
          },
          required: ['label', 'count', 'confirmed'],
        },
      },
    });
    continue;
  }
  const result =
    request.method === 'initialize'
      ? {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'elicitation-fixture', version: '1' },
        }
      : request.method === 'tools/list'
        ? {
            tools: [
              {
                name: 'collect',
                description: 'Collect synthetic form values',
                inputSchema: { type: 'object', properties: {} },
                annotations: { readOnlyHint: true },
              },
            ],
          }
        : request.method === 'resources/list'
          ? { resources: [] }
          : request.method === 'resources/templates/list'
            ? { resourceTemplates: [] }
            : {};
  send({ id: request.id, result });
}
