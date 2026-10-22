import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';
await Promise.all([
  build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // PvRecorder loads its native library relative to its own files, so it ships unbundled.
    external: ['vscode', '@picovoice/pvrecorder-node'],
    outfile: 'dist/extension.js',
  }),
  build({
    entryPoints: ['webview/index.tsx'],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    minify: true,
    outfile: 'dist/webview.js',
  }),
]);
const recorder = 'node_modules/@picovoice/pvrecorder-node';
rmSync(`dist/${recorder}`, { recursive: true, force: true });
for (const part of ['package.json', 'dist', 'lib/mac', 'lib/linux', 'lib/windows'])
  cpSync(`${recorder}/${part}`, `dist/${recorder}/${part}`, { recursive: true });
await import('./licenses.mjs');
