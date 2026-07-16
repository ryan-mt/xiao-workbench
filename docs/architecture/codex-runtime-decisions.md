# Codex runtime decisions

Status: **Accepted for M0**

Decision date: 2026-07-16

Xiao baseline: `33bfa96`

Tested Codex CLI: `codex-cli 0.144.5`

This ADR records the protocol and storage decisions required before implementing
M1–M3. Results apply to the tested CLI. Future CLI upgrades must rerun the probe
and compatibility tests; version drift is not assumed safe.

## Reproduction

Schema/types were generated outside the repository:

```powershell
codex app-server generate-json-schema --experimental --out $TEMP\xiao-m0-protocol\schema
codex app-server generate-ts --experimental --out $TEMP\xiao-m0-protocol\ts
```

Repository probe commands:

```powershell
# Schema + account metadata + persistent start/restart/resume/delete.
# Does not start a model turn.
npm run probe:codex

# Also starts minimal model turns in a temporary workspace to test concurrency,
# command interruption and pending-approval crash recovery.
npm run probe:codex -- --live

# CI-safe sanitized compatibility fixtures.
cargo test --manifest-path src-tauri/Cargo.toml agent::protocol::tests

# Manual reproducible current-store performance baseline.
cargo test --manifest-path src-tauri/Cargo.toml benchmark_representative_store_round_trip -- --ignored --nocapture
```

The Node probe:

- uses a unique temporary workspace;
- uses read-only sandbox for normal/concurrency/interrupt probes;
- uses a single temporary file path for the approval probe and verifies that it
  never appears;
- prints only bounded booleans/counts/timings, never transcript, reasoning,
  account email, model output, paths or runtime IDs;
- deletes every persistent test thread and temporary directory;
- exits non-zero on correlation, cleanup or safety failure.

The full generated schema is intentionally not committed because it is large and
CLI-version-specific. Xiao commits a small sanitized JSONL fixture containing
only fields its routing assumptions require.

## Protocol findings

### Methods required by the critical path

CLI `0.144.5` generated schemas include:

| Capability | Method/event | Result |
|---|---|---|
| Start persisted thread | `thread/start` with `ephemeral: false` | Present |
| Resume exact thread | `thread/resume` | Present |
| Read/delete owned thread | `thread/read`, `thread/delete` | Present |
| Start turn | `turn/start` | Present |
| Interrupt exact turn | `turn/interrupt` | Present |
| Terminal turn event | `turn/completed` | Includes `threadId` and `turn.id/status` |
| Command approval | `item/commandExecution/requestApproval` | Includes request ID, `threadId`, `turnId`, `itemId` |
| File approval | `item/fileChange/requestApproval` | Correlated request type present |
| Permission approval | `item/permissions/requestApproval` | Correlated request type present |
| User question | `item/tool/requestUserInput` | Includes `threadId`, `turnId`, `itemId` |
| Collaboration item | `collabAgentToolCall` | Includes sender, receivers and agent states |

The generated `ThreadResumeParams` explicitly says to prefer `threadId` and can
load a non-running thread from disk. `Thread` reports whether it is ephemeral,
its source tag, parent/fork identity and turns when requested.

### Persistent resume probe

Observed:

1. `thread/start(ephemeral=false)` returned a stable ID.
2. An entirely empty thread was **not yet materialized**; restarting immediately
   could return `no rollout found`.
3. Injecting one benign user-visible item materialized the rollout without a
   model turn.
4. After killing the first app-server and starting another, `thread/resume` by
   exact ID returned the same non-ephemeral thread and preserved the custom
   `threadSource`.
5. `thread/delete` made the thread unreadable.

Decision consequence:

- A newly-returned thread binding is `provisional` until at least one persisted
  item/turn exists.
- A crash between thread start and materialization is an Interrupted run and may
  create a fresh thread on explicit retry.
- Xiao never assumes an empty thread ID is durable.

### App-server state is not a Xiao namespace

The probe starts app-server with a unique temporary `CODEX_SQLITE_HOME`, matching
the isolation attempted by the current Xiao runtime. `thread/list` with
`useStateDbOnly: true` still exposed pre-existing app-server threads (43 in the
observed profile). Therefore `CODEX_SQLITE_HOME` is **not a security or ownership
namespace** for threads in CLI `0.144.5`.

The probe also confirmed that a custom `threadSource` survives read and resume.

Decision consequence:

- Continue using an app-specific runtime directory where useful, but never rely
  on it to hide/own sessions.
- Xiao's SQLite database is the ownership allowlist for thread IDs.
- Start Xiao threads with `threadSource: "xiao-workbench"` and a Xiao service
  name.
- Resume only an exact ID stored by Xiao, then verify returned ID/source.
- Do not show, import, archive, delete or otherwise mutate arbitrary
  `thread/list` results.
- If source/ID does not match, reject the binding and use a visible continuation
  fallback.

This removes unwanted cross-client coupling without copying Codex auth into a
separate `CODEX_HOME`.

### Concurrent turn probe

One app-server started two different ephemeral threads, submitted both
`turn/start` requests without waiting for completion, and instructed each to run
a three-second read-only sleep command.

Observed:

- both `turn/started` notifications arrived before either `turn/completed`;
- each event retained its own `threadId` and `turn.id`;
- both terminal statuses were `completed`;
- no workspace mutation occurred.

Decision: one app-server process can own multiple concurrent Xiao threads for
the tested CLI. Start with one process per execution environment, not one process
per run.

### Interruption probe

A separate ephemeral turn began a 30-second read-only sleep command. After the
`commandExecution` item started, Xiao sent `turn/interrupt` with the exact thread
and turn IDs.

Observed:

- terminal `turn/completed` arrived with status `interrupted`;
- the process did not need to be killed;
- the temporary workspace was not modified.

Decision: normal cancellation first calls exact `turn/interrupt`. Process kill
is escalation only when the request times out or the runtime is unhealthy.

### Pending approval across process death

A persistent thread in read-only sandbox was asked to execute one exact write
command against a temporary file. App-server emitted a correlated approval
request. The probe killed app-server without replying, restarted it and resumed
the same thread.

Observed:

- the approval request was **not re-emitted**;
- the resumed turn status was `interrupted`;
- the requested file did not exist before or after restart;
- the persistent probe thread was deleted successfully.

Decision:

- Pending callbacks are generation-bound and cannot be reconstructed after
  app-server death on CLI `0.144.5`.
- Startup invalidates persisted pending-input UI and marks the run Interrupted.
- Xiao must never send a reply to an old request ID.
- Native thread resume remains useful for a later new turn, but it is not turn
  continuation and must not be presented as such.

### Subagent observability and controls

The schema exposes parent/child information through thread fields,
`collabAgentToolCall`, `senderThreadId`, `receiverThreadIds`, `agentsStates` and
`subAgentActivity`. This is enough to build a read-only graph when events are
normalized and persisted.

The generated client request schema has no dedicated generic pause/close child
agent method. `turn/interrupt` may target a known child thread/turn, but that
control has not been live-proven for nested agents.

Decision: M6 Observatory is read-only first. A pause/close/cancel child control
is not rendered until a dedicated live fixture proves the exact method and
terminal behavior. Xiao does not infer controls from collab tool names emitted
for model-side tools.

## Runtime topology decision

```text
RuntimeRegistry
  environmentId -> RuntimeProcess
    generation
    child/stdin
    pending client requests
    owned thread bindings
    active turns keyed by runId + threadId + turnId
```

- One Codex app-server per execution environment.
- Initial global in-flight run limit: **2**.
- One active turn per task/thread.
- A run waiting for input occupies one in-flight slot, so another unrelated run
  can still use the second slot without allowing unbounded pending approvals.
- Queue order is FIFO among eligible runs.
- Runtime generation increments at every process start.
- Events must match run + thread + turn/item identity and active generation.
- Late/stale events cannot mutate a newer run.
- Process death fails pending client calls, invalidates approvals/questions and
  reconciles in-flight runs to Interrupted.
- No automatic resubmission after ambiguous failure.

Why limit 2: it proves meaningful parallel work while bounding model usage,
pending approvals, CPU and worktree growth. Raise only after M3 soak tests and an
explicit setting/product decision.

Rejected alternatives:

- **Process per run**: unnecessary overhead and fragmented lifecycle given the
  successful correlation probe.
- **One global current task in React**: cannot route concurrent/stale events and
  cannot survive renderer restart.
- **Unlimited thread concurrency**: unsafe cost/resource and approval growth.

## Session-continuation decision

Primary strategy: **native persisted Codex thread resume**.

Flow:

1. Start non-ephemeral thread with Xiao source tag.
2. Treat binding as provisional until materialized.
3. Persist binding in Xiao's own Task/Run domain.
4. On later user-authorized turn, resume exact stored ID.
5. Verify returned ID/source and attach events by explicit correlation.

Fallback: **structured continuation capsule**, only when native resume is
missing/incompatible.

Required capsule fields:

- goal and current plan;
- user-visible user and assistant messages;
- ordinary file/image attachment references still available;
- review comments/context;
- changed-file and baseline summary;
- latest acceptance contract and verification evidence;
- unresolved-input explanation;
- source run/backend/version and visible lineage boundary.

Do not use unstable `thread/resume.history` (generated schema labels it Codex
Cloud-only). A fallback starts a new thread/run and is shown as a handoff, not a
native resume.

## Persistence decision

Use SQLite as canonical native storage beginning in M1.

Selected library:

```toml
rusqlite = { version = "0.40.1", default-features = false, features = ["bundled"] }
```

M0 compiled and ran a temporary Windows program using this exact dependency,
an in-memory connection, DDL, transaction, parameterized insert and query.

Connection ownership:

- one `rusqlite::Connection` created during Tauri setup;
- held in native managed state behind `Mutex`;
- never held across `.await`, Git/process/model calls or event emission;
- short transactions only;
- no async ORM, connection pool or migration framework in M1;
- add a read pool later only if paging benchmarks prove contention.

Required pragmas:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

Migrations are numbered embedded SQL in a transaction with a migration record.
M1 imports `xiao-state-v1.json` once, verifies counts/field hashes, keeps an
untouched backup and stops dual-writing after cutover.

Rejected alternatives:

- **Continue one large JSON document**: no cross-entity transaction,
  occurrence uniqueness or efficient event paging.
- **Multiple ad-hoc JSON files**: moves atomicity and recovery problems into
  custom code.
- **SQLx**: async runtime/pool and compile-time query machinery are unnecessary
  for the current native single-process store.
- **ORM/migration framework**: adds a second abstraction before schema behavior
  is stable; embedded SQL is easier to audit at this scale.

## Managed-worktree ownership decision

Root:

```text
<app-data>/managed-worktrees/<workspace-key>/<worktree-id>/
  ownership.json
  checkout/
```

`workspace-key` is a stable hash of environment ID + canonical repository common
directory. IDs remain in the marker, so the hash is not the only proof.

Ownership requires all of:

- active Xiao database record;
- versioned marker outside the checkout;
- canonical checkout under managed root;
- marker/database path and IDs match;
- repository common-dir SHA-256 matches;
- `git worktree list --porcelain` confirms the worktree.

Branch format starts `xiao/<task-short>/<run-short>` with collision-resistant ID
suffix. Cleanup never force-resets the main workspace and never deletes a
worktree it cannot prove Xiao created.

## Event persistence and redaction decision

Persist normalized events, not raw app-server JSON.

Hard bounds:

- safe event payload: 64 KiB;
- diagnostic/error text: 4 KiB;
- runtime log: 240 memory entries, 16 KiB each;
- command evidence: first 256 KiB + last 256 KiB, total count, truncation flag
  and streaming SHA-256;
- UI query page: 200 events.

Never persist environment maps, auth headers, secret answers, encrypted/raw
reasoning, base64 data URLs or unbounded deltas. User-visible reasoning summaries
may be persisted; raw Responses API items may not. Paths under execution root
become relative; export redacts outside absolute paths by default.

## Compatibility policy

- Record CLI version on each thread binding/run.
- The compatibility baseline is `0.144.5`; older/newer versions are not assumed
  to have identical experimental fields.
- Production startup does not generate schemas.
- Unknown additive events are bounded/logged and ignored safely.
- Missing required method returns a capability error; Xiao may use structured
  continuation but never fabricates native resume.
- Rerun both probe modes and fixture tests before raising the documented CLI
  baseline or shipping a runtime protocol change.
- Generated schemas are authoritative for shapes; live probes are authoritative
  for lifecycle behavior not guaranteed by shape alone.

## Baseline measurements

These are planning baselines, not release performance promises. They were run on
the M0 Windows development machine using debug/unoptimized Rust where noted and
synthetic data only.

### Current JSON store round trip

Ignored Rust test fixture:

- 5 workspaces;
- 20 tasks per workspace;
- 80 timeline entries per task;
- 512-character body per timeline entry;
- serialized size: **5,847,556 bytes**.

Five rounds:

| Operation | Measurements (ms) | Median |
|---|---|---:|
| `serde_json::to_vec_pretty` | 150, 159, 147, 152, 146 | 150 |
| current atomic write + sync | 3, 4, 3, 3, 3 | 3 |
| read + parse + normalize | 54, 55, 53, 53, 51 | 53 |

This justifies paging and avoiding whole-store rewrites as run events grow. M1
must rerun the same fixture against SQLite import/load/update behavior.

### Debug window startup with synthetic profile

A temporary APPDATA/LOCALAPPDATA profile contained a 5,905,700-byte equivalent
state file. The existing debug executable was launched five times and measured
from process start until a non-zero main window handle:

```text
149, 125, 126, 108, 110 ms (median 125 ms)
```

This M0 measurement attempted isolation by overriding `APPDATA`/`LOCALAPPDATA`.
An M1 executable probe proved that Tauri's Windows known-folder lookup ignores
that override, so the earlier claim that no real state was read cannot be
substantiated. Retain these values only as a rough startup reference. M1 added a
debug-only absolute `XIAO_WORKBENCH_STATE_DIR`; all M1 executable migration
probes used that explicit state root and verified the real profile hash/mtime.

### M1 SQLite store baseline

The same 5-workspace / 100-task / 8,000-entry synthetic shape produced a
4,632,576-byte SQLite database in a debug build. Five measured rounds:

| Operation | Measurements (ms) | Median |
|---|---|---:|
| deliberate full snapshot save | 417, 240, 242, 242, 244 | 242 |
| production-shaped one-task metadata update | 0, 0, 0, 0, 0 | <1 |
| full load of all workspaces/timelines | 56, 56, 55, 57, 56 | 56 |
| bounded load (active timeline only) | 3, 3, 3, 3, 3 | 3 |

The full-save row is a stress path that hashes every complete timeline. The
frontend normally sends only changed task records and omits timeline data when
the timeline reference is unchanged. Identical complete timelines are also
hash-checked natively before row replacement.

A copied beta state (3 workspaces, 27 tasks, 660 timeline entries) passed both
the repository migration harness and an isolated debug-executable launch.
Counts, source/backup SHA-256, `PRAGMA integrity_check`, foreign keys and a
second-start idempotency check all passed. A separate forced process kill after
backup and before transaction commit rolled back to zero imported rows; restart
then imported exactly 1 workspace, 1 task and 500 entries.

Windows release compilation and NSIS bundling passed with bundled SQLite. The
release executable measured 14.20 MiB and the NSIS installer 4.13 MiB. The
pre-existing `bundle.targets = "all"` path still fails MSI validation because
`0.0.0-day07152026` uses a nonnumeric prerelease identifier; M1 intentionally
did not change release versioning.

### App-server metadata probe

One representative metadata run reported:

```text
first initialize:   1375 ms
restart initialize:   86 ms
thread resume:      1544 ms
```

Auth/config/plugin cache can change these values. M3 must keep runtime startup
off the UI thread and show explicit Preparing state rather than promising a
fixed latency.

Performance guard: investigate a reproducible startup or active-stream
regression greater than 20% against these fixture methods before release. Do not
turn a one-machine number into a hard cross-device SLA.

## Known non-blocking risks

1. **Experimental protocol drift** — mitigated by fixture tests, capability
   errors and release-time live probes.
2. **Shared Codex session state** — mitigated by Xiao-owned exact-ID allowlist
   and source verification; never browse/import global threads by default.
3. **Empty thread not materialized** — provisional binding plus explicit retry.
4. **Pending approval cannot resume** — generation invalidation and Interrupted
   recovery, not automatic retry.
5. **App-server first initialization variance** — async Preparing state and no DB
   lock while starting.
6. **SQLite bundled binary/package size** — validate installer size and Windows
   packaging in M1; functional Windows compile already passed.
7. **Large transcript migration** — transactional import, backup, hash/count
   verification and paging.
8. **Worktree disk growth** — inspectable records, size display and confirmed
   owned cleanup in M2; no speculative auto-delete.

None permits bypassing approvals, path scoping, ownership checks or evidence.

## Requirements handed to later milestones

### M1

- Add `rusqlite` exactly as selected unless a packaging test fails and triggers
  a replacement ADR.
- Preserve every current user-visible field.
- Model thread bindings explicitly; remove the misleading save-time silent clear.
- Paginate transcript/event reads.
- Do not resume or dispatch turns yet.

### M2

- Implement the managed root/marker/database/Git four-way ownership proof.
- Resolve one execution environment/root in Rust for every operation.

### M3

- Implement one app-server per environment and limit 2.
- Route by run + generation + thread + turn/item identity.
- Make all in-flight startup reconciliation Interrupted.
- Never restore a stale approval callback.
- Add deterministic fake-runtime tests before relying on live Codex.

### M6

- Build read-only subagent graph first.
- Add controls only after a dedicated live protocol proof.
