# Runtime support

Requires **VS Code 1.142.0+** and **Codex CLI 0.152.0+**. A minimum-version check
is not a guarantee that every newer alpha or future protocol is compatible.
Codex 0.160.0 or newer is recommended: earlier runtimes can stall for about 30
seconds while first creating their SQLite state, before answering `initialize`.
Current release evidence is in [release-readiness.md](release-readiness.md).

## Host and runtime

Only trusted local desktop workspaces are supported. Remote and virtual hosts
are refused. In a multi-root workspace, the extension selects one folder.
The native runtime communicates over stdio, with an independent client identity.
Experimental protocol negotiation enables selected features; core VS Code APIs
are stable and do not require proposed APIs.

An explicit `independentCodex.runtimePath` wins. With the default setting, macOS
discovery checks PATH and installed desktop runtimes and selects the newest
numeric version. Other platforms use their installed CLI. Runtime binaries are
not bundled in the extension.

## Sign-in and providers

The extension reuses native CLI sign-in and provider configuration. Account reads
only display ChatGPT, API-key or signed-out state; the runtime decides whether a
turn is authorized. Run `codex login` for authentication failures. The extension
does not read `auth.json`, export tokens or implement a separate account login.
Custom providers retain their own privacy, entitlement and billing behavior.

The runtime inherits the editor environment so native shell and MCP configuration
can resolve normally. That environment is not sent to the webview. The isolated
reviewed-text workflow disables inherited shell environment and native Hooks/plugins.
Codex home must not overlap the workspace.

## Ownership and recovery

History opens passively. Sending explicitly resumes the chat and claims its
native writer; another client's active writer can refuse the request. Native
cross-process exclusion was observed between CLI 0.152.0 and selected official
IDE/desktop runtime versions. Future versions remain subject to verification.
Closing the owning chat stops its runtime and releases ownership; unsubscribe
alone does not prove release. Unknown requests are never automatically replayed.

Native file-change review is a decision for the whole pending item, not arbitrary
hunk acceptance. Eligible native undo records preserve exact text; shell effects,
renames, binary changes and missing pre-images are outside recovery. Restoration
rechecks paths, current content and dirty editor buffers. It attempts rollback
on partial failure and reports conflicts; it is not a cross-process transaction.

## Ecosystem

Skills, MCP, Hooks, plugins, native agent files and local memory depend on runtime
capabilities. Shared configuration changes use version/readback checks and refuse
active or unknown work. MCP grants bind the workspace to configuration fingerprints;
plugin components also depend on native plugin trust. MCP tool execution can have
external effects outside edit review.

Supported MCP forms validate bounded primitive fields. Unsupported schemas remain
decline/cancel only. OAuth is delegated to the runtime; external provider completion
is not certified by synthetic loopback tests. Local memory browsing is read-only
and separate from ChatGPT web memory. Dictation requires microphone permission,
runtime realtime support and account entitlement.

See the [public Codex repository](https://github.com/openai/codex) for the runtime
and protocol source. The extension's source and generated types have separate
licensing notices in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
