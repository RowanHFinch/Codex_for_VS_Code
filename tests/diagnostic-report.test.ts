import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticReport, redact } from '../src/diagnostic-report';

test('diagnostic reports redact credentials, identity and the home path', () => {
  const home = '/Users/someone';
  const text = redact(
    'key sk-abcdefghijklmnop Bearer abc.def-ghi user me@example.com at /Users/someone/.codex https://h.test/x?token=1 api_key=xyz eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
    home,
  );
  for (const secret of [
    'sk-abcdefghijklmnop',
    'abc.def-ghi',
    'me@example.com',
    '/Users/someone',
    'token=1',
    'xyz',
    'eyJhbGciOiJIUzI1NiJ9',
  ])
    assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes('~/.codex'));
  const windows = redact(
    JSON.stringify({ path: 'c:\\Users\\Name\\x', account_id: 'abc-123', note: 'rt_abcdefghijk' }),
    'C:\\Users\\Name',
  );
  assert.ok(!windows.includes('Name'), windows);
  assert.ok(!windows.includes('abc-123'), windows);
  assert.ok(!windows.includes('rt_abcdefghijk'), windows);
  const report = diagnosticReport({
    extensionVersion: '0.9.0',
    vscodeVersion: '1.142.0',
    platform: 'darwin',
    arch: 'arm64',
    tabs: [
      {
        status: 'idle',
        account: 'chatgpt',
        provider: 'openai',
        runtimeVersion: '0.152.0',
        owned: true,
        writable: true,
        diagnostics: { gauges: [] },
      },
    ],
    log: ['opened /Users/someone/project'],
    home,
  });
  assert.match(report, /not sent anywhere/);
  assert.match(report, /Runtime: 0\.152\.0/);
  assert.ok(!report.includes('/Users/someone'));
});
