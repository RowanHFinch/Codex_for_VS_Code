# Privacy

The extension runs locally and starts the user's separately installed Codex CLI
over stdio. It does not run an independently hosted server or send extension
telemetry. The CLI and ChatGPT service have their own privacy and usage settings.
Prompts, attached text and runtime-selected context are sent to the model provider
to answer the request. Runtime read-only mode does not isolate reads to the
workspace; local tools can read other files allowed by the operating system.

Voice input sends microphone audio to OpenAI's realtime service only while recording, through
a call the local runtime opens; the transcript goes into the draft and is not sent until you send
it. The extension never reads or copies the CLI's authentication file or another
application's tokens. The runtime handles its own credentials. No credential,
account email or full configuration is sent to the webview. The extension never
signs in or switches accounts; whichever ChatGPT or API-key sign-in the CLI has
is used, and API-key usage is billed by OpenAI according to that key.

Conversation history belongs to Codex. VS Code workspace storage contains thread
provenance, conversation tabs, last selected tab, per-chat drafts, groups,
bookmarks, per-chat model/reasoning/permission choices and MCP configuration
fingerprint grants. Extension global
storage contains private text checkpoints and native edit undo records. Each
checkpoint stores before/approved-after content, workspace and thread/turn/tool
identities, timestamp and prepared/applied/restored state. Checkpoints are plain
local JSON with restrictive creation permissions; they are not encrypted. They
are not automatically uploaded or silently expired.

Reviewed-text edits use VS Code's document API and undo stack. Native Agent commands/file tools use Codex permissions. Eligible native file-change
items have separate before/after records (up to 1 MiB per file); shell changes,
renames, binaries and changes without an exact pre-image are not covered. Saving follows the user's
explicit save action or existing editor autosave setting. Reviewed checkpoint restoration changes editor buffers. Native Undo changes and
Rewind write recorded text to disk after checking content, path and live dirty
buffers; failed multi-file restoration attempts rollback and reports conflicts. Deleting local
checkpoint storage removes this extension's recovery ability; it does not remove
runtime history.

The packaged renderer uses a restrictive Content Security Policy, blocks remote
images, skips raw HTML in Markdown, and only opens validated HTTP(S) links after
a user click. Logs stay in a local output channel. No automatic bug upload,
microphone recording or cross-client synchronization is implemented.

## Automatic editor context

Focusing a workspace code file does not send it to a provider. The host prepares
an eligible current-file/single-selection snapshot locally; only its path/range
metadata is added to the webview until you explicitly send a chat message. The
visible chip can be removed, and stale context identities block delivery. Pinned
manual context wins for the same file; removing it suppresses hidden automatic
context until a subsequent editor/selection change. Known credential filenames
and private metadata directories are excluded, including canonical aliases.
These rules are not a secret scanner for arbitrary source text or a read-root
sandbox for runtime tools. Save/discard dirty workspace buffers before sending.

Inline file search stays local. The host returns at most 20 relative paths and
opaque, per-webview choice IDs from a bounded workspace scan. Search does not read
file bodies. Choosing an entry revalidates the path and reads its eligible text;
only an explicit message Send submits attached context to the runtime. Invalid,
stale, other-view or replaced-path choices are refused. The draft is kept when
attachment fails or the chat/draft changes before acknowledgement.

## Skills and MCP

Skill names, bounded descriptions and scope/enabled state are shown in the
webview. Original instruction paths stay in the extension host; choosing a skill
explicitly sends its runtime skill input with the next request. Opening an
instruction document does not itself send it to a provider.

MCP configuration and OAuth URLs remain in the host/runtime. The renderer only
receives server names, transport/scope/status and bounded tool-name lists, never
commands, environment values, headers or tokens. User configuration edits affect
other clients using that Codex home; additions are disabled and unknown fields
are preserved. Workspace grants are configuration hashes, not access tokens.
MCP tools have their own external effects and are outside local text-edit review.
A native confirmation explains this boundary before enablement. No unscoped
status query is used, because the supported runtime starts its global MCP manager
for such queries. Configuration connections never start threads or tool managers.

The runtime home must not overlap the workspace. Native configuration documents
may be opened for editing, but cannot become automatic workspace context through
a supported overlapping runtime home. Dirty configuration aliases block panel
writes; requests with an unknown outcome are not automatically retried.

## Native Agent and ecosystem

The local runtime inherits the editor process environment so native shell
policies and declared MCP environment credentials can resolve normally. This
object is not serialized into RPC, logs or renderer state. Codex controls what
its tools inherit. Its native account and provider configuration decide whether a
turn is authorized.

Normal Agent chats inherit native tools, trusted Hooks, enabled plugins, custom
agent definitions and native memory configuration. These may run commands or
access external services under the selected Codex policy. Reviewed chats instead
disable Hooks/Plugins and inherited shell environment. Plan mode limits tools;
it does not undo configured lifecycle hooks in a native Agent session.

The ecosystem renderer receives names, state and opaque identifiers, not Hook
commands, full definitions, auth files or memory contents. Native Hook trust
confirmation deliberately shows the exact source/command/hash. Approval cards
show complete bounded runtime request details, including requested roots/network
access; if truncated, accepting is disabled. Normal command output or source
text can contain sensitive data, so these boundaries are not a general secret
scanner. No external bug report is submitted automatically.

Plugin install/enable/removal and Hook/feature controls change shared Codex user
configuration. Native plugin components have their own trust/enablement path;
the root MCP fingerprint gate is not a blanket guarantee for plugin components.
Agent files are created only with exclusive creation in the workspace's real
`.codex/agents` directory; existing files are never overwritten by that action.
Local memory controls call the native thread setter. No personal memories are
indexed/copied, and no ChatGPT web-memory synchronization is implemented.

Text follow-ups use native durable queues or steering. History opens passively;
sending a message explicitly resumes the selected chat; existing queued work must be reconciled first. Unknown writes disconnect
and are never automatically resent. Closing the owning chat stops its runtime
before releasing native writer ownership; unsubscribe alone does not prove writer release.

## Local memory and OAuth

The memory browser enumerates only Markdown metadata under the native Codex home
memory stores after the user opens Memories. A file's bounded UTF-8 text enters
webview memory only when selected, with no persistence in VS Code storage or
automatic prompt attachment. Leaving the pane clears its content. The browser
is read-only and rejects linked files/directories and hard links.

OAuth URLs remain in the host and are passed only to the user's browser. Native
Codex stores/refreshes credentials under its configured credential policy. The
renderer receives only flow kind, server name and a bounded status. Raw OAuth
errors, authorization URLs, state values and tokens are not logged or projected.
Child transcripts are fetched from native APIs and are not a separate database.

Local CLI sign-in is displayed through native account APIs. Authentication failures
ask the user to run `codex login`; the extension starts no account login flow.

## MCP forms, usage and explicit exports

MCP form answers exist only in component/host memory until explicit submission to
that server. They are not saved to presentation state or logs. Decline/cancel
responses have null content. Use the native browser OAuth flow for secrets; form
inputs are intended for non-secret tool parameters. Unsupported constraints fail
closed instead of silently accepting a looser schema.

Usage reads expose bounded limit windows and token counters, excluding account
identifiers, credit balances and backend banners. Token counts are not billing
estimates. Export explicitly sends the current native chat's messages/plans to the
local clipboard or an unsaved editor document; no upload or file overwrite occurs.
The export can contain the code and context that were originally sent in the chat.

## Local performance diagnostics

Connection timing and runtime version are written to the existing local Output
channel. No prompts, paths or account identifiers are added to these timing lines.
No performance telemetry is uploaded. Hidden views receive fresh state when
revealed; the Sessions sidebar is not sent conversation bodies.
