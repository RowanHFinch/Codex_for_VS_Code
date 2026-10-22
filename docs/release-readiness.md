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

## Windows startup investigation — unreleased changes

The first attempt of [run 39813431545](https://github.com/RowanHFinch/Codex_for_VS_Code/actions/runs/39813431545/attempts/1)
failed in the native Windows integration fixture with a 30-second `initialize`
timeout. Its successful second attempt does not establish a root cause or fix.
The failed attempt did not record process sequence, stdout EOF or frame metadata;
`#1` is the first request of each process, not necessarily the first startup in the script.

Two Windows workers each completed 30 integration iterations in
[run 39815387737](https://github.com/RowanHFinch/Codex_for_VS_Code/actions/runs/39815387737).
Two more each completed 10 full OAuth/form/agent/integration/Hook sequences in
[run 39816894588](https://github.com/RowanHFinch/Codex_for_VS_Code/actions/runs/39816894588).
Together these instrumented 720 integration-fixture initializations with the
original transport, all below one second (maximum 983 ms). No request was retried.
This did not reproduce the original timeout. The failed runner used image
`20261018.275.1`; the stress runners used `20261021.278.1`, so these are not an
identical-host reproduction. macOS also passed 20 iterations / 180 initializations.

A separate fault-injection test did reproduce a client defect: if stdout ends
while the child remains alive, pending work was reported as a timeout and the
connection still accepted new sends. The client now handles EOF as a disconnect,
rejects pending delivery as unknown, and refuses subsequent sends. Regression
tests verify the still-running child case and a complete final reply immediately
followed by EOF. They inject EOF at the client's readable stream boundary; this
does not certify Windows child-process handle closure. Removing the fix makes
both tests fail. A focused independent review checked frame ordering and no replay.
This is a confirmed fix for that failure mode, **not proof of the original CI cause**.

Regular integration CI now records process lifecycle and bounded frame summaries
without request/result payloads. Failure-only stderr capture is confined to the
empty-home synthetic fixture. Earlier manual `startup_diagnostics` runs exercised
full native sequences on two Windows runners, failing on errors without retries.
The original timeout remains unresolved until a failing trace identifies its cause;
neither increasing timeouts nor rerunning to green is considered a resolution.

### Controlled cold-start contention — 2026-10-22

The comparison in [run 39821433265](https://github.com/RowanHFinch/Codex_for_VS_Code/actions/runs/39821433265)
used the same Windows runner, Codex 0.152.0 and eight simultaneous `connect()` calls:

| Native homes | First initialization | Subsequent initialization |
| --- | --- | --- |
| Eight separate homes | 8 passed | 8 passed |
| One shared home | 5 passed, 3 failed | 8 passed |

The failed shared-home processes reported native SQLite initialization errors and
closed stdout before returning any protocol frame (254–636 ms). Initialization
bytes had already flushed. An earlier Windows run also failed 3 of 8 shared cold
starts; five macOS controls failed only the shared cold case, with all other
cases passing. This isolates a native first-start concurrency defect, but its
early process exit is **not the original 30-second timeout**.

The extension now serializes spawn, handshake and startup configuration checks
within one extension host. Failed starts await the existing bounded shutdown
before releasing the queue; failures do not poison the queue or trigger retries.
Already connected clients' ordinary RPC calls do not acquire this queue. This
does not coordinate other VS Code windows, CLI/desktop clients or repair native
database state. Shutdown waits at most three seconds, not indefinitely for OS exit.

The focused regression failed before the fix (four simultaneous initializations)
and passed after it (one), also checking recovery after failure and independent
live RPC. Local strict types, 221 tests and build passed; all six regular CI jobs
passed at `2845e46` in [run 39822316493](https://github.com/RowanHFinch/Codex_for_VS_Code/actions/runs/39822316493).

The unmodified sequential Windows reproduction additionally completed 100 fresh
homes / 901 initializations. Two first starts took 9.8 and 10.9 seconds. At five
seconds they had flushed input but emitted no stdout; the file snapshots showed
SQLite database/journal creation. This narrows the observed slow path but does
not prove the original timeout's cause. A separate four-fixture pressure run
completed 922 initializations, with a 17.9-second maximum and no failed request.
Slow-start diagnostics now also read only the temporary database's backfill status and retain ten seconds of observation
after a failed deadline, without resending or accepting the late result as a pass.

The diagnostic workflow compares cold/warm, shared/separate homes and runs four
independent integration fixtures concurrently. It preserves any failure rather
than retrying it. These changes remain on the investigation branch; no new
Marketplace version or release tag has been published.

The post-queue four-fixture pressure worker in
[run 39822319336](https://github.com/RowanHFinch/Codex_for_VS_Code/actions/runs/39822319336)
completed 935 initializations (maximum 9.25 seconds). Its 22 slow-start snapshots
included 17 completed backfills, one pending backfill and four unavailable reads;
none captured a running backfill. These samples therefore do not support blaming
all observed delays on a stuck backfill lease. Process snapshots succeeded three
times and were unavailable 19 times; future failures record only the helper's
error code, kill flag and signal, without command output or environment contents.
Different runners and instrumentation prevent treating the two maxima as a
controlled performance improvement.

An isolated macOS Codex 0.152.0 fault injection confirmed one possible 30-second
failure mechanism: a fresh successful startup took 210 ms; changing only the
fixture's backfill row to an unexpired `running` lease caused no protocol response
and native exit after 30,117 ms with an explicit backfill-wait error; restoring the
original row restored initialization in 63 ms. This modified only a disposable
fixture, never a user's database. It validates that diagnostic signature, **not
that the original Windows CI failure had that cause**. The extension must not
reset native database leases or replay requests based on this hypothesis.

The same run's controlled worker completed ten of each cold/warm, shared/separate
case: 80 initializations per case, all successful. In total it recorded 407
successful initializations (maximum 4.10 seconds), then the 15-minute **job**
limit canceled the worker during the tenth iteration's ordinary integration
sequence. One pending initialization was interrupted by cancellation, not observed
to reach its request deadline. This is partial evidence, not a fully passed
20-iteration run. The manual shared-home loop is now bounded to five iterations
to fit the existing job budget; the 30-second RPC deadline and failure assertions
remain unchanged. The four-independent-fixture pressure loop remains 25 batches.

Merge and publication remain blocked on the original timeout investigation.
The original runner is gone and lacked a failure trace; newer-runner green jobs,
controlled cold-start fixes and injected faults cannot reconstruct that event.

### Upstream SQLite startup hypothesis and runtime A/B — 2026-10-22

Source review of the pinned runtime identified a native mechanism that matches
the original failure better than the cold-start concurrency defect. The failed
attempt timed out on the **first** `initialize` of a single fresh home about 31.5
seconds after the fixture started; no other client shared that home.

In `rust-v0.152.0` (tagged 2026-09-01), every new connection in a writable state
pool (up to five per database) applied `journal_mode=WAL` and
`auto_vacuum=INCREMENTAL` through SQLx connect options, with a five-second
`busy_timeout`. Upstream later documented that the vacuum setter takes the writer
lock even when unchanged, so a connection opened while another holds a write
transaction can wait and fail; SQLx then retries connection setup and reports
`PoolTimedOut` after its default 30-second acquire timeout
([openai/codex#49032](https://github.com/openai/codex/pull/49032),
[openai/codex#49102](https://github.com/openai/codex/pull/49102)). State database
initialization runs before the app-server answers `initialize`. Separately, a
failed `mark_backfill_complete` write in 0.152.0 is only logged, leaving a fresh
900-second `running` lease owned by the same process; the startup gate then waits
its 30-second limit and exits (the signature reproduced by fault injection above).

The Windows evidence above is consistent with this: slow first starts of 9.8,
10.9, 17.9 and 9.25 seconds produced no stdout while SQLite files were being
created, close to multiples of the five-second busy timeout. Both upstream fixes
first ship in Codex 0.160.0; local macOS runs of the OAuth, form, agent,
integration and foundation fixtures pass on 0.163.0.

#### Windows A/B result: hypothesis not supported

Commit `df18cdb` ran all six regular jobs on 0.163.0 successfully
([run 39826596405](https://github.com/RowanHFinch/Codex_for_VS_Code/actions/runs/39826596405)).
The same `startup_diagnostics` workflow then ran with each runtime:

| Runtime | Run | Four-fixture pressure worker | Sequential + shared/separate worker |
| --- | --- | --- | --- |
| 0.152.0 | [39826605438](https://github.com/RowanHFinch/Codex_for_VS_Code/actions/runs/39826605438) | **Failed:** 144 inits, then four simultaneous 30 s `initialize` timeouts | Passed: 205 inits, max 11.4 s, 4 over 5 s |
| 0.163.0 | [39826666515](https://github.com/RowanHFinch/Codex_for_VS_Code/actions/runs/39826666515) | **Failed:** 427 inits (max 7.2 s), then a native SQLite state-runtime initialization error after 72 ms | Passed: 205 inits, max 10.8 s, 11 over 5 s |

The 0.152.0 failure reproduces the original signature on a single fresh home
per fixture: zero stdout bytes and no exit at 30 seconds. Its diagnostics show
the process was **progressing, not deadlocked**: file snapshots advanced through
`state_5`, `logs_2`, `goals_1` and `memories_1` creation (about 5–10 seconds per
database, with rollback-journal files present), the backfill row was still
`pending`, and two processes logged normal app-server startup about 44 seconds
after spawn. In the pressure worker, the four independent fixtures repeatedly
slowed down by nearly identical amounts in the same batch, which points to a
host-wide file I/O bottleneck rather than a per-process lock.

0.163.0 still showed multi-second cold starts of the same shape, so the upstream
SQLite connection-setup fixes do not remove this slow path, and the per-connection
writer-lock explanation above is **not supported** as the cause. CI therefore
stays on 0.152.0 by default; `runtime_version` remains available for comparisons.
The 0.163.0 pressure failure (separate homes, immediate native error) is a further
sign of file-level interference during SQLite creation; its underlying OS error
was not printed by the runtime.

Current conclusion: the original timeout is a native cold start that exceeded 30
seconds while creating its SQLite databases under slow Windows file I/O. What
slows file creation on the runner (for example real-time antivirus scanning of
new database and journal files, or disk throughput) is **not yet identified**.
Merge and publication remain blocked.
