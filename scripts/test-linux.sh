#!/usr/bin/env bash
set -euo pipefail
npm run release:local
export CODEX_TEST_VSIX=dist/codex-for-vscode-0.9.0.vsix
npm run test:oauth
npm run test:elicitation
npm run test:agents
npm run test:integrations
npm run test:foundation
xvfb-run -a npm run test:editor
CODEX_EDITOR_UI=1 CODEX_UI_SIDEBAR=1 xvfb-run -a npm run test:editor

CODEX_EDITOR_UI=1 CODEX_UI_MCP=1 xvfb-run -a npm run test:editor
