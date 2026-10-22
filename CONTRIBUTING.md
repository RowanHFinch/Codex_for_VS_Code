# Contributing

Use Node.js 22+ and npm ci. Run npm run check before proposing a change.
npm run test:editor uses an isolated editor profile and no model request by
default. Live tests require explicit flags and consume quota; never run them in
routine CI or replay an unknown-outcome request.

Keep TypeScript, one React webview, esbuild and stable VS Code APIs. Regenerate
public protocol types with node scripts/sync-protocol.mjs using CLI 0.152.0;
do not hand-edit them. Preserve dependency and generated-code licenses.

Check affected callers, bridge and tests. Credentials, restoration and critical
concurrency changes need a focused independent read-only review. Preserve dirty
and manual edits. Never call a post-apply revert pre-apply rejection, or present
thread-history rollback as file restoration.

Update docs/feature-matrix.json and docs/release-readiness.md. Retain every reference ID and
distinguish partial implementation from accepted scenarios. Never publish vendor
bundles, raw byte-bearing audit artifacts, credentials or personal transcripts.

npm run release:local inspects a VSIX and checksum without publishing. Publishing
requires a chosen repository/publisher and explicit owner authorization. A local
workflow file is not evidence of a successful remote CI run.

## Performance checks

`npm run test:performance` uses isolated temporary storage, a real local app-server
and 25 synthetic loopback turns. It makes no paid inference request and reports
five samples (median/max) for connection, setup, empty chats and paginated history.
Use `CODEX_RUNTIME_PATH` to select a specific executable. Run before/after on the
same machine without competing editor tests. A local median is not a p95/SLA.

For current macOS/Linux navigation acceptance, use
`CODEX_EDITOR_UI=1 CODEX_UI_SIDEBAR=1 npm run test:editor` after building. It checks
real editor/host/renderer surfaces, independent drafts, history navigation, locale
and narrow layout; its timings include CDP discovery and polling overhead. The
secondary iframe uses DOM input events because Electron CDP text routing is
unreliable there. Editor-panel typing still uses native CDP insertion.
