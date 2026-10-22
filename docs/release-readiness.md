# Release acceptance

Version **0.9.0**, publisher **RowanHuang**. Stable publication is pending the
checks below. The Preview flag remains enabled until the release decision.

## Verified before this release pass

The 2026-10-22 performance review completed 213 offline regressions, strict types,
production builds, native runtime fixtures, macOS source/installed-editor tests,
package allowlist/license checks and a focused independent restore/concurrency review.
It explicitly did not certify Windows, a fresh Linux build, screen readers,
long-duration concurrency, microphone or external OAuth providers.

Earlier releases exercised Linux ARM64 and emulated Linux x64, but those results
are not proof for the current source. Prior actual account-backed native edit
approval, undo and rewind tests establish only their recorded runtime/model scope.

## Current release pass — 2026-10-22

- Repository cleanup: historical assessments, duplicate ledgers, local receipts and
  previous binaries archived outside the public source tree. The complete original
  110 feature IDs and acceptance criteria remain in `feature-matrix.json`.
- Read-only publication review: no verified credentials, personal paths/transcripts
  or proprietary UI bundles found in public source or historical Git blobs.
- Fresh local `npm run check`: 213 tests passed, types and production build passed.
- Publisher identity verified in Marketplace. Upload has not been performed.
- Current package/editor/platform checks and remote CI: pending.

## Remaining acceptance

- Run the current package through macOS and Linux editor/runtime checks and Windows CI.
- Check keyboard/accessibility behavior; automated semantics are not screen-reader acceptance.
- Verify real microphone and external OAuth behavior before claiming those integrations.
- Exercise prolonged and concurrent sessions; small fixtures do not establish soak reliability.
- Confirm public repository/support URLs, package metadata, clean source history,
  dependency audit, published listing and installation of the published artifact.

Remote hosts, full vendor parity and every model/provider combination are outside
the initial release scope. Missing roadmap features must not be advertised as complete.
