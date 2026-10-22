const readline = require('node:readline');
const { closeSync, writeSync } = require('node:fs');
const pending = [];
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  const reply = result => process.stdout.write(JSON.stringify({ id: m.id, result }) + '\n');
  switch (m.method) {
    case 'echo':
      reply(m.params);
      break;
    case 'syntheticEnv':
      reply({ inherited: process.env.CODEX_VSCODE_SYNTHETIC_ENV === 'fixture-only' });
      break;
    case 'reverse':
      pending.push(m);
      if (pending.length === 2)
        for (const p of pending.reverse()) process.stdout.write(JSON.stringify({ id: p.id, result: p.params }) + '\n');
      break;
    case 'error':
      process.stdout.write(
        JSON.stringify({ id: m.id, error: { code: 401, message: 'private-token-must-not-leak' } }) + '\n',
      );
      break;
    case 'request':
      process.stdout.write(
        JSON.stringify({ id: 'server-1', method: 'item/test', params: { threadId: 'other' } }) + '\n',
      );
      reply({});
      break;
    case 'exit':
      process.exit(7);
      break;
    case 'closeOutput':
      // Windows stdout uses a SyncWriteStream with autoClose disabled.
      closeSync(1);
      break;
    case 'replyAndClose':
      writeSync(1, JSON.stringify({ id: m.id, result: m.params }) + '\n');
      closeSync(1);
      break;
    case 'malformed':
      process.stdout.write('not JSON\n');
      break;
    case 'hang':
      break;
  }
});
