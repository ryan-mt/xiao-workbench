# Execution domain architecture

Status: **Accepted for M0**

Baseline: Xiao `33bfa96`, 2026-07-16

This document fixes the domain boundaries and invariants for durable runs,
routines, verification and isolated execution. Exact SQL and DTO syntax belongs
in milestone child plans, but later implementations may not change these
semantics without an explicit ADR.

## Ownership boundary

```text
React UI
  - renders native snapshots/events
  - collects explicit user intent
  - never owns durable lifecycle transitions
            |
            v typed Tauri commands/events
Rust host
  - canonical persistence and migrations
  - scheduler, queue and run state machine
  - execution-environment resolution
  - agent process/thread/turn registry
  - Git/worktree/checkpoint ownership
  - verification and evidence bounds
            |
            +-- Codex app-server per execution environment
            +-- Git/filesystem/native PTY through environment executor
            `-- SQLite + bounded artifacts in Xiao app data
```

React may optimistically display a pending action, but Rust is authoritative for
task/run/routine status. Closing/reloading the webview cannot create, complete,
retry or cancel a durable run by itself.

## Identity and time conventions

- Domain IDs are lowercase UUIDv7 strings generated in Rust.
- User-editable names/titles are never used as identity.
- Persist timestamps as UTC Unix milliseconds (`i64`).
- Routine recurrence additionally stores an IANA timezone identifier.
- A canonical workspace path is resolved in the selected environment before it
  is persisted as an execution root.
- External runtime IDs (`threadId`, `turnId`, request ID) are references, never
  Xiao primary keys.

## Aggregate model

### Workspace

```text
id
canonicalPath
displayName
createdAt
updatedAt
```

A workspace is the project container. Path uniqueness follows platform rules:
case-insensitive canonical comparison for Windows local; environment-native
comparison for WSL. Migration preserves current duplicate-path merge behavior.

### ExecutionEnvironment

```text
id
kind: windows | wsl
label
workspaceRoot
wslDistro?             # WSL only
availability
createdAt
updatedAt
```

It answers where agent, Git, terminal, filesystem and verification execute. M1
creates one Windows-local environment per migrated workspace. M7 adds WSL.

Rules:

- All privileged operations for a run use one environment implementation.
- No per-operation silent fallback between Windows and WSL.
- Frontend never constructs a shell/wsl command string.
- Environment health is checked before preparing a run.

### Task

```text
id
workspaceId
title
goal / plan / conversation projection
model / reasoning / mode / approval / sandbox defaults
executionEnvironmentId
workspaceMode: local | managed-worktree
acceptanceContractId?
createdAt
updatedAt
archivedAt?
```

Task is user-facing mutable intent and history. Execution attempts are separate
Run records. Changing task defaults does not mutate historical runs.

### Run

```text
id
taskId
routineOccurrenceId?
parentRunId?            # retry/handoff lineage
candidateGroupId?       # Task Arena lineage
idempotencyKey
status
agentOutcome
verificationOutcome
model / reasoning / mode / approval / sandbox snapshot
executionEnvironmentId
executionRoot
managedWorktreeId?
threadBinding?
queuedAt
startedAt?
finishedAt?
version                 # optimistic transition/version guard
```

Run snapshots all execution-affecting task/routine defaults at creation. Later
edits apply only to future runs.

#### Run status

```text
queued
preparing
running
waiting_for_input
verifying
completed
needs_attention
failed
cancelled
interrupted
```

Terminal statuses: `completed`, `failed`, `cancelled`, `interrupted`.
`needs_attention` is settled and consumes no execution slot, but an explicit
verification retry may reopen only its verification phase.

Allowed transitions:

| From | To |
|---|---|
| queued | preparing, cancelled |
| preparing | running, failed, cancelled, interrupted |
| running | waiting_for_input, verifying, completed, failed, cancelled, interrupted |
| waiting_for_input | running, failed, cancelled, interrupted |
| verifying | completed, needs_attention, failed, cancelled, interrupted |
| needs_attention | verifying |

No terminal status transitions back to active. Agent retry creates a new linked
run. Rerunning verification explicitly moves `needs_attention` to `verifying`,
creates a new VerificationAttempt on the same preserved execution result and
appends evidence; it never reopens the agent turn.

#### Agent outcome

```text
pending | completed | failed | interrupted | cancelled
```

#### Verification outcome

```text
not_requested | pending | passed | failed | blocked
```

Required combinations:

- no contract + settled agent: status `completed`, verification `not_requested`;
- all gates pass: status `completed`, verification `passed`;
- any gate fails/blocks: status `needs_attention`, verification `failed` or
  `blocked`;
- runtime loss: status/agent outcome `interrupted`; verification can never be
  changed to passed by reconciliation;
- `completed` alone must not be projected as Verified.

### ThreadBinding

```text
backend: codex
threadId
threadSource
cliVersion
boundAt
lastTerminalTurnId?
```

A binding belongs to one Xiao task lineage. The runtime can have multiple loaded
threads. Xiao only resumes IDs recorded in its own database and verifies the
returned ID/source. It never imports app-server `thread/list` results into Xiao
implicitly.

### RunEvent

```text
runId
sequence
timestamp
type
safePayload
```

Events are append-only and sequence is unique per run. A status transition and
its event are committed in one transaction. Idempotent lifecycle messages use an
event-specific key such as
`generation/threadId/turnId/itemId/lifecyclePhase`; non-idempotent deltas must
never be deduplicated by method/item alone. Raw output deltas are live-only and
are not inserted as individual RunEvents.

Persisted event classes:

- run/agent/verification status transition;
- approval/question opened, resolved or invalidated;
- normalized tool/change/subagent summary;
- plan projection;
- token/time summary;
- checkpoint, gate and artifact references;
- bounded diagnostic.

Do not persist in `safePayload`:

- environment maps or auth headers;
- secret answers or credentials;
- encrypted/raw model reasoning;
- base64 image/data URLs;
- unbounded stdout/stderr or raw protocol objects.

Bounds:

- serialized event payload: 64 KiB maximum;
- error/diagnostic message: 4 KiB maximum;
- live runtime log: current 240-entry ring, at most 16 KiB per entry;
- raw output deltas are live-only;
- command evidence stores at most 512 KiB (first 256 KiB + last 256 KiB), plus
  total byte count, truncation flag and streaming SHA-256;
- event queries page at 200 records by default and never load every project
  event at application startup.

Paths inside execution root are stored relative. An outside path is stored only
when required for user action and is marked external; exports redact it by
default.

### Routine

```text
id
workspaceId
title
prompt
scheduleKind: one_shot | daily | weekly
timezone
schedulePayload
missedRunPolicy: skip | run_once
runTemplate
acceptanceContractId?
enabled
nextRunAt
lastRunAt?
createdAt
updatedAt
```

### RoutineOccurrence

```text
id
routineId
scheduledFor
idempotencyKey
status: reserved | dispatched | skipped | cancelled
runId?
createdAt
```

`UNIQUE(routineId, scheduledFor)` and `UNIQUE(idempotencyKey)` enforce at most one
automatic dispatch. Scheduler reserves the occurrence, computes/persists the
next occurrence and creates the queued run in one transaction before runtime
dispatch.

Missed-run semantics:

- `skip`: advance to the first future occurrence and record skipped history only
  if useful to the UI; do not dispatch missed work;
- `run_once`: reserve at most one catch-up occurrence regardless of the number
  missed, then compute the next future occurrence;
- editing a routine creates future schedule state and never mutates historical
  occurrences/runs;
- deleting a routine disables/removes future scheduling but retains historical
  runs, evidence and owned-worktree records.

### PendingInput

```text
id
runId
runtimeGeneration
requestId
threadId
turnId
itemId
kind: command_approval | file_approval | permissions | question | mcp_elicitation
safeSummary
openedAt
invalidatedAt?
resolvedAt?
```

The tuple `(runtimeGeneration, requestId, threadId, turnId, itemId)` is required
for routing. On app-server death every unresolved input for that generation is
invalidated in one reconciliation transaction. A stale UI response is rejected
natively.

Pending input metadata may be persisted for diagnosis, but a request callback
is never considered resumable unless app-server re-emits a new live request. The
M0 live probe on CLI 0.144.5 returned the turn as `interrupted` and did not
re-emit its pending approval.

### AcceptanceContract

```text
id
workspaceId
name
version
gates[]
createdAt
updatedAt
```

Contracts are versioned. A run references the exact version snapshot used.
Initial gate definitions:

```text
CommandGate:
  executable
  argv[]
  timeoutMs
  expectedExitCodes[]

DiffScopeGate:
  allowedPatterns[]
  deniedPatterns[]

CleanlinessGate:
  allowStaged
  allowUnstaged
  allowUntracked
```

Command gates use executable + argv and a native process API. They never join a
model/user string into `cmd /c`, PowerShell or a POSIX shell. Cwd is the run's
canonical execution root. A missing executable, launch error or timeout is
`blocked`; an expected process that exits outside the allowed set is `failed`.

### VerificationAttempt and GateResult

```text
VerificationAttempt:
  id
  runId
  contractSnapshot
  status
  startedAt
  finishedAt?

GateResult:
  id
  verificationAttemptId
  gateIndex
  outcome: passed | failed | blocked | cancelled
  durationMs
  evidenceIds[]
  safeDiagnostic?
```

Gates execute in declared order in v1. Cancellation stops remaining gates and
preserves completed results. A retry creates a new VerificationAttempt.

### Evidence and Artifact

```text
Evidence:
  id
  runId
  verificationAttemptId?
  type
  summary
  artifactId?
  createdAt
  redactionState

Artifact:
  id
  relativeStoragePath
  mediaType
  byteLength
  sha256
  createdAt
  retentionClass
```

Artifacts live under Xiao app data, never at a model-chosen absolute path. The
database stores metadata/reference. Artifact paths are canonicalized under the
artifact root before read/delete. Export is a separate allowlisted projection.

### ManagedWorktree

```text
id
workspaceId
taskId
runId?
repositoryRoot
checkoutPath
branch
baseCommit
ownerMarkerPath
status
createdAt
removedAt?
```

Recommended layout:

```text
<app-data>/managed-worktrees/<workspace-key>/<worktree-id>/
  ownership.json
  checkout/                 # actual git worktree and execution root
```

The marker is outside `checkout` so it does not appear as an untracked project
file. Marker schema:

```json
{
  "version": 1,
  "worktreeId": "uuid",
  "workspaceId": "uuid",
  "taskId": "uuid",
  "runId": "uuid-or-null",
  "canonicalCheckoutPath": "environment-native path",
  "repositoryCommonDirSha256": "hex",
  "branch": "xiao/task-short/run-short",
  "createdAt": 0
}
```

Deletion requires every condition:

1. checkout canonicalizes under the managed-worktree root;
2. database record is active and matches marker IDs/path;
3. marker schema/version/hash is valid;
4. `git worktree list --porcelain` reports the same checkout/repository;
5. user confirms cleanup unless it is rollback of a setup transaction that never
   became visible/active.

`repositoryCommonDirSha256` is the SHA-256 of the UTF-8 environment-native
canonical Git common-directory path. It is a stable comparison value, not a
content hash or the sole ownership proof.

Failure of any condition returns a diagnostic and performs no deletion. Xiao
never deletes a manually-created worktree or force-resets the main checkout.

## Persistence architecture

SQLite in the Rust host is canonical after M1 migration. Browser localStorage
remains suitable only for cosmetic preferences and non-native preview fallback.

Planned schema, introduced incrementally:

```text
schema_migrations
legacy_imports
workspaces
tasks
task_timeline_entries
runs
run_events
routines
routine_occurrences
pending_inputs
acceptance_contracts
verification_attempts
gate_results
evidence
artifacts
managed_worktrees
```

M1 initially needs workspaces/tasks/task timeline, runs/run events and migration
metadata. Later milestones add their tables through numbered migrations. Do not create unused
empty abstractions in M1 merely to match the eventual list.

### Database ownership

- One `rusqlite::Connection` is created by Rust during Tauri setup and owned by
  a native store state behind `Mutex`.
- The connection is never held across an `.await`, model request, Git/process
  execution or frontend event emission.
- Transactions are short and domain-level.
- Start with one connection; add a measured read pool only if paging benchmarks
  prove contention.
- Required pragmas: `foreign_keys=ON`, `journal_mode=WAL`,
  `synchronous=FULL`, `busy_timeout=5000`.
- Migrations are embedded numbered SQL applied transactionally. No ORM or
  migration framework is required for the initial schema.

### Transaction boundaries

At minimum, one transaction covers each:

- migration step plus schema version record;
- task update and its updated timestamp;
- routine occurrence reservation + next schedule + queued run;
- run transition + append-only event + optimistic version increment;
- pending input open/resolve/invalidate + run transition;
- verification result + evidence metadata + run outcome;
- managed-worktree ownership activation/removal metadata.

External process/Git work is never performed while a database transaction is
open. Use prepare/commit compensation:

1. persist intent (`preparing`);
2. perform external setup;
3. persist activation, or persist failure and safely remove only newly-owned
   partial resources.

### Legacy migration

- Source: `xiao-state-v1.json`.
- Canonical database: `<app-data>/xiao-state.sqlite3`.
- Before canonical cutover, atomically finalize an untouched hash-named backup:
  `xiao-state-v1.json.<sha256-prefix>.pre-sqlite.bak`. An interrupted temporary
  backup is never accepted as final and is safely replaced on retry.
- Parse and validate complete input first.
- Import in one transaction.
- Verify workspace/task counts and stable field hashes before commit.
- Record source hash and migration ID so reruns are idempotent.
- Preserve task IDs, title, timestamps, drafts, follow-ups, archive/pin/unread,
  model/reasoning/mode/approval/sandbox, goal, timeline and plan.
- A legacy `threadId` may be retained only in an explicit
  `threadBinding.persistence = legacy-untrusted` record for provenance. The
  process-local runtime `threadId` remains cleared, and the binding is never
  treated as resumable continuity data.
- Corrupt/unsupported input is left untouched and presented as recoverable;
  never replace it with an empty database.
- After successful cutover, do not dual-write JSON and SQLite.
- Older Xiao versions must not overwrite new state; downgrade recovery is a
  documented manual restore from backup.
- Debug builds accept an absolute `XIAO_WORKBENCH_STATE_DIR` only for isolated
  migration verification. Release builds ignore this test override.

## Runtime registry

Default topology proven by M0:

```text
EnvironmentRuntimeRegistry
  windows-local -> one Codex app-server process
      loaded thread A -> active turn A
      loaded thread B -> active turn B
```

Rules:

- one app-server process per execution environment;
- initial global active-run limit: 2;
- one active turn per task/thread;
- FIFO among eligible queued runs;
- a run waiting for approval remains one in-flight slot and stays bound to its
  process generation; with the global limit of 2, one unrelated eligible run can
  still use the remaining slot;
- runtime generation increments on every process start/restart;
- stale-generation responses/events cannot mutate newer runs;
- request map keys are client request IDs; run event routing additionally checks
  thread/turn/item IDs;
- process death fails pending client calls, invalidates inputs and marks active
  runs Interrupted during startup reconciliation;
- no automatic turn resubmission after ambiguous failure.

The M0 live probe showed two threads were active before either completed and all
start/completion events retained their own thread/turn IDs. This supports one
process per environment. Process-per-run is rejected unless future protocol
regression breaks correlation.

## Session continuation

Primary path:

1. Start non-ephemeral Codex thread with Xiao `threadSource`.
2. Persist returned binding only after ID/source validation.
3. Resume by exact stored thread ID after process restart.
4. Validate returned ID/source before attaching it to a run.
5. Never expose/import arbitrary global `thread/list` entries by default.

Fallback path when rollout is missing/incompatible:

- create a new thread and visible child run;
- inject a versioned structured continuation capsule containing goal, plan,
  user-visible user/assistant messages, ordinary attachment references,
  review context, changed-file summary, latest verification evidence and
  unresolved-input explanation;
- mark the lineage boundary in UI;
- never claim native resume succeeded.

A lost in-flight turn is still Interrupted even when its thread can later resume
for a new turn.

## Scheduler algorithm

On startup and each native timer wake:

1. Acquire scheduler leadership inside the single desktop process.
2. Query enabled routines with `nextRunAt <= now`.
3. For each routine in deterministic order, begin transaction.
4. Apply missed-run policy.
5. Insert unique occurrence, queued run and new `nextRunAt` atomically.
6. Commit.
7. Notify RunService that durable queued work exists.

Duplicate timer wake/restart is harmless because occurrence uniqueness rejects a
second reservation. Scheduler does not call the model directly.

DST behavior:

- Recurrence is defined by local wall-clock time plus IANA timezone.
- Spring-forward nonexistent local time runs at the first valid instant after
  the gap.
- Fall-back ambiguous local time runs once at the earlier occurrence.
- Persist `scheduledFor` UTC so reconciliation cannot create both folds.

## Verification execution

- Verification starts only after agent outcome is terminal-completed.
- RunService snapshots the contract before execution.
- Environment executor launches command gates with argv and explicit cwd.
- Timeouts kill the process tree where platform support permits, then report
  blocked with cleanup diagnostic.
- Git/diff gates operate on execution root and recorded baseline.
- Results/evidence are persisted before emitting UI completion.
- Crash during verification marks the attempt/run Interrupted; it never infers
  pass from partial gate records.

## Cancellation, retry and recovery

### Cancellation

Cancellation is idempotent. Native state records cancellation intent before
calling runtime/process interruption. Late completion from the cancelled runtime
generation is evidence only and cannot convert the run to completed.

### Retry

A retry creates a new `Run` with `parentRunId` and a new idempotency key. It may
reuse the safe existing execution root only after explicit policy; routines and
Arena default to a fresh managed worktree.

### Startup reconciliation

In one transaction:

- `preparing`, `running`, `waiting_for_input`, `verifying` from the previous
  process become `interrupted`;
- pending inputs are invalidated;
- queued runs remain queued;
- terminal runs remain unchanged;
- reserved routine occurrences with no run are repaired deterministically;
- stale managed-worktree setup records become inspectable cleanup candidates,
  never automatic unowned deletes.

## Provider boundary

Generic Task/Run/Routine/Gate records contain backend-neutral execution data.
Codex-specific thread/turn/request fields live in ThreadBinding and adapter event
payloads. Future adapters declare capabilities; UI hides/rejects unsupported
operations. Generic abstraction must not erase Codex-native plans, approvals,
rollback or subagent observability.

## Non-negotiable invariants

1. Every run has exactly one canonical environment and execution root.
2. Every active protocol event routes to exactly one run or is ignored/logged as
   unowned; it is never guessed from the currently selected UI task.
3. Every durable status transition and event commit atomically.
4. No terminal run is reopened.
5. No automatic retry after ambiguous dispatch.
6. No approval survives its runtime generation as an actionable callback.
7. No Verified projection without persisted passing gate results.
8. No worktree deletion without database + marker + canonical path + Git proof.
9. No external process work while holding a DB transaction/connection lock.
10. No unbounded event/output/artifact persistence.
11. No renderer timer is authoritative for routine execution.
12. No provider/environment silently falls back to another.
