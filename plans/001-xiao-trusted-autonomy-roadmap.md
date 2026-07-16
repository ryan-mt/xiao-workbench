# Plan 001: Biến Xiao thành workbench local-autonomy có kiểm chứng

> **Executor instructions**: Đây là roadmap cấp chương trình, không phải một PR duy
> nhất. Thực hiện từng milestone theo dependency graph; trước mỗi milestone phải
> tạo một child implementation plan mới trong `plans/` với phạm vi file hẹp hơn,
> test cases cụ thể hơn và drift check tại commit mới nhất. Không bắt đầu milestone
> kế tiếp khi exit gate của milestone hiện tại chưa đạt. Sau mỗi milestone, cập nhật
> bảng trạng thái trong file này và `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 33bfa96..HEAD -- package.json src src-tauri docs README.md CONTRIBUTING.md`
> Nếu code trong phần “Current state” đã thay đổi, đối chiếu lại mọi giả định liên
> quan trước khi lập child plan. Nếu session persistence, runtime ownership hoặc
> scheduler đã được thay mới, dừng và reconcile roadmap thay vì triển khai chồng lên.

## Status

- **Execution status**: IN PROGRESS (M3 next)
- **Priority**: P1
- **Effort**: L — chương trình nhiều milestone; ước lượng đầy đủ ở phần Release roadmap
- **Risk**: HIGH — thay đổi persistence, runtime lifecycle, Git worktree và background execution
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `33bfa96`, 2026-07-16

## Assumptions

Roadmap này dùng các giả định sau. Nếu một giả định sai, áp dụng STOP condition thay vì tự đổi chiến lược:

1. Xiao tiếp tục **Windows-first, local-first, không analytics** trong toàn bộ critical path.
2. Một maintainer chính thực hiện tuần tự; estimate không phải cam kết ngày phát hành.
3. Codex app-server vẫn là backend duy nhất cho tới khi Routines và Verified Done ổn định.
4. Xiao không xây mobile, cloud relay, SSH remote hoặc catalog hàng chục model provider trong roadmap này.
5. Existing beta users phải giữ được project, task, timeline, archive, pin, draft và preferences sau migration.
6. Mỗi milestone phải ship độc lập, có migration/rollback path và không để branch ở trạng thái nửa cũ nửa mới.
7. Background execution phiên bản đầu chạy khi Xiao còn resident trong system tray. Chạy khi process đã thoát hoàn toàn qua Windows Service/Task Scheduler là follow-up, không thuộc critical path.
8. Không có job nào được tự động vượt approval policy. Job cần input phải chuyển sang `waiting_for_input` và thông báo cho người dùng.

## Why this matters

OpenCode đang có lợi thế về provider, agent/plugin ecosystem và nhiều client. T3 Code đang có lợi thế về provider adapters, remote environments và mobile. Xiao đã có scheduled tasks, task goals, plan rail, scoped Git operations, browser, terminal, checkpoints và giao diện Windows-native; lợi thế phù hợp nhất là biến các phần này thành một hệ thống giao việc dài hạn đáng tin cậy.

Hiện scheduler chỉ chạy trong React khi cửa sổ mở, task không gắn với execution root/worktree, runtime có một process/state toàn cục và Codex sessions luôn ephemeral. Nếu thêm automation hoặc parallelism trực tiếp lên nền này, app có nguy cơ chạy trùng job, mất continuity, ghi vào workspace sai hoặc không thể recovery sau crash. Roadmap ưu tiên durability và safety trước, sau đó mới ship Routines, Verified Done, Observatory, WSL và Task Arena.

## Product position

North star:

> **Xiao is local mission control for verified agent work.**

Luồng sản phẩm mục tiêu:

```text
Goal
  -> Acceptance contract
  -> Isolated run(s)
  -> Human approvals when required
  -> Deterministic verification
  -> Evidence
  -> Accept / compare / restore
```

Xiao không được gọi một run là “verified” chỉ vì model trả lời rằng công việc đã xong. Agent outcome và verification outcome là hai trạng thái riêng.

## Competitive baseline captured for this roadmap

Audit snapshot ngày 2026-07-16:

- Xiao: `33bfa96`
- OpenCode `dev`: `1d2a7b4c860f6a29eb90bdda07757b2adf34ab61`, release `v1.18.3`
- T3 Code `main`: `fdca15471d92e95e4ec5501f45dbf3ce81f8d991`, nightly `0.0.29-nightly.20260716.825`

Signals dùng để chọn direction:

- T3 Code vẫn có open request “Scheduled Prompts”: <https://github.com/pingdotgg/t3code/issues/3624>.
- OpenCode vẫn có request cho persistent plan pane: <https://github.com/anomalyco/opencode/issues/37199>.
- OpenCode vẫn có request cho dedicated subagent status/output view: <https://github.com/anomalyco/opencode/issues/37267>.
- T3 Code có request cho cross-provider transcript handoff: <https://github.com/pingdotgg/t3code/issues/3797>.
- Cả hai đối thủ đã có undo/checkpoint primitives nhưng issue trackers vẫn có failure reports; Xiao chỉ nên cạnh tranh nếu recovery có guard và evidence rõ ràng.

## Current state

### Relevant files

- `src-tauri/src/agent/runtime.rs` — owns one Codex child process, stdin and pending request map.
- `src-tauri/src/agent/service.rs` — starts ephemeral Xiao threads and injects reconstructed history.
- `src-tauri/src/xiao/models.rs` — native persisted workspace/task schema, currently version 1.
- `src-tauri/src/xiao/service.rs` — atomic JSON store; clears runtime thread IDs on save/load.
- `src/app/App.tsx` — owns task persistence coordination, schedule state, polling and submission.
- `src/core/models/xiao.ts` — frontend persisted task/workspace types.
- `src/features/task/task.types.ts` — active UI task type; has no execution environment/worktree binding.
- `src/features/agent/hooks/useAgentRuntime.ts` — frontend runtime state machine, protocol projection, checkpoints, compact and undo.
- `src/features/focus-rail/components/SchedulePanel.tsx` — one-shot schedule UI.
- `src/features/focus-rail/components/ChangesPanel.tsx` — Git review/actions and manual worktree creation.
- `src/features/focus-rail/components/ExtensionsPanel.tsx` — Codex skills/plugins/MCP/apps surface.
- `src/features/settings/hooks/useAppPreferences.ts` — browser-local preferences and task defaults.
- `docs/architecture/overview.md` — current React/Tauri/Rust boundary and safety model.

### Evidence excerpts

`src-tauri/src/agent/runtime.rs:23-29` has one child and one stdin:

```rust
pub struct AgentRuntime {
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pending: PendingRequests,
    generation: Arc<AtomicU64>,
    next_id: AtomicU64,
}
```

`src-tauri/src/agent/service.rs:167-181` ignores persisted thread identity and always starts an ephemeral thread:

```rust
fn isolated_thread_start_request(
    workspace_path: &str,
    model: Option<&str>,
    _persisted_thread_id: Option<&str>,
    // ...
) -> (&'static str, Value) {
    (
        "thread/start",
        json!({
            // ...
            "ephemeral": true,
```

`src-tauri/src/xiao/service.rs:35-38` clears thread IDs before persistence:

```rust
pub fn save_workspace(app: &AppHandle, mut document: XiaoWorkspaceDocument) -> Result<(), String> {
    document.workspace_path = normalize_workspace_path(&document.workspace_path);
    clear_runtime_thread_ids(&mut document);
```

`src/features/agent/hooks/useAgentRuntime.ts:357-369` reconstructs only user messages and assistant results; tool events, ordinary file/image attachments, approvals and runtime state are not part of the continuation capsule:

```ts
const historyFromTimeline = (timeline: TimelineEntry[]): XiaoHistoryItem[] =>
  timeline.flatMap<XiaoHistoryItem>((entry) => {
    if (entry.kind === "user" && entry.title.trim()) {
      // ...
    }
    if (entry.kind === "result" && entry.body?.trim()) {
      return [{ role: "assistant" as const, text: entry.body }];
    }
    return [];
  });
```

`src/app/App.tsx:1121-1131` polls schedules in the renderer and processes one due item:

```ts
useEffect(() => {
  const timer = window.setInterval(() => {
    if (pendingScheduledPrompt || !taskStateReady) return;
    const due = scheduledTasks.find((task) => task.status === "pending" && task.runAt <= Date.now());
    // ...
  }, 1000);
```

`src/features/focus-rail/components/SchedulePanel.tsx:27` states the current lifecycle limitation:

```tsx
<p className="rail-section__summary">Runs while Xiao is open. ...</p>
```

`src/features/task/task.types.ts:13-34` stores task/model/thread/mode but no execution environment or task-owned worktree.

`src/features/agent/hooks/useAgentRuntime.ts:686-687` already captures a scoped checkpoint before a turn, and `:1740` rolls back one Codex turn. Preserve these safety semantics while making them durable.

### Existing conventions to preserve

- Frontend is feature-oriented under `src/features`; shared models/bridges live under `src/core`.
- Native host is domain-oriented under `src-tauri/src/<domain>/{commands,models,service}.rs`.
- Privileged filesystem, Git, terminal and runtime work stays behind typed Tauri commands.
- Workspace path scoping is mandatory; model-provided paths must never bypass native validation.
- UI errors are concise; detailed diagnostics belong in runtime logs.
- Existing commits use Conventional Commits, e.g. `feat: add bounded prompt history`.
- Existing behavior changes require tests; Rust domain tests usually live in the module’s `#[cfg(test)]` block, frontend pure behavior uses colocated Vitest files.

## Commands you will need

These commands were verified at `33bfa96`:

| Purpose | Command | Expected on success |
|---|---|---|
| Frontend typecheck | `npm run check` | exit 0, no TypeScript errors |
| Frontend tests | `npm test -- --run` | exit 0; baseline 7 files / 39 tests pass |
| Frontend build | `npm run build` | exit 0; Vite production bundle created |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` | exit 0; baseline 42 tests pass |
| Rust check | `cargo check --manifest-path src-tauri/Cargo.toml` | exit 0, no compiler errors |
| Working tree scope | `git status --short` | only files declared by the active child plan appear |

Every milestone must run all five verification commands before its exit gate can pass. Targeted tests may run during steps, but they do not replace the full gate.

## Scope

### In scope for the complete program

- Durable task/run/routine persistence and migration from current state.
- Per-task execution environment and managed worktree ownership.
- Bounded concurrent run registry and durable queue.
- Tray-resident scheduled and recurring routines.
- Approval pause/resume semantics.
- Acceptance contracts, deterministic gates and evidence.
- Agent/subagent observability and guarded time travel.
- Sanitized local export/import of run handoff data.
- First-class Windows/WSL execution environments.
- Two-candidate Task Arena with deterministic comparison.
- A provider-neutral runtime boundary, followed by one OpenCode/ACP-backed adapter after the Codex path is stable.
- Documentation, migrations and integration tests required by these features.

### Explicitly out of scope

- Mobile apps, hosted web app, cloud account, cloud relay or analytics.
- SSH-managed remote hosts, Tailscale provisioning or public server exposure.
- A direct catalog of dozens of LLM APIs; use runtime adapters instead.
- A full source-code editor, LSP client or formatter platform inside Xiao.
- A Xiao plugin marketplace; continue leveraging runtime Skills/MCP/plugins.
- Automatically approving requests that the selected policy would ask or deny.
- Force-resetting a user workspace, deleting user-created branches/worktrees or overwriting conflicts.
- Automatic merge of Task Arena candidates.
- More Xiao Break games or unrelated visual redesigns.

## Git workflow

- Create implementation branches from current `dev` using `feature/<milestone-slug>` or `fix/<slug>`.
- Target pull requests to `dev`, not `main`.
- Keep one milestone split into reviewable logical PRs; never submit the whole roadmap as one PR.
- Use Conventional Commits, e.g. `feat(runs): persist lifecycle events` or `test(routines): cover missed runs`.
- Do not push, publish a release or open a PR unless the operator explicitly requests it.
- Before each PR, run the full command table and record manual verification steps/screenshots for visible UI changes.

## Target domain model

Exact Rust/TypeScript syntax belongs in the M0 child plan, but the following semantics are fixed unless an ADR explicitly supersedes them.

### ExecutionEnvironment

```text
id
kind: windows | wsl
label
workspaceRoot
wslDistro?         # only for WSL
availability
```

An environment answers “where do agent, Git, filesystem and terminal operations execute?” All operations for one run must use the same environment.

### Task

Existing task fields remain. Add stable execution intent:

```text
executionEnvironmentId
workspaceMode: local | managed-worktree
executionRoot?      # resolved native value, never trusted from model output
acceptanceContractId?
```

### Run

```text
id
taskId
routineId?
parentRunId?
candidateGroupId?
status
agentOutcome?
verificationOutcome?
model / reasoning / mode / approval / sandbox
executionEnvironmentId
executionRoot
threadBinding?
queuedAt / startedAt / finishedAt
```

Required run states:

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

Rules:

- `completed` means agent execution settled; it does not imply verification passed.
- `verificationOutcome` is `not_requested | pending | passed | failed | blocked`.
- Process death while `preparing`, `running` or `verifying` becomes `interrupted` during startup reconciliation. Never silently re-submit a turn.
- A retry creates a new run linked by `parentRunId`; it does not mutate history into pretending the first run never existed.

### RunEvent

Append-only, monotonically sequenced per run:

```text
runId
sequence
timestamp
type
safePayload
```

Persist normalized user-visible events, status transitions, approval lifecycle, tool summaries, token usage, checkpoint/evidence references and failures. Do not persist secrets or unbounded raw process output. Runtime logs may have a separate bounded/redacted storage policy.

### Routine

```text
id
workspacePath
title
prompt
schedule: one-shot | daily | weekly
missedRunPolicy: skip | run-once
runTemplate
acceptanceContractId?
enabled
nextRunAt
lastRunAt?
```

Cron expressions and external event triggers are deferred until one-shot/daily/weekly behavior is stable.

### AcceptanceContract and GateResult

First release gate types:

```text
command         # argv + timeout, no shell string concatenation
diff-scope      # changed paths must match allowed patterns
cleanliness     # explicit staged/unstaged/untracked policy
```

Later gate types, after the relevant infrastructure exists:

```text
browser-snapshot
independent-review
```

Gate execution is native, bounded, cancellable and recorded as evidence. A failed gate never auto-discards work.

### Evidence

```text
runId
type: command-output | diff-summary | patch | screenshot | review | diagnostic
createdAt
summary
artifactReference?
redactionState
```

Large artifacts live in app data with size limits; the database stores metadata and references.

## Persistence decision

M0 must validate the choice, but the default recommendation is:

- Use SQLite in the Rust host as canonical storage for workspaces, tasks, runs, events, routines, gates and managed-worktree metadata.
- Prefer a small synchronous Rust SQLite library compatible with Tauri over introducing an async ORM.
- Keep browser-only preview fallbacks and cosmetic preferences in localStorage until a concrete cross-window consistency need appears.
- Import `xiao-state-v1.json` transactionally once. Keep an untouched backup and migration marker. Do not dual-write JSON and SQLite after cutover.
- All schema changes use numbered migrations and idempotent startup application.

If packaging, locking or Tauri threading tests show the recommended SQLite library is not viable, stop in M0 and record an ADR selecting the smallest proven alternative. Do not fall back to ad-hoc multiple JSON files without review.

## Runtime decision

Default recommendation:

- Keep one Codex app-server process per execution environment.
- Track per-task/per-run thread and turn state in a native registry.
- Start with a global concurrency limit of 2 runs and one active turn per task.
- Only use process-per-run if the M0 probe proves one app-server cannot correlate or execute concurrent threads safely.

Session continuity is an explicit M0 decision gate:

1. Prefer native thread resume if the installed app-server can resume reliably after process restart and Xiao can namespace its threads without unwanted cross-client coupling.
2. Otherwise keep ephemeral isolation but persist a structured continuation capsule including messages, ordinary attachments, review context, goal, plan, changed-file summary, latest verification evidence and unresolved input state.
3. Do not preserve the current ambiguous behavior where the UI stores a `threadId` field but native code always ignores it.

## Dependency graph

```text
M0 Architecture/protocol decisions
 |
 v
M1 Durable store + migration
 |
 v
M2 Task execution environments + managed worktrees
 |
 v
M3 Native run registry + durable queue
 |\
 | +-----------> M6 Observatory + guarded time travel
 |
 v
M4 Routines 2.0
 |
 v
M5 Verified Done
 |\
 | +-----------> M8 Task Arena
 |
 +---- M7 Windows/WSL Bridge
 |
 +---- M9 Provider adapter + OpenCode/ACP handoff
```

Critical path to Xiao’s first defensible product release is **M0 → M1 → M2 → M3 → M4 → M5**. M6 and M7 may proceed in parallel after M3 if separate maintainers are available. M8 must wait for M5. M9 must not delay the Codex-first critical path.

## Release roadmap

Estimate assumes one experienced maintainer working mostly full-time. It includes tests and docs but not store certification or code-signing work. Expect ±50% variance around protocol/WSL unknowns.

| Milestone | Release outcome | Effort | Depends on | Status |
|---|---|---:|---|---|
| M0 | Architecture and protocol decisions locked | M | — | DONE |
| M1 | Durable state preview; no user-visible feature loss | L | M0 | DONE |
| M2 | Safe task-owned execution roots/worktrees | L | M1 | DONE |
| M3 | Recoverable queue and bounded concurrent runs | L | M2 | TODO |
| M4 | Routines Beta | L | M3 | TODO |
| M5 | Verified Autonomy Beta | L | M4 | TODO |
| M6 | Agent Observatory + local handoff bundle | L | M3 | TODO |
| M7 | Windows/WSL Bridge Beta | L | M3, M5 | TODO |
| M8 | Task Arena Beta | L | M2, M3, M5 | TODO |
| M9 | Runtime adapters preview | L | M0, M1, M3 | TODO |

Planning envelope:

- Critical path through M5: roughly 10–16 maintainer-weeks.
- Full roadmap through M9 when done serially: roughly 22–32 maintainer-weeks.
- Do not compress by implementing milestones concurrently in the same files; only parallelize clearly separated domains after M3.

---

# Milestones

## M0 — Lock execution, persistence and protocol decisions

### Objective

Remove the unknowns that could invalidate every later milestone. This milestone changes documentation, protocol fixtures and test harnesses only; it must not switch production persistence or session behavior.

### Deliverables

Create:

- `docs/product/trusted-autonomy.md` — product contract, terminology, non-goals and user flows.
- `docs/architecture/execution-domain.md` — Task/Run/Routine/Environment/Gate model and state transitions.
- `docs/architecture/codex-runtime-decisions.md` — results of resume/concurrency/approval/interrupt probes and chosen runtime design.
- A minimal ignored/live-protocol probe or fixture-based harness under the existing agent test structure. It must not require credentials in ordinary CI.

### Required investigations

1. Verify whether one Codex app-server supports two active threads with correctly correlated events and approvals.
2. Verify persistent thread resume after killing and restarting app-server.
3. Verify behavior when a turn is interrupted during tool execution.
4. Verify whether pending approval/question requests can be reconstructed after process restart; assume they cannot until proven otherwise.
5. Verify exact app-server methods needed for subagent status/control before promising controls in M6.
6. Record maximum practical event/output sizes from representative sessions; use them to choose bounded persistence limits.
7. Benchmark current app startup, workspace load and save with a representative large task history. Store the reproducible fixture shape, not private user data.

### Decision gates

The ADR must choose and justify:

- SQLite library and connection ownership.
- Native thread resume versus structured ephemeral continuation.
- One app-server per environment versus process pool.
- Initial concurrency limit.
- Event payload redaction/size policy.
- Managed worktree root and ownership marker format.

### Verify

- `npm run check` → exit 0.
- `npm test -- --run` → all existing and new fixture tests pass.
- `cargo test --manifest-path src-tauri/Cargo.toml` → all tests pass.
- `rg -n "TBD|TODO|choose later" docs/product/trusted-autonomy.md docs/architecture/execution-domain.md docs/architecture/codex-runtime-decisions.md` → no unresolved load-bearing decision.

### Exit gate

A new-context reviewer can read only the three documents and answer: where state lives, how a run recovers, where commands execute, when a run is verified, and which actions still require a human.

### STOP conditions

- App-server protocol behavior differs by installed version in a way Xiao cannot feature-detect.
- Concurrent threads emit events without enough IDs to correlate safely.
- Native resume exposes or mutates unrelated Codex sessions and no reliable namespace exists.

If any occurs, report evidence and narrow the roadmap before M1.

---

## M1 — Replace transcript JSON persistence with a durable run store

### Objective

Make state transactional, migratable and restart-safe without changing the visible task workflow.

### Deliverables

- Native database initialization and numbered migrations.
- Typed Rust records and Tauri DTOs for workspaces, tasks, runs and run events.
- Transactional import from `xiao-state-v1.json`.
- An untouched migration backup plus migration marker.
- A repository layer with no SQL in Tauri command functions.
- Frontend bridge methods that load/update typed records without whole-store blind overwrite.
- Current task/archive/pin/draft/goal/plan/timeline behavior preserved.
- Explicit session continuation behavior selected in M0.

### Likely in-scope paths for the child plan

- `src-tauri/Cargo.toml`
- `src-tauri/src/lib.rs`
- `src-tauri/src/xiao/models.rs`
- `src-tauri/src/xiao/service.rs`
- new persistence files under `src-tauri/src/xiao/` or a dedicated native persistence domain chosen in M0
- `src/core/models/xiao.ts`
- `src/core/bridges/tauri.ts`
- `src/app/App.tsx`
- persistence tests and migration fixtures

Do not mix scheduler or worktree behavior into M1.

### Required behavior

1. Fresh install creates the latest schema exactly once.
2. Existing valid JSON imports all user-visible fields.
3. Duplicate canonical workspace paths merge with the same semantics as current `normalize_store_paths`.
4. Invalid/corrupt legacy JSON does not overwrite or delete the original file; UI receives a recoverable diagnostic.
5. Re-running migration is idempotent.
6. A write interrupted before commit leaves the previous committed state intact.
7. Runtime-only fields are modeled explicitly rather than silently cleared by a generic save function.
8. Frontend can load a large history incrementally or by bounded page; do not force every project transcript into one startup payload.

### Verify

- Add migration tests for empty, valid, duplicate-path, corrupt, interrupted and already-migrated cases.
- Add round-trip tests for every persisted task field.
- `cargo test --manifest-path src-tauri/Cargo.toml` → all migration/repository tests pass.
- Full command table → all pass.
- Manual beta fixture migration → task count, titles, archive/pin/drafts/timelines match before and after.

### Exit gate

`xiao-state-v1.json` is no longer the active source of truth; restarting Xiao repeatedly preserves state and migration never duplicates tasks or runs.

### STOP conditions

- Migration requires dropping any current user-visible field.
- Database library forces unsafe shared-connection use across threads.
- Frontend must dual-write legacy JSON and SQLite for more than a temporary migration transaction.

---

## M2 — Bind every task to an execution environment and safe worktree

### Objective

Ensure every filesystem, Git, terminal and agent action has one explicit execution root, and allow Xiao-owned isolated worktrees without touching user-owned worktrees.

### Deliverables

- `ExecutionEnvironment` and task execution fields in native/frontend models.
- Local workspace mode remains default for migrated tasks.
- Managed-worktree mode creates a Xiao-owned branch/path under the M0-selected app-data root.
- Ownership metadata distinguishes Xiao-managed worktrees from manually created worktrees.
- New interactive tasks can choose Local or Isolated Worktree. Routine-created environment selection remains deferred to the M4 native scheduler; renderer-scheduled tasks stay Local until then.
- Git, terminal and agent APIs receive resolved execution root from native state, not arbitrary frontend/model input.
- Cleanup UI lists disk usage and requires explicit confirmation.

### Safety invariants

- Never delete a worktree without a valid Xiao ownership marker and matching database record.
- Never run `git reset --hard` against the user’s main workspace as cleanup.
- Worktree branch names include collision-resistant run/task identity.
- A dirty main workspace does not block creation of an isolated run unless Git itself cannot create the worktree safely.
- Non-Git projects remain usable in Local mode; routines must explain that isolation is unavailable.
- Existing manual worktree controls in `ChangesPanel` remain visible but are not treated as Xiao-owned.

### Likely in-scope paths

- `src-tauri/src/git/{commands,models,service}.rs`
- `src-tauri/src/xiao/{models,service}.rs`
- new execution-environment/worktree service files following native domain conventions
- `src/core/models/{workspace,xiao}.ts`
- `src/core/bridges/tauri.ts`
- task creation/composer/settings UI
- focused Git/worktree tests

### Verify

- Tests: create, reopen, collision, non-Git fallback, dirty main tree, ownership mismatch, cleanup refusal, path traversal and stale DB record.
- Test that terminal cwd, Git root and agent writable root are identical for one run.
- Full command table → all pass.
- `git status` of a fixture main workspace remains unchanged after an isolated run setup/cleanup cycle.

### Exit gate

Every interactive task can report one canonical environment and execution root, and Xiao can prove whether it owns a worktree before offering deletion. Durable run snapshots remain M3 work.

### STOP conditions

- A worktree path cannot be canonicalized inside the managed root.
- Existing Git scoping tests fail when execution root differs from project root.
- Cleanup would require deleting a branch/worktree Xiao cannot prove it created.

---

## M3 — Move run ownership and scheduling into a native durable queue

### Objective

Remove run lifecycle ownership from React, support bounded concurrency and guarantee crash reconciliation without duplicate submissions.

### Deliverables

- Native `RunService`/registry with persisted state transitions.
- Durable FIFO queue with one active turn per task and global concurrency limit selected in M0 (recommended: 2).
- Native event emission keyed by `runId`, `taskId`, `threadId` and `turnId` when available.
- Frontend derives state from native run snapshots/events instead of one global `AgentRuntimeState`.
- Startup reconciliation converts in-flight runs to `interrupted`; user explicitly chooses retry or inspect.
- Cancellation is idempotent.
- Follow-ups become queued run input, not renderer-only mutable state.
- One run waiting for approval does not block an unrelated eligible run.

### Required state-machine tests

- queued → preparing → running → completed.
- running → waiting_for_input → running → completed.
- running → verifying is reserved until M5 but schema transition is valid.
- queued cancellation.
- running interruption.
- process crash/restart reconciliation.
- duplicate enqueue request with same idempotency key.
- two eligible tasks run concurrently up to the limit; third stays queued.
- two turns for the same task never overlap.
- late event from an old runtime generation cannot mutate a newer run.

### Likely in-scope paths

- `src-tauri/src/agent/{runtime,service,commands,models}.rs`
- new native run domain files
- `src-tauri/src/lib.rs`
- `src/core/models/agent.ts`
- `src/core/bridges/tauri.ts`
- `src/features/agent/hooks/useAgentRuntime.ts` or its replacement split into smaller hooks
- `src/app/App.tsx`
- task/sidebar status projections

The child plan must split large frontend state changes into: add native API, add adapter/projection, switch callers, then remove obsolete renderer ownership.

### Verify

- Deterministic native tests use fake runtime/events; ordinary CI must not call live Codex.
- Frontend projection tests cover out-of-order, duplicate and stale events.
- Kill Xiao during a fixture run, restart, and confirm exactly one interrupted run and zero automatic duplicate turns.
- Full command table → all pass.

### Exit gate

Closing/reopening the window while the process stays resident does not affect active runs, and a process restart never silently resubmits work.

### STOP conditions

- Event payloads cannot be correlated to a task/run under the runtime design selected in M0.
- Cancellation cannot distinguish an old turn from a newer turn.
- Renderer remains the only source of truth for any load-bearing run transition.

---

## M4 — Ship Xiao Routines 2.0

### Objective

Turn the existing schedule panel into the first defensible Xiao feature: durable, safe, isolated local routines.

### Version-one scope

- One-shot, daily and weekly schedules.
- Local timezone with explicit display; persist canonical timestamps plus timezone identifier where recurrence needs it.
- Missed-run policy: `skip` or `run-once`.
- Enable, disable, edit, run-now and delete.
- Run template: prompt, model, reasoning, mode, approval, sandbox, environment/workspace mode and optional acceptance contract.
- Tray residency and desktop notifications.
- Approval/question/error pauses with deep-link back to the exact run.
- Isolated worktree default for Git projects.
- Run history and next-run preview.

### Deferred from version one

- Arbitrary cron syntax.
- File/Git/PR/webhook triggers.
- Cloud execution.
- Running after the Xiao process has fully exited.
- Auto-commit, auto-push or auto-PR.

### Required scheduler semantics

- Persist next occurrence before dispatching work so restart cannot duplicate it.
- Use a unique occurrence/idempotency key.
- DST transition behavior is documented and tested.
- `run-once` creates at most one catch-up occurrence regardless of how many intervals were missed.
- Editing a routine never mutates historical runs.
- Deleting a routine does not delete its run history or worktrees.
- A routine with `on-request` approval may start, but pauses at the first request and notifies the user.
- A routine with dangerous-full-access requires an explicit confirmation at creation and shows a permanent warning badge.

### UI work

Replace the current `ScheduledTask` renderer-local type with native `RoutineSummary` and `RunSummary`. Preserve the Focus Rail entry, but add:

- routine list grouped by enabled/paused;
- next run and last result;
- compact run history;
- “needs attention” state;
- explicit isolation, sandbox and approval labels;
- a creation flow that defaults to safe values and reuses existing task run defaults.

### Verify

- Fake-clock tests: future, due, disabled, DST forward/back, missed skip, missed run-once, edit, delete and restart.
- Idempotency test across two startup reconciliation passes.
- Notification/deep-link projection tests without relying on OS delivery.
- Manual tray test on Windows: close window, due routine runs, notification opens exact run.
- Full command table → all pass.

### Exit gate

A user can create a daily isolated routine, close the Xiao window, receive a completion or input-required notification, reopen the exact run and see one—never two—occurrences.

### STOP conditions

- Tray close semantics terminate the process on supported Windows packaging.
- OS notification click cannot carry a safe run identifier.
- Scheduler requires auto-approval to make progress.

---

## M5 — Ship Verified Done and evidence cards

### Objective

Make completion trustworthy by evaluating explicit deterministic acceptance gates and preserving evidence independently from agent prose.

### Version-one gate types

1. **Command gate**
   - argv array, cwd fixed to execution root, timeout, expected exit code.
   - no user/model string concatenation into a shell command.
2. **Diff-scope gate**
   - allowed and denied path patterns.
   - reports every out-of-scope changed path.
3. **Cleanliness gate**
   - explicit policy for staged, unstaged and untracked files.

### Lifecycle

```text
agent settles
  -> run status verifying
  -> gates execute in declared order
  -> evidence persisted per gate
  -> verification passed | failed | blocked
  -> run completed or needs_attention
```

A command timeout, missing tool or invalid contract is `blocked`, not a false test failure. A gate failure never discards work. Retrying verification does not rerun the agent.

### UI requirements

- Optional Acceptance Contract editor on task/routine.
- Presets generated from verified repository scripts only; user confirms before saving.
- Timeline evidence card with command, duration, exit status and bounded output.
- Diff-scope evidence lists violating paths.
- Header/sidebar distinguish `Done`, `Verified`, `Verification failed` and `Needs attention`.
- One-click rerun verification.
- One-click open changes; no one-click destructive rollback in the failure card.

### Later extensions, not part of M5 implementation

- Browser screenshot/DOM gates after preview automation exists.
- Independent AI review gate; it must remain advisory unless paired with deterministic requirements.
- Performance budget gates.

### Verify

- Tests: pass, non-zero exit, timeout, missing binary, cancellation, output truncation, allowed/denied path precedence, binary/untracked changes and rerun idempotency.
- Security test: command arguments containing shell metacharacters are passed literally, not executed as a second command.
- Recovery test: process death during verification becomes interrupted/blocked and never reports passed.
- Full command table → all pass.

### Exit gate

A routine can finish agent work, fail a deterministic test, remain safely inspectable, rerun verification without rerunning the model, and later become Verified after the user or agent fixes the issue.

### STOP conditions

- Verification commands cannot be launched without an unrestricted shell string.
- Gate execution cwd can differ from the run’s canonical execution root.
- UI still uses agent completion as a synonym for verification success.

---

## M6 — Add Agent Observatory, guarded time travel and local handoff bundles

### Objective

Give users a dedicated, low-noise view of agent/subagent activity and a safe historical record without exposing raw protocol noise or pretending unsupported controls exist.

### Version-one Observatory

- Parent/child agent graph built from normalized collaboration events.
- Status, model, elapsed time, latest safe action summary and token usage when available.
- Pending approvals/questions visible at the owning child/run.
- Jump from graph node to corresponding timeline activity.
- Historical run event stream with filters for status, tools, approvals, changes and verification.
- Read-only first; pause/steer/cancel controls appear only after M0 proves exact supported methods and M6 adds tests.

### Guarded time travel

- Persist per-turn patches and before/after workspace fingerprints.
- Allow restoring to an earlier turn only by applying checked reverse patches in newest-to-oldest order.
- Run `checkOnly` for the whole restore plan before applying the first patch.
- Abort without partial application if any check fails.
- Never force reset, drop commits or overwrite changes created after the target fingerprint.
- Keep existing latest-turn Undo as the simple default action.

### Local handoff bundle

Export a versioned archive containing only selected/sanitized data:

- task goal and user-visible transcript;
- structured continuation summary;
- selected attachments by explicit opt-in;
- changed-file/diff summaries;
- acceptance contract and evidence;
- runtime/provider metadata needed for diagnosis, excluding credentials;
- schema manifest and hashes.

Import creates a new task/run lineage; it never overwrites an existing task or applies a patch automatically.

### Verify

- Agent graph tests for spawn, nested child, wait, resume, failure, close and missing optional IDs.
- Event redaction and size-bound tests.
- Time-travel tests for clean restore, conflict, changed-after-run, multi-turn order, binary patch and no-partial-apply guarantee.
- Export tests confirm configured sensitive fields and absolute private paths are removed or explicitly represented as redacted.
- Import tests reject path traversal, invalid hashes, unknown mandatory schema and oversized archives.
- Full command table → all pass.

### Exit gate

A user can understand which agent did what, inspect evidence for a historical run, export a sanitized handoff and safely restore clean turn patches without destructive Git commands.

### STOP conditions

- Subagent events cannot be assigned to a stable parent/run.
- A proposed control method is undocumented or cannot be confirmed with protocol fixtures.
- Multi-turn restore cannot guarantee all checks pass before any workspace mutation.

---

## M7 — Add first-class Windows/WSL execution environments

### Objective

Make Xiao the lowest-friction Windows agent workbench by treating Windows and WSL as explicit execution environments while keeping one native UI.

### Version-one scope

- Detect installed/running WSL distributions through `wsl.exe` without requiring a remote Xiao server.
- Add a WSL environment with selected distro and Linux workspace path.
- Canonical path conversion for UI display/open operations only; native operations route to the environment executor.
- Agent, Git and terminal for a WSL run all execute inside the same distro/root.
- Detect Codex and shell availability per environment.
- Surface clear environment health and remediation.
- Discover localhost dev-server URLs emitted by a WSL terminal/run and open them in Xiao’s browser through Windows-accessible localhost when supported.

### Architecture boundary

Introduce an environment command executor rather than scattering `wsl.exe` branches across Git, agent and terminal modules. Windows local behavior remains one implementation; WSL is another. Frontend never constructs WSL shell command strings.

### Deferred

- SSH hosts, arbitrary Linux servers or containers.
- Automatic package/runtime installation inside WSL.
- Multi-distro worktrees for one task.
- Public network exposure.

### Required tests

- Pure path conversion fixtures: spaces, Unicode, drive roots, UNC rejection, `\\wsl$`/`\\wsl.localhost` forms and already-Linux paths.
- Command argv escaping; no shell interpolation.
- Missing/stopped distro, missing Codex, missing Git, invalid root and distro removal.
- Environment consistency: agent/Git/terminal receive identical distro/root.
- Port URL normalization and unreachable server behavior.
- Windows local regression suite remains green.

### Manual matrix

At minimum test:

- Windows 11 + current default WSL distro.
- Workspace under Linux filesystem.
- Workspace under mounted `/mnt/c` path.
- Paths with spaces and non-ASCII characters.
- Codex authenticated and unauthenticated inside WSL.

### Exit gate

A user can open a WSL repository, run an isolated task, use its terminal/Git/browser, verify it and return after restart without manually starting a server or translating paths.

### STOP conditions

- Any operation silently falls back from WSL to Windows.
- Canonical root cannot be proven before a privileged operation.
- PTY support would require replacing the existing Windows terminal path without an isolated adapter boundary.

---

## M8 — Ship two-candidate Task Arena

### Objective

Run the same task as two isolated candidates, compare deterministic evidence and let the user choose without automatic merging.

### Version-one scope

- Exactly two candidates per arena.
- Codex backend only; candidates may differ by model, reasoning effort or prompt variant.
- Each candidate gets its own managed worktree and run lineage from the same baseline commit/fingerprint.
- Shared acceptance contract executes independently.
- Comparison shows verification outcome, changed files, diff stats, elapsed time, token usage and warnings.
- User may open either candidate, keep one worktree, or discard a Xiao-owned loser after confirmation.
- Optional AI comparison is clearly labeled advisory and cannot override deterministic gate results.

### Preconditions

- Base repository must support two managed worktrees.
- Baseline must be stable and recorded before candidate creation.
- Estimated cost/runs are shown before launch.
- Arena refuses to start if it cannot create both isolated roots safely.

### Deferred

- Three or more candidates.
- Cross-provider competitions.
- Automatic patch synthesis/merge.
- Ranking based only on an LLM judge.
- Running candidates against different baselines.

### Verify

- Baseline identity and isolation tests.
- One candidate fails setup: the other is not mislabeled winner and cleanup remains safe.
- One candidate fails verification, one passes.
- Both pass with different diffs.
- Cancellation of one/all candidates.
- Cost/evidence aggregation without double counting.
- Worktree ownership and cleanup safeguards from M2 remain enforced.
- Full command table → all pass.

### Exit gate

A user can launch two variants from one task, receive side-by-side deterministic evidence, inspect both and keep one without either candidate touching the main workspace.

### STOP conditions

- Both candidates cannot be tied to the exact same baseline.
- Concurrency can route an event/approval to the wrong candidate.
- Choosing a winner would require automatic merge or destructive checkout.

---

## M9 — Add a provider-neutral runtime boundary and one OpenCode/ACP adapter

### Objective

Gain provider breadth without rebuilding OpenCode’s model catalog and without weakening Codex-native capabilities.

### Boundary to define early, implement late

M0/M1 types must avoid hard-coding Codex into generic Task/Run/Routine/Gate records. M9 introduces or completes an adapter interface covering:

- availability/account/model discovery;
- start/resume/send/steer/interrupt;
- normalized messages/tool activities/changes/plans/usage;
- approvals and user questions;
- capabilities and unsupported-feature reporting;
- continuation/handoff metadata.

Codex remains the reference adapter. Unsupported capabilities are explicit; UI does not render controls an adapter cannot apply.

### First additional adapter

Prefer an OpenCode server/SDK or standards-based ACP integration after a spike confirms lifecycle parity. This provides broad model/provider access with one backend integration. Do not copy OpenCode’s internal provider engine into Xiao.

### Cross-runtime handoff

Switching backend creates a new run with a structured handoff capsule and lineage. It does not pretend the target runtime resumed the source runtime’s private session. The UI shows the handoff boundary.

### Deferred

- Direct API-key management for every model vendor.
- Multiple new adapters in one release.
- Silent mid-turn provider switching.
- Claims of capability parity when the target protocol lacks approvals, plans, rollback or subagents.

### Verify

- Contract tests run against fake Codex and fake secondary adapters.
- Capability matrix controls UI visibility and rejects unsupported operations natively.
- Handoff preserves goal, selected transcript/context, attachments, acceptance contract and baseline while excluding secrets.
- Adapter failure cannot corrupt generic run history.
- Existing Codex behavior and full command table remain green.

### Exit gate

A user can deliberately hand a task from Codex to one supported secondary runtime, see the lineage boundary and continue through the same Run/Verification/Evidence lifecycle.

### STOP conditions

- The chosen secondary protocol cannot correlate sessions/events reliably.
- Integration requires storing provider secrets in Xiao’s transcript database.
- Generic abstractions would remove Codex-specific capabilities instead of expressing them through capability flags.

---

## Cross-cutting test strategy

Every child plan must map new behavior to the lowest reliable test layer:

### Rust unit/domain tests

Use for:

- migrations and repository transactions;
- state machines and scheduler calculations;
- path/worktree validation;
- command execution boundaries;
- redaction, size limits and archive validation;
- startup reconciliation and idempotency.

### Frontend unit/component tests

Use for:

- native snapshot/event projection;
- routine and run presentation states;
- acceptance contract validation before invoke;
- agent graph layout/model;
- capability-driven controls;
- notification/deep-link routing.

### Native integration tests with fakes

Add deterministic fake runtime/process/event streams for:

- concurrent runs;
- approvals/questions;
- crash/restart;
- stale event generations;
- verification and cancellation.

Ordinary CI must not require a logged-in Codex account or network.

### Opt-in live protocol tests

Use only for M0 protocol compatibility and pre-release smoke tests. Gate behind an explicit environment flag, never run automatically on contributor machines, and never print credentials or private transcript data.

### Manual Windows release matrix

For releases after M3, test at minimum:

- fresh install;
- upgrade from current beta state;
- app restart during idle and active run;
- tray close/reopen;
- notification click;
- dirty repository;
- non-Git workspace;
- long path and Unicode path;
- installer/uninstaller preserving user data.

Add WSL cases after M7 and two-candidate cases after M8.

## Migration and rollout strategy

1. **M1 validation (DONE)**: an explicit debug-only state root isolated synthetic and copied-beta executable probes before production cutover.
2. **No separate preview writer**: migration errors are recoverable and source-preserving; copied-fixture manifests provide the read-only comparison without adding a second production path.
3. **Single cutover (DONE)**: import transactionally, verify counts/hashes, then mark SQLite canonical. Keep original JSON and its immutable backup.
4. **No automatic downgrade writes**: an older app must not overwrite newer state. Document downgrade recovery.
5. **M3 queue preview**: keep concurrency limit at 1 for one release if necessary, then raise to 2 after crash/correlation soak tests. The architecture must already support the bound.
6. **M4 Routines Beta**: safe defaults, recurring schedules opt-in, no external triggers.
7. **M5 Verified Beta**: contracts optional at first; routine templates can require them after stability.
8. **M6–M9**: each major feature carries a capability/preview label until release matrix and migration gates pass.

## Success criteria

### Program-level safety

- No startup/retry path can submit the same occurrence twice.
- Every privileged operation resolves and validates one canonical execution root in Rust.
- No Xiao cleanup path deletes an unowned worktree/branch.
- Pending approvals are never auto-allowed because the UI is closed.
- Crash recovery never reports an interrupted run as completed or verified.
- Arena candidates never share a writable execution root.

### Program-level product behavior

- Routines survive window closure and process restart without duplicate execution.
- Users can distinguish agent completion from verification success everywhere status appears.
- Every Verified run has persisted, inspectable evidence.
- Every task/run shows its execution environment and isolation mode.
- Every retry/handoff/candidate has visible lineage.
- Users can inspect and recover work without reading raw runtime logs.

### Performance guardrails

M0 records reproducible baselines. Later milestones must:

- avoid loading all project transcripts/events at startup;
- page or bound run-event and artifact queries;
- cap persisted raw output and UI-rendered event counts;
- document and test worktree/artifact cleanup;
- investigate any startup or active-stream regression greater than 20% against the M0 fixture before release.

No analytics may be added to measure adoption. Use opt-in user feedback, issue reports and reproducible local diagnostics.

## Full roadmap done criteria

All must hold before marking Plan 001 DONE:

- [ ] M0 through M9 exit gates are complete or an explicit ADR marks a milestone REJECTED with rationale.
- [ ] `npm run check` exits 0.
- [ ] `npm test -- --run` exits 0 with new lifecycle/UI tests.
- [ ] `npm run build` exits 0.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` exits 0 with migration, scheduler, run, worktree, verification and recovery tests.
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml` exits 0.
- [ ] Upgrade from a copy of `xiao-state-v1.json` preserves all user-visible task data.
- [ ] Process-kill/restart does not duplicate a queued/running routine occurrence.
- [ ] A routine requiring approval pauses and reopens at the exact request.
- [ ] A deterministic failed gate cannot be displayed as Verified.
- [ ] Managed-worktree cleanup refuses unowned paths.
- [ ] Windows local release matrix passes; WSL matrix passes if M7 shipped.
- [ ] Two Task Arena candidates remain isolated and are never auto-merged.
- [ ] Export/import redaction and archive validation tests pass.
- [ ] No analytics, cloud dependency or unrestricted new command endpoint was introduced.
- [ ] Public README, architecture docs, release notes and contributor verification commands reflect shipped behavior.
- [ ] `plans/README.md` and this milestone table are updated.

## Global STOP conditions

Stop the active milestone and report; do not improvise if:

- Live code no longer matches a load-bearing Current state excerpt.
- A migration cannot prove preservation before making the new store canonical.
- Correct behavior requires bypassing approval/sandbox/workspace scoping.
- A run/event cannot be correlated to one task and execution root.
- A worktree mutation cannot prove Xiao ownership.
- A verification command would require unsafely concatenating a shell string.
- A restore operation cannot preflight all patches before the first mutation.
- A milestone starts requiring mobile, cloud, remote SSH or a direct multi-provider engine.
- Any full verification command fails twice after a reasonable scoped correction.
- Implementing the milestone requires unrelated redesign/refactoring outside its child plan.

## Maintenance notes

- Keep generic Run/Routine/Verification records provider-neutral, but do not flatten away adapter-specific capabilities.
- Schema migrations are permanent maintenance surfaces; every persisted field change needs forward migration and downgrade documentation.
- Treat event and artifact size limits as product contracts; unbounded logs will eventually become a reliability issue.
- Runtime protocol changes must update fixtures before production parsing code.
- Worktree ownership markers and cleanup rules deserve security-level review.
- Time travel remains patch-based and guarded; never evolve it into hidden force-reset behavior.
- Routine recurrence, DST and missed-run semantics must remain documented and stable across releases.
- When visual/browser gates are added later, reuse AcceptanceContract/Evidence rather than creating a parallel verification system.
- When another provider is added, require the same adapter contract tests and explicit capability matrix.

## Findings deliberately deferred or rejected

- **Full mobile/remote stack**: rejected for this roadmap because T3 Code already owns that race and it would delay Xiao’s local differentiation.
- **Direct support for dozens of model APIs**: rejected; integrate one agent runtime/protocol instead.
- **Full IDE/LSP/editor**: rejected; Xiao should open a preferred editor and remain a workbench.
- **Plugin marketplace**: deferred until Routines/Verification extension points show repeated real demand.
- **Arbitrary cron and external triggers**: deferred until simple recurrence is proven restart-safe.
- **Automatic Arena merge**: rejected for initial versions because deterministic verification does not guarantee semantic merge correctness.
- **Windows Service/Task Scheduler execution while Xiao is fully exited**: deferred; tray residency is the smallest safe first release.
- **Additional Xiao Break investment**: rejected until the critical autonomy path is stable.
