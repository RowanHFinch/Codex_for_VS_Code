# Project Instructions

Build an independent open-source VS Code extension with the official Codex VS Code experience as its functional floor, then add the owner's requested enhancements. Claude Code and Claudian are workflow/UI references. Read docs/development-plan.md, docs/runtime-support.md, docs/release-readiness.md and docs/feature-matrix.json before implementation. The user has explicitly authorized starting development here.

## Product scope

- Product documentation defaults to English. UI locale defaults to following VS Code, with English fallback and native-setting overrides for English/Simplified Chinese; do not couple UI locale to model response language or speech language. Communicate with the user in Chinese by default.
- Use TypeScript, one React webview, esbuild and a supported local Codex app-server runtime. Keep the solution small and use stable VS Code APIs for the core.
- No independently hosted server, self-built conversation database or billing service is required initially. Use runtime APIs for conversation history and VS Code storage for local presentation state. Verify shared-history visibility and external-client coexistence; do not promise synchronization from shared filesystem location alone.
- Preserve supported Codex configuration and ecosystem behavior; make client overrides explicit. File/selection context is a baseline. Verify reasoning choices including Max against the real catalog, transmitted request and result; a selector alone is not acceptance. Local Codex memory and ChatGPT web memory are separate.
- Preserve the full feature ledger as the final scope. Class A means primitives exist, not completed implementation; class B needs additional engineering; exact Anthropic class C outcomes remain explicit blockers; dormant/internal class X records are excluded from verified public parity.

## Development and evidence

- Begin with M0 and actual prototypes, then continue into the local alpha where feasible. Do not stop at a plan or scaffold when authorized implementation can progress.
- First establish runtime/auth integration, request/event correctness, pre-apply review feasibility, durable checkpoint design and thread ownership across participating versus external clients.
- Never label post-apply reverse patches as pre-apply rejection. Never label thread/revert as code rewind. Never blindly replay an unknown-outcome request.
- A local writer lease only coordinates cooperating clients; official CLI/IDE/desktop coexistence needs runtime enforcement, verified detection/refusal, or an explicit unsupported condition.
- Protect dirty buffers, concurrent manual edits, filesystem roots and credentials. Run real tests appropriate to each change; UI changes need browser/editor interaction checks where tools permit.
- Default to main-agent implementation/self-review. For authentication, sensitive data, destructive file restoration or critical concurrency changes, use one focused read-only independent reviewer when available. No recursive delegation or redundant whole-project reviews.
- Audit summaries have partial semantic coverage and no prior live agent-task acceptance. Keep observed, inferred and unverified claims separate.
- Record progress and unresolved limitations in project documentation. Do not update global agent memory unless the user explicitly asks.

## Publication boundaries

- Write original code and assets. Do not import or publish proprietary vendor UI bundles, extracted byte-bearing REA artifacts, private credentials/settings or personal transcripts.
- GitHub repository creation, pushing, Marketplace publishing and production account changes are separate external actions; do not infer them from local development authorization.
