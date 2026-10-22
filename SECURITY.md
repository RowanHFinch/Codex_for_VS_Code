# Security boundaries

This preview has been exercised on macOS ARM64 and isolated Linux ARM64, VS Code 1.142.0 and official
Codex CLI 0.152.0. The compatibility gate accepts 0.152.0 or newer; this does not
certify every future runtime. The 2026-10-22 performance suite also exercises
0.163.0-alpha.11. A trusted local filesystem is required. Multi-root windows
select one canonical folder per host; projectless chats use a generated local
folder. Remote hosts remain unsupported. See docs/release-readiness.md for platform gates.

Normal Agent chats use the selected native permission profile, approval policy
and reviewer. Empty native configuration keeps the runtime read-only default.
Full access requires native confirmation. Command/file/permission approvals are
bound to unique connection/thread/turn/request snapshots; duplicate pending RPC
IDs disconnect without granting. Safety-relevant details include requested roots,
network destinations and grant duration. Truncated details cannot be accepted.

Reviewed chats use a separate read-only/never workflow with Hooks/Plugins and
inherited shell environment disabled. The reviewed-edit tool requires selected
replacements, matching thread/turn/tool identity, source text/editor version and
a durable before-state record. Plan/read-only modes cannot authorize that tool.
Links, credential-like, binary, non-UTF-8 and out-of-workspace proposals are refused.
Native Agent file-change items have separate bounded undo records where exact
pre/post text can be established; shell effects and external services are not covered.

Trusted native Hooks, enabled plugins and granted MCP servers may run commands
or affect external services. Shared configuration uses CAS/readback and final
activity/dirty-state checks after native dialogs and control connection startup.
Native runtime environment inheritance is not exposed as a renderer API. The
client follows the native CLI's provider and authorization. Account classification
is informational, not proof of entitlement. Custom providers and API-key sign-in
retain their own billing and privacy policies. Credentials remain with the runtime.

Reviewed checkpoints use editor buffers; native undo writes files through checked
paths and temporary files. Neither is an OS-level filesystem compare-and-swap.
Do not concurrently replace/rename workspace paths or save the same file from
another window/client during review or restoration. Later text changes, linked ancestors, credential-like paths and unsaved buffers
block restoration. Native undo rechecks before each write and rollback; failures
that cannot be rolled back are reported explicitly. Multi-file crash atomicity
and malicious same-user path replacement are not guaranteed. On Windows, checkpoint
files are flushed, but Node cannot flush directory entries; recovery after power
loss or an OS crash is not guaranteed. A cancellation racing with an already approved editor operation may
leave the approved change applied; inspect the editor and prepared checkpoint.
Do not blindly repeat unknown requests.

Runtime writer refusal was exercised with two app-servers and the official CLI
at 0.152.0. Other IDE/desktop runtime versions are not verified. A local lease
alone cannot enforce ownership against those clients. Avoid opening an owned
chat in another client while the extension runtime is running; close the chat
to stop that runtime and release its native writer lock. Unknown interruption
results keep configuration and restoration blocked until parent/child activity is
reconciled. Reconnection never resends the unknown request.

Do not include secrets, personal transcripts, raw vendor bundles or private
checkpoint contents in public bug reports. Use GitHub private vulnerability reporting when enabled. Otherwise ask the
maintainer for a private contact through an issue containing no sensitive details.

## Child tasks, memory and OAuth

Child controls require runtime-proven ancestry to the current parent, the same
canonical workspace/provider and the owning Agent connection. Inspecting a child
never resumes it. Interrupts target its observed turn ID. Approval UUIDs bind the
connection/thread/turn/request; duplicate RPC IDs fail closed before any wait.
Pending/active/unreconciled children block shared configuration changes. Event
revision checks prevent old metadata from concealing later running work.

Memory previews are read-only, bounded UTF-8 text behind host-issued IDs. Every
path component and file identity is rechecked; links/hard links are refused.
No memory editing/deletion or ChatGPT-web-memory synchronization is claimed.

OAuth accepts HTTPS or loopback HTTP URLs without URL credentials. Native
completion is correlated with the connection, login ID or server/thread and
configuration fingerprint; native account/auth state is read back. MCP flows
cannot be repeated for the same server on one connection because the native
completion event has no flow ID. Unknown results require reconnection. Standard flat MCP forms are validated against the private request snapshot;
unsupported schemas remain decline/cancel only. URL-mode summaries omit untrusted
URL-bearing messages. Real external identity-provider acceptance remains a release gate.
