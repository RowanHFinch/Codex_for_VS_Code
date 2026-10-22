# Release acceptance

Version **0.9.0**, publisher **RowanHuang**. The stable package has no Preview flag.
The release is public on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=RowanHuang.independent-codex-vscode)
and [GitHub Releases](https://github.com/RowanHFinch/Codex_for_VS_Code/releases/tag/v0.9.0).

## Platform evidence — 2026-10-22

[Final release CI run 39811768366](https://github.com/RowanHFinch/Codex_for_VS_Code/actions/runs/39811768366)
passed all six jobs at release commit `91c7e22` (tag `v0.9.0`).

| Check | macOS | Ubuntu | Windows |
| --- | --- | --- | --- |
| 218 offline regressions, strict types, build, VSIX verification | Passed | Passed | Passed |
| Dependency audit | Passed | Passed | Passed |
| Codex 0.152.0 native OAuth, forms, agents, integrations and ecosystem fixtures | Passed | Passed | Passed |
| Installed VSIX editor, pre-apply diff, context, file mentions and recovery tests | Passed | Passed | Passed |
| Sidebar navigation/drafts and native MCP form UI | Passed | Passed | Not run |

Linux ARM64 container checks also passed on an earlier candidate; they are
supplementary evidence, not certification of subsequent audio changes. The final
metadata/package commit passed the same CI workflow before distribution.

## Real account and device checks

- macOS live-account editor: native edit approval/diff, undo, rewind, title update
  and archive passed in a temporary workspace.
- macOS microphone, Codex `0.163.0-alpha.11`: the owner confirmed a complete Chinese
  sentence after the final-audio fix, and confirmed that New chat stops recording
  without adding a late transcript. The transcript remained an unsent draft.
- Renderer checks: cancellation during local audio startup and active recording;
  a fresh chat from an unsent draft; returning to the original preserved draft;
  toolbar keyboard navigation and Escape dismissal. No microphone was simulated
  as a hardware acceptance result.
- Existing native MCP configuration: bearer authentication discovered 42 tools.
  SCYS OAuth required reauthorization in the native runtime too; the owner
  completed consent. A fresh runtime reused the credential and discovered 53 tools.
  Both existing servers subsequently connected without another login, and native
  configuration bytes were unchanged.
- A real SCYS `listMenu` call completed using native OAuth and one-time approval
  through the supported form schema. Only public tag metadata was requested;
  no external write or persistent tool-approval grant was made. This check used
  runtime `0.163.0-alpha.11` and model `gpt-5.6-sol`; editor form rendering is covered
  separately by the native synthetic-service UI tests above.
- A focused independent review checked audio ownership, cancellation and late
  callbacks. Regression tests cover owner visibility/disposal, conversation
  switching, final transcript deltas and cancellation during transcription.

## Publication hygiene

Historical assessments, duplicate ledgers, private test receipts and previous
binaries were archived outside the public source tree. The original development
Git history was also archived; the public repository starts with a clean export.
All 110 original feature IDs and acceptance criteria remain in `feature-matrix.json`.
A read-only publication review found no verified credentials, personal transcripts
or proprietary UI bundles in the public export. Package verification checks the
archive allowlist, licenses and digest; it does not replace functional tests.

## Coverage limits

- Real microphone evidence is macOS-only. Other audio devices, other operating
  systems and other OAuth providers are not certified by those checks.
- Full screen-reader compatibility and long-duration soak reliability remain
  unverified. Basic keyboard checks do not establish full accessibility acceptance.
- Newer alpha runtimes are not guaranteed compatible with every feature. A local
  Hook fixture once timed out, then passed an isolated retry and three consecutive
  runs; the original transient failure was not conclusively explained.
- Remote/virtual hosts, arbitrary MCP form schemas, complete vendor parity and
  every model/provider combination are outside the initial supported scope.
  The feature ledger is a roadmap, not a claim of complete parity.

## Distribution verification — 2026-10-22

- The Marketplace public listing is available with publisher Rowan Huang.
- VS Code installed `RowanHuang.independent-codex-vscode@0.9.0` directly from the
  Marketplace into an isolated profile. Its manifest has `preview: false`.
- All 44 non-manifest extension files match the uploaded VSIX byte for byte.
  The package manifest also matches after removing gallery-added metadata.
- The public GitHub release VSIX was downloaded again and verified against its
  published SHA-256 file:
  `a548dcb274be00df4cdf080745826e530490d0a21ab8ff3e3b87379d4cc0a2d9`.
- The release tag remains fixed at the tested source commit; this later document
  update records publication results without rebuilding or replacing version 0.9.0.
