# Plan 005: M3 — Native durable run queue và recoverable runtime registry

> **Executor instructions**: Chỉ thực hiện M3. Không thêm native routine scheduler,
> recurrence, verification gates, Observatory, WSL hoặc provider adapter. React
> chỉ gửi user intent và project state projection; mọi enqueue, claim, transition,
> cancellation, retry, pending-input routing và crash reconciliation phải do Rust
> sở hữu. Không tự resubmit một turn có kết quả mơ hồ. Không đánh dấu DONE trước
> khi fake-runtime concurrency/recovery matrix, frontend projection matrix và full
> gate đều đạt.
>
> **Operator note**: Các file kế hoạch `.md` của M3 được giữ local để làm
> checklist; không stage hoặc commit chúng nếu người vận hành chưa yêu cầu.
>
> **Drift check**: HEAD `132090c` trên branch
> `feature/m3-durable-run-queue`, tạo trực tiếp từ `dev`. Baseline working tree chỉ
> có `xiao-website/` untracked, không thuộc roadmap và tuyệt đối không chỉnh sửa,
> stage hoặc đưa vào test scope.

## Status

- **Execution status**: DONE — independent lifecycle/recovery review findings resolved and full gate passed
- **Priority**: P0 foundation
- **Effort**: L
- **Risk**: HIGH — process lifecycle, durable dispatch, event correlation và approval safety
- **Depends on**: Plan 004 (DONE)
- **Planned at**: `132090c`, 2026-07-16

## Objective

Chuyển quyền sở hữu run/turn khỏi React sang một `RunService` native có durable
FIFO queue, tối đa hai run đang in-flight toàn cục, tối đa một turn đang active
trên mỗi task, persistent Codex thread theo execution environment và recovery
không tạo duplicate turn sau process crash.

## Baseline verification

Trước khi chỉnh code, branch M3 đã đạt:

- `npm run check` — pass.
- `npm test -- --run` — 9 files / 46 tests pass.
- `npm run build` — pass.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` — pass.
- `cargo test --manifest-path src-tauri/Cargo.toml` — 82 pass, 4 intentional ignored.
- `cargo check --manifest-path src-tauri/Cargo.toml` — pass.

## Fixed decisions and assumptions

- M3 dùng một Codex app-server cho mỗi `execution_environment_id`; không dùng
  process-per-run và không fallback ngầm sang environment khác.
- Global in-flight limit là `2`. `preparing`, `running`, `waiting_for_input` và
  `verifying` chiếm slot; `queued` và terminal states không chiếm slot.
- Queue FIFO theo `(queued_at, id)` trong số run đủ điều kiện. Một task có active
  run khiến mọi run sau của chính task đó chưa đủ điều kiện, nhưng không chặn task khác.
- Run input và toàn bộ execution defaults được snapshot lúc enqueue. Generic task
  save không được ghi đè native run/thread ownership bằng state renderer cũ.
- Initial/follow-up submit đều tạo durable Run. `tasks.follow_ups_json` chỉ còn là
  legacy migration compatibility sau khi callers được chuyển; nó không còn là
  queue authoritative.
- Codex thread mới là non-ephemeral với `threadSource = "xiao-workbench"`.
  Resume chỉ dùng exact Xiao-owned persistent binding và phải kiểm tra ID/source.
- Binding chưa materialized không được resume sau process loss. Resume validation
  failure không tự tạo/submit turn mới; run dừng an toàn và explicit retry tạo
  child Run mới.
- Startup reconciliation trong một transaction đổi mọi
  `preparing|running|waiting_for_input|verifying` thành `interrupted`, invalidate
  unresolved pending inputs, giữ `queued` nguyên trạng và không gọi runtime.
- Raw output/reasoning deltas chỉ live. Durable events chỉ lưu bounded normalized
  payload; không lưu secret answers, auth/env, base64 data URL hoặc raw protocol object.
- Cancellation ghi durable intent trước khi gọi `turn/interrupt`; lặp lại cùng
  request là idempotent. Terminal/late events không thể mở lại run cancelled.
- Pending approval/question callback luôn gắn với
  `(run, environment, generation, request, thread, turn, item)`. UI chỉ resolve
  qua native pending-input ID; không reply trực tiếp request ID cũ.
- M4 vẫn sở hữu routine scheduler. Renderer one-shot schedule hiện tại có thể
  enqueue M3 Run khi đến hạn, nhưng recurrence/timer durability không thuộc M3.
- Existing checkpoint/undo safety được giữ. Durable multi-turn time travel thuộc M6.

## Scope

### In scope

- SQLite migration v3 cho complete Run snapshots, event idempotency và pending inputs.
- Repository APIs cho enqueue/idempotency, FIFO claim, atomic transition+event,
  event paging, cancellation, retry, input lifecycle và startup reconciliation.
- Native `RunService` worker với global concurrency bound và one-turn-per-task.
- `EnvironmentRuntimeRegistry` một app-server/environment, generation-aware routing.
- Persistent thread start/resume/validation/materialization.
- Native protocol route envelopes có `runId`, `taskId`, environment, generation,
  thread, turn và item khi có.
- Safe durable event normalization/bounds và live-only delta emission.
- Typed Tauri commands: enqueue/list/read events/cancel/retry/resolve input.
- Frontend snapshot/event reducer, stale/duplicate/out-of-order guards và per-task projection.
- Switch initial submit/follow-up/cancel/input resolution sang native API.
- Explicit interrupted/failed retry action; inspect giữ nguyên work/timeline.
- Focused Rust fake-runtime/domain/repository tests, frontend pure projection tests
  và isolated restart/crash probe.

### Out of scope

- Native routine tables/timers, daily/weekly recurrence, tray notifications (M4).
- Acceptance contracts, `VerificationAttempt`, gates/evidence execution (M5).
- Persistent full Observatory graph/export/time travel (M6).
- WSL/SSH/container/cloud execution (M7).
- Task Arena hoặc provider-neutral adapter (M8/M9).
- UI redesign, analytics, auto-approval hoặc automatic retry after ambiguity.
- Commit, push, PR hoặc release nếu người vận hành chưa yêu cầu.

## Files allowed

- `src-tauri/Cargo.toml`
- `src-tauri/src/{lib,main}.rs`
- `src-tauri/src/agent/{mod,models,protocol,runtime,service,commands,supervisor}.rs`
- new `src-tauri/src/runs/{mod,models,repository,service,commands}.rs`
- `src-tauri/src/xiao/{models,repository}.rs`
- `src-tauri/src/execution/{models,service}.rs` only for run-bound resolution/ownership linkage
- `src/core/models/{agent,xiao}.ts`
- new `src/core/models/run.ts`
- `src/core/bridges/tauri.ts`
- `src/features/agent/hooks/useAgentRuntime.ts`
- new `src/features/agent/hooks/{runProjection,useNativeRuns}.ts`
- new focused tests beside those hooks
- `src/features/task/task.types.ts`
- `src/features/task/{taskPersistence,taskPersistence.test}.ts`
- `src/features/task/composer/Composer.tsx`
- `src/features/task/workspace/{TaskHeader,TaskWorkspace}.tsx`
- `src/features/task/timeline/{ActivityItem,TaskTimeline,LiveTurnStatus}.tsx`
- `src/features/shell/components/{Sidebar,TitleBar}.tsx` only for per-task run status
- `src/features/focus-rail/components/ExtensionsPanel.tsx` only for native task-scoped agent requests
- `src/app/App.tsx`
- `docs/architecture/{execution-domain,codex-runtime-decisions}.md`
- `README.md` only if shipped behavior text becomes inaccurate
- `plans/001-xiao-trusted-autonomy-roadmap.md`
- `plans/005-m3-native-durable-run-queue.md`
- `plans/README.md`

Anything else requires revising this plan before editing.

## Schema migration v3

Extend `runs` with native snapshots/correlation fields:

```text
execution_environment_id
managed_worktree_id?
input_json                 # exact bounded turn input, not a safe event payload
history_json               # bounded continuation snapshot used only for a new thread
prompt                     # bounded display/user intent
model?
reasoning_effort?
service_tier?
mode
approval_policy
sandbox_mode
thread_id?
thread_source?
cli_version?
runtime_generation?
turn_id?
cancel_requested
```

Extend `run_events` with nullable `event_key` and a partial unique index on
`(run_id, event_key)` for idempotent lifecycle messages.

Create `runtime_generations` keyed by `execution_environment_id`. Allocation is
transactional and monotonic across Xiao/app-server process restarts so reused
Codex thread/turn IDs cannot collide with an earlier generation.

Create `pending_inputs`:

```text
id UUIDv7 primary key
run_id foreign key
runtime_generation
request_id                 # canonical string representation
thread_id
turn_id
item_id
kind                       # command/file/permissions/question/mcp
safe_summary_json
opened_at
resolved_at?
invalidated_at?
unique(run_id, runtime_generation, request_id, thread_id, turn_id, item_id)
```

Migration requirements:

1. Upgrade schema 2 transactionally and record migration 3 in the same transaction.
2. Existing runs receive safe defaults; no task/timeline/worktree record changes.
3. Reopen is idempotent; future schema rejection remains intact.
4. Foreign keys and indexes prove environment/task/worktree ownership.
5. Generic workspace saves preserve native persistent thread binding and cannot
   erase a binding written by RunService using stale renderer data.

## Native state machine and transaction contract

Allowed M3 transitions remain the accepted architecture table:

```text
queued -> preparing | cancelled
preparing -> running | failed | cancelled | interrupted
running -> waiting_for_input | verifying | completed | failed | cancelled | interrupted
waiting_for_input -> running | failed | cancelled | interrupted
verifying -> completed | needs_attention | failed | cancelled | interrupted
needs_attention -> verifying
```

Every transition must:

- validate expected status/version;
- update timestamps/outcomes/version;
- append one bounded event with the next per-run sequence;
- commit both atomically;
- emit to the UI only after commit.

Terminal states never reopen. Agent retry inserts a new row with `parent_run_id`.
`verifying` is transition-valid for M5 tests but M3 dispatch never enters it.

## Queue/worker algorithm

1. On native setup, initialize DB then reconcile stale in-flight rows without
   starting Codex or resubmitting turns.
2. Start one native worker and notify it for startup queued rows and each enqueue/
   terminal/input transition.
3. In a short immediate transaction, count global in-flight rows and select the
   oldest queued row whose task has no in-flight row.
4. Atomically claim `queued -> preparing`; release DB lock.
5. Spawn preparation outside the repository lock and continue claiming until the
   global limit is reached.
6. Revalidate the run's persisted environment/root against M2 native ownership.
7. Ensure exactly one runtime process for that environment; capture generation.
8. Resume a validated loaded/persistent Xiao thread or start a new persistent
   thread and inject the snapshot history.
9. Register route before `turn/start`, persist thread/generation/turn correlation,
   then transition to `running` only with an accepted turn.
10. Terminal/pending events transition atomically and wake the worker when a slot frees.

A crash after claim but before/after ambiguous external dispatch leaves
`preparing|running`; next startup marks it exactly once `interrupted` and never
calls `turn/start` automatically.

## Runtime routing and pending input

- Registry key: `execution_environment_id`.
- Runtime route key: environment + generation + run + thread + active turn;
  item/request identity is additionally checked where protocol provides it.
- Runtime generation increments on every process start/restart.
- Old reader threads and old-generation events are ignored/logged, never persisted
  against a newer run.
- Unknown thread/turn events are bounded diagnostics only; never guessed from
  selected task or most recent run.
- Approval/question open persists pending input and moves `running -> waiting_for_input`.
- Resolve command checks unresolved row and live generation, sends the response,
  then atomically marks it resolved and returns to `running` only when no other
  unresolved input remains.
- Runtime death invalidates all unresolved callbacks for that generation and
  interrupts every attached in-flight run.

## Frontend migration stages

Implement in this order so the branch never needs two lifecycle authorities:

1. **Native API** — add schema/repository/state machine/worker/runtime registry and
   deterministic tests while existing renderer submit remains unchanged.
2. **Adapter/projection** — add typed run models/bridge, per-run reducer and native
   snapshot/event listeners. Tests reject duplicate, out-of-order and stale-generation events.
3. **Switch callers** — initial submit, queued follow-up, cancellation, approval/
   question response and retry call native commands; derive active/tab/sidebar
   state from per-task native snapshots.
4. **Remove obsolete ownership** — remove renderer `turn/start` scheduling,
   `workingTaskId` fallback routing, automatic follow-up submit loop and direct
   stale request replies. Keep only live protocol-to-timeline presentation,
   account/model metadata and non-lifecycle controls.

Renderer may optimistically show one user entry, keyed by the enqueue idempotency
key, but native snapshot/event acknowledgement is authoritative and deduplicates it.

## Required automated cases

### Repository/state machine

- Schema 2 -> 3 and fresh schema apply exactly once.
- Duplicate enqueue idempotency key returns the same run with one queued event.
- queued -> preparing -> running -> completed.
- running -> waiting_for_input -> running -> completed.
- running -> verifying is schema/state-machine valid.
- Invalid transition and stale version leave row/event count unchanged.
- Transition+event rollback is atomic.
- Event sequence monotonic; duplicate `event_key` writes once.
- Safe payload over 64 KiB and diagnostic over 4 KiB are rejected/truncated by policy.
- Queued cancellation and repeated cancellation are idempotent.
- Retry creates one linked child and never reopens parent.
- Startup reconciliation interrupts each in-flight run once, invalidates inputs,
  leaves queued/terminal rows unchanged and is idempotent.

### Scheduler/fake runtime

- Two eligible tasks start concurrently; third remains queued until a slot frees.
- Two runs of one task never overlap and preserve FIFO.
- A waiting approval occupies one slot while an unrelated task uses the other.
- Runtime start/request occurs without holding repository connection lock.
- Persistent new thread is source-tagged and materialized; restart resumes exact ID/source.
- Invalid resume source/ID fails closed before `turn/start`.
- Process loss after ambiguous dispatch produces Interrupted and zero automatic resubmits.
- Exact running cancellation interrupts only matching generation/thread/turn.
- Late old-generation completion cannot mutate a newer run.
- Unowned/mismatched thread/turn/request events never mutate any run.

### Frontend

- Snapshot reducer keeps newest run version regardless of arrival order.
- Duplicate sequence/event does not duplicate user/tool/result timeline entries.
- Stale generation protocol envelope is ignored.
- Two task runs project independently; switching active task does not reroute events.
- Queued/preparing/running/waiting/terminal states map to correct composer/header/sidebar state.
- Optimistic enqueue is reconciled by idempotency key without duplicate user entry.
- Follow-up submit creates a queued native run and survives hook unmount/remount.
- Pending input uses native pending ID; invalidated/stale callback cannot reply.
- Cancel and retry actions target exact run ID.

## Manual isolated verification

Use a debug executable, temporary Git repositories and an absolute
`XIAO_WORKBENCH_STATE_DIR`; never use the real Xiao profile first.

1. Upgrade a schema-2 synthetic/copied-beta DB; verify task/timeline/worktree
   manifests and original legacy JSON/backup remain unchanged.
2. Enqueue three fixture runs on three tasks with limit 2; observe two active and
   one queued, then FIFO promotion.
3. Enqueue two turns for one task plus one unrelated task; verify no same-task overlap.
4. Pause one fixture on approval; close/reload the webview; verify the native run
   remains waiting and the unrelated run progresses.
5. Resolve the exact approval, then attempt the same/stale callback again; second
   response must fail without runtime write.
6. Kill the process after durable claim/ambiguous fake dispatch; restart and verify
   exactly one Interrupted row/event and zero new `turn/start` calls.
7. Cancel queued and running fixtures twice; verify stable terminal snapshots.
8. Restart app-server between completed turns; verify exact Xiao thread ID/source
   resumes and no global `thread/list` entry is imported.
9. Tamper stored source/generation/turn IDs on copied fixtures; routing fails closed.
10. Verify managed/local execution roots, dirty main state and real profile hash remain unchanged.

## Full gate

Run in order:

1. `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
2. focused migration/run repository/state-machine tests
3. focused fake-runtime queue/routing/recovery tests
4. focused frontend run projection tests
5. `npm run check`
6. `npm test -- --run`
7. `npm run build`
8. `cargo test --manifest-path src-tauri/Cargo.toml`
9. `cargo check --manifest-path src-tauri/Cargo.toml`
10. scoped Clippy, documenting only pre-existing warnings
11. isolated executable restart/crash/concurrency probes
12. Windows release compile + NSIS package if runtime process behavior changed
13. `git diff --check`
14. changed-path/privacy/fixture/process-leak scope checks
15. confirm `plans/*.md` remain unstaged/uncommitted per operator instruction

## Completion evidence — 2026-07-17

- Fresh schema and synthetic schema-2 upgrade reached schema 3 transactionally;
  task/timeline data, foreign keys and migration idempotency remained valid.
  Runtime generations persisted monotonically across repository and executable
  restarts; generic renderer saves could neither forge nor erase native persistent
  thread ownership.
- The deterministic Rust matrix passed queue/state transitions, duplicate enqueue,
  FIFO eligibility, limit 2, same-task serialization, waiting input, exact cancel,
  retry lineage, pending-input invalidation, stale generation/turn rejection,
  bounded payloads and startup reconciliation. Final native result: 114 passed,
  4 intentional ignored.
- Frontend projection tests passed newest-snapshot, duplicate/out-of-order sequence,
  stale route, concurrent-task and queued-follow-up selection cases. Final result:
  10 files / 56 tests. Renderer `turn/*`, thread start/resume/inject/delete, direct
  approval replies, `workingTaskId` fallback and automatic follow-up dispatch were removed.
- The continuation audit added red-green regressions for fail-closed ambiguous
  `turn/start`/`turn/interrupt`, full-lifetime protocol-sequence deduplication,
  monotonic pending-input restore, expired approval callbacks, stale list/live
  reconciliation, complete nonterminal run listing and reused-thread late events.
  Durable protocol sanitization now removes secret-bearing fields, data payloads
  and external machine paths before persistence or frontend projection.
- An isolated debug executable used a temporary state root and fake Codex process.
  It observed max active = 2, FIFO promotion, exact same-task non-overlap, one-slot
  approval waiting with two unrelated runs progressing serially, persistent thread
  resume, durable generation increases, and hard-kill recovery with one Interrupted
  event and zero additional `turn/start` calls. Runtime state was also proven to
  stay under the temporary override; no fixture process remained. Post-review
  Windows supervisor probes also passed stdin relay and kill-on-close cleanup of
  both child and grandchild processes after supervisor kill and parent-pipe EOF in
  debug and release builds.
- The real `codex-cli 0.144.5` metadata and live probes passed persistent exact-ID
  resume, concurrent correlated turns, interruption and approval-recovery checks.
- Typecheck, frontend build, Cargo fmt/check/test and scoped Clippy passed. Unscoped
  Clippy reports only the two pre-existing terminal `too_many_arguments` warnings.
  Windows release compilation and explicit NSIS packaging passed; the final
  executable is 16,027,136 bytes and installer is 4,586,605 bytes. Release
  artifacts contain no M3 fixture/state-override names.

## Exit criteria

- [x] React no longer owns any load-bearing run transition or turn dispatch loop.
- [x] Every submit/follow-up has one durable idempotent Run/input snapshot.
- [x] Queue is FIFO among eligible runs, globally bounded at 2 and serial per task.
- [x] One runtime exists per execution environment and all events route by exact generation/correlation.
- [x] Waiting input does not block an unrelated eligible task.
- [x] Cancellation and retry are explicit, exact-ID and idempotent.
- [x] Startup reconciliation creates Interrupted without duplicate turn submission.
- [x] Persistent Xiao thread start/resume validates exact ID/source and never imports global threads.
- [x] Frontend snapshot/event projection passes duplicate/out-of-order/stale tests.
- [x] Webview unmount/reload does not stop native queued/active work while process remains resident.
- [x] Full automated and isolated gates pass.
- [x] M3 status/docs are updated to DONE locally; plan markdown remains uncommitted unless requested.

## STOP conditions

- Any app-server event needed for mutation cannot be assigned to one exact run/task/root.
- Cancellation cannot distinguish an old generation/turn from a newer one.
- Correctness would require restoring a stale approval callback or auto-resubmitting
  an ambiguous turn.
- Renderer remains the only source of truth for any enqueue/transition/input resolution.
- A repository lock must be held across runtime/Git/filesystem work or `.await`.
- Persistent resume can return unrelated/source-mismatched threads without fail-closed validation.
- M3 requires routine recurrence, verification or unrelated redesign to function.
- Any full verification command fails twice after a reasonable scoped correction.
