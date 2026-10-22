# Codex for VS Code

An independent, open-source Codex client for VS Code. Use your local Codex CLI
and its existing sign-in to chat about code, review proposed edits, manage sessions
and work with editor context. The interface follows VS Code's language and theme,
with English and Simplified Chinese support.

This project is not affiliated with or endorsed by OpenAI. **0.9.0 is currently a
release candidate with the Preview flag retained until release acceptance is complete.**
See [release status](docs/release-readiness.md) for the verified scope and open checks.

## Features

- Chat in the right sidebar or an editor tab, with a separate Sessions & Usage
  panel in the Activity Bar. Keep independent drafts, tabs, groups and bookmarks.
- Stream responses and tool activity; select models and reasoning levels exposed
  by your runtime; queue, steer or interrupt a running turn.
- Review native proposed file changes in VS Code's diff editor before approval.
  Inspect changed files, undo eligible edits, or rewind a conversation and its
  recorded edits while preserving later manual changes.
- Attach the active editor selection, choose workspace files with `@`, paste images,
  inspect diagnostics, and add excerpts of an assistant response to your next message.
- Browse workspace history, rename/archive/fork chats, export messages and plans,
  inspect native child tasks, and view account limits and token usage.
- Discover Skills, configure MCP servers, answer supported MCP forms, and manage
  supported native Hooks, plugins and agent definitions.
- Browse local Codex memories without editing them. Dictation depends on runtime,
  account and microphone support.

Feature availability depends on your Codex runtime, provider and account. The
[feature ledger](docs/feature-matrix.json) preserves the complete roadmap; it is
not a claim that every reference feature is implemented.

## Requirements and setup

1. Install **VS Code 1.142.0 or newer** and the official **Codex CLI 0.152.0 or newer**.
2. Run `codex login` in a terminal. The extension reuses the CLI's existing sign-in;
   it does not create another account or provide a billing service. API-key usage
   follows your provider's billing policy.
3. Install the extension's VSIX using **Extensions: Install from VSIX…**. Public
   release availability is tracked in [release status](docs/release-readiness.md).
4. Open a trusted local folder, then choose **Codex for VS Code: Open Chat** from
   the Command Palette or click the extension's Activity Bar icon.

If Codex cannot be found, set `independentCodex.runtimePath` to your executable.
The CLI and editor must use the same OS user and `CODEX_HOME`. The Codex home and
workspace must be separate directories, with neither containing the other.
On macOS, automatic discovery can also select an installed desktop runtime;
an explicit runtime path takes precedence.

## Review and recovery

New chats default to **Ask before edits**. A native file-change approval opens
VS Code's diff editor; accept or reject the entire proposed change. **Edit
automatically** permits native edits according to Codex policy. **Plan mode**
uses the runtime's planning behavior. The setting
`independentCodex.initialPermissionMode` controls the default.

**Undo changes** and **Rewind to here** restore only eligible file edits with
known before/after contents and unchanged current text. Dirty buffers, later manual
edits, unsafe paths and unknown outcomes block restoration. Shell effects,
renames, binary files and edits without an exact pre-image are not recoverable.
Multi-file restoration is not crash-atomic. Keep normal version-control backups.

History opens without starting work; sending a message acquires the runtime's
writer. A chat active in another client may remain read-only until that client
releases it. Reconnection never automatically replays an unknown request.

## Shortcuts and settings

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Focus chat | `Cmd+Esc` | `Ctrl+Esc` |
| Open editor chat | `Cmd+Shift+Esc` | `Ctrl+Shift+Esc` |
| Attach selection | `Alt+K` | `Alt+K` |
| Accept focused proposed diff | `Cmd+Enter` | `Ctrl+Enter` |
| Reject focused proposed diff | `Cmd+Backspace` | `Ctrl+Backspace` |

Open **Settings → Extensions → Codex for VS Code** for runtime path, locale,
send key, initial permission mode, autosave and editor context preferences.
UI locale does not change model response or speech language.

## Boundaries

- Local desktop workspaces only; remote and virtual hosts are unsupported.
- The current package's macOS acceptance and remaining platform checks are listed
  in [release status](docs/release-readiness.md). A passing build is not an OS test.
- The runtime controls model access, tools and permissions. Trusted Hooks, plugins,
  MCP servers and shell commands can have effects outside file-edit review.
- Local Codex memory is separate from ChatGPT web memory. Advanced plugin/app auth,
  arbitrary MCP schemas, full reference parity and screen-reader acceptance remain
  incomplete. Microphone and external identity-provider behavior need real service testing.
- Runtime read-only mode is not a workspace-only read sandbox. Prompts and selected
  context are sent to the configured provider when you send a message.

Read [privacy](PRIVACY.md), [security](SECURITY.md) and
[runtime support](docs/runtime-support.md) before enabling external tools.

## Development

Use Node.js 22+:

```sh
npm ci
npm run check          # TypeScript, offline regressions, production bundles
npm run test:editor    # isolated VS Code extension-host tests
npm run release:local  # checks, VSIX, allowlist verification and SHA-256
```

The extension uses TypeScript, React and esbuild. Codex owns conversation history;
there is no separately hosted server or conversation database. Runtime binaries
are installed separately. See [contributing](CONTRIBUTING.md) for editor, runtime
and platform checks, and [architecture](docs/development-plan.md) for the code map.

## Support and license

Report reproducible bugs through [GitHub Issues](https://github.com/RowanHFinch/Codex_for_VS_Code/issues).
Do not include credentials or private conversations. See [SECURITY.md](SECURITY.md)
for reporting sensitive issues. Original code is MIT licensed; generated protocol
types and bundled dependencies retain their [third-party licenses](THIRD_PARTY_NOTICES.md).
