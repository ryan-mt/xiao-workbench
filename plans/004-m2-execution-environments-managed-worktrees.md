# Plan 004: M2 — Execution environments và managed worktrees an toàn

> **Executor instructions**: Chỉ thực hiện M2. Không thêm durable queue, native
> scheduler, persistent Codex resume, routine dispatch hoặc verification. Mọi
> agent/Git/terminal/filesystem operation thuộc task phải resolve root từ native
> state. Không xóa worktree nếu thiếu bất kỳ ownership proof nào. Không đánh dấu
> DONE trước khi safety matrix, hard-failure cleanup và full gate đều đạt.
>
> **Drift check**: HEAD `d13293e` trên `dev`, khớp `origin/dev`. Working tree chỉ
> có `xiao-website/` untracked, không thuộc roadmap và tuyệt đối không chỉnh sửa,
> stage hoặc test như một phần M2.

## Status

- **Execution status**: DONE
- **Priority**: P0 foundation
- **Effort**: L
- **Risk**: HIGH — filesystem/Git deletion boundary
- **Depends on**: Plan 003 (DONE)
- **Planned at**: `d13293e`, 2026-07-16

## Objective

Mỗi task/run tương tác phải có đúng một Windows-local execution environment và
một canonical execution root do Rust resolve. Task có thể chạy trong project
Local hoặc Xiao-owned isolated Git worktree; Xiao chỉ cho cleanup khi database,
marker, canonical managed path và Git evidence cùng khớp.

## Fixed decisions and assumptions

- M2 chỉ có environment kind `windows`; WSL thuộc M7 và không có fallback ngầm.
- Existing/migrated tasks và task tương tác mới mặc định `local`.
- `managed-worktree` chỉ khả dụng khi project nằm trong Git repository có HEAD.
- Durable Run chưa tồn tại tới M3. Branch M2 dùng
  `xiao/<task-short>/<worktree-short>`; worktree UUID là collision-resistant
  placeholder cho run identity, không giả lập Run record.
- Nested workspace trong parent repository được hỗ trợ: Git checkout chứa toàn
  repository nhưng execution root là cùng relative workspace prefix bên trong
  checkout.
- Dirty main workspace không bị stash/reset/checkout và không cản worktree nếu
  `git worktree add` từ committed HEAD thành công.
- Existing manual `add_git_worktree` UI vẫn hoạt động, được gắn nhãn unowned và
  không bao giờ xuất hiện như Xiao-managed ownership proof.
- Switching từ managed về Local là destructive cleanup intent: UI phải hiển thị
  path, bounded disk usage và dirty-state warning, rồi yêu cầu confirmation.
- Không auto-delete stale/preparing/removing records trên startup. Chúng là
  inspectable diagnostics cho tới khi một explicit safe recovery path được chứng
  minh.
- Release build bỏ mọi debug failpoint/state override như M1.

## Scope

### In scope

- SQLite migration v2:
  - stable public workspace IDs;
  - one local execution environment per workspace;
  - task execution environment/workspace mode/managed binding;
  - managed-worktree ownership records and lifecycle constraints.
- Typed Rust/TypeScript execution context and managed-worktree DTOs.
- Native environment resolver for local and managed roots.
- Prepare → external Git setup → activate compensation workflow.
- Active → removing → external Git cleanup → removed workflow.
- Versioned ownership marker outside checkout, atomically written.
- Four-way deletion proof: DB + marker + canonical path + Git worktree evidence.
- Task-scoped root routing for agent, turn sandbox roots, Git, terminal,
  checkpoint/undo and workspace file APIs.
- Minimal task workspace-mode control plus explicit cleanup confirmation showing
  bounded disk usage.
- Existing manual worktree controls preserved and clearly unowned.
- Focused migration, repository, Git, routing, frontend and executable tests.

### Out of scope

- Durable Run queue/state machine or concurrency changes.
- Routine-created task UI/dispatch; M4 consumes the M2 defaulting API.
- WSL, SSH, containers or cloud execution.
- Worktree merge/rebase/automatic commit/push/PR behavior.
- Automatic stale-record deletion.
- Changing approval/sandbox policy semantics.
- Commit, push, PR or release unless explicitly requested after M2 gate.

## Files allowed

- `README.md`
- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `src-tauri/src/lib.rs`
- new `src-tauri/src/execution/{mod,models,service,commands}.rs`
- `src-tauri/src/xiao/{mod,models,repository,service}.rs`
- `src-tauri/src/git/{commands,models,service}.rs`
- `src-tauri/src/workspace/{commands,models,service}.rs`
- `src-tauri/src/terminal/{commands,runtime}.rs`
- `src-tauri/src/agent/{commands,runtime,service}.rs`
- `src/core/models/{workspace,xiao}.ts`
- `src/core/bridges/tauri.ts`
- `src/features/workspace/hooks/useWorkspace.ts`
- `src/features/agent/hooks/{agentProtocol,agentProtocol.test,useAgentRuntime}.ts`
- `src/features/task/{task.types,taskPersistence,taskPersistence.test,taskEnvironment,taskEnvironment.test,taskFork,taskFork.test}.ts*`
- `src/features/task/composer/Composer.tsx`
- `src/features/task/workspace/{TaskWorkspace,TaskHeader}.tsx`
- `src/features/task/styles/task.css`
- `src/features/focus-rail/components/{FocusRail,ChangesPanel,FilesPanel,OpenFilePanel,TerminalPanel,ExtensionsPanel}.tsx`
- `src/app/App.tsx`
- focused new tests colocated with these domains
- `docs/architecture/{execution-domain,codex-runtime-decisions}.md`
- `docs/product/trusted-autonomy.md`
- `plans/001-xiao-trusted-autonomy-roadmap.md`
- `plans/004-m2-execution-environments-managed-worktrees.md`
- `plans/README.md`

Anything else requires revising this plan before editing.

## Schema migration v2

### `workspaces`

Add nullable-during-migration then Rust-backfilled unique `public_id` UUIDv7.
Repository code must ensure every new workspace receives one before returning.

### `execution_environments`

```text
id UUIDv7 primary key
workspace_id unique foreign key
kind = windows
label
workspace_root
availability
created_at
updated_at
```

### `tasks`

Add:

```text
execution_environment_id
workspace_mode: local | managed-worktree
managed_worktree_id?
```

Generic frontend snapshot saves may not forge or clear native ownership fields.
New rows are native-bound to the workspace local environment and Local mode.
Only managed-environment commands change workspace mode/binding.

### `managed_worktrees`

```text
id UUIDv7 primary key
workspace_id + task_id
run_id nullable (reserved for M3)
repository_root
repository_common_dir_sha256
checkout_path
execution_root
branch
base_commit
owner_marker_path
status: preparing | active | removing | failed | removed
failure_reason?
created_at
removed_at?
```

A partial unique index allows at most one `preparing|active|removing` record per
task. Checkout, marker and branch paths/names are unique.

Migration behavior:

1. Apply DDL transactionally.
2. Generate workspace/environment UUIDv7 values in Rust in that transaction.
3. Backfill every task to the workspace local environment and Local mode.
4. Verify no workspace/task remains without an environment.
5. Record schema migration 2 in the same transaction.
6. Reopen is idempotent; schema newer than 2 is rejected.

## Native execution resolution

`ExecutionContext` returns:

```text
projectPath
executionRoot
environment { id, kind, label, availability }
workspaceMode
managedWorktree? { id, branch, checkoutPath, status, diskBytes, sizeComplete }
isolationAvailable
isolationUnavailableReason?
```

Rules:

- Without a persisted task (new draft/project browsing), native canonicalizes the
  user-selected project and exposes Local context only.
- With a task, workspace/task/environment rows must match.
- Local root must equal the environment workspace root after canonicalization.
- Managed root must pass DB/marker/path/Git proof before agent, terminal or
  mutable Git operations.
- Repository connection lock is released before filesystem traversal, marker IO
  or Git commands.
- No command accepts an execution root as authority from React.

Task-scoped routing matrix:

| Operation | Native authority |
|---|---|
| Codex `thread/start` | resolved execution root as `cwd` |
| Codex `turn/start` | native-overridden workspace-write roots |
| app-server command/file/skill cwd scopes | native-overridden context root |
| Git summary/mutate/compare/checkpoint/patch | resolved task root |
| terminal PTY cwd | resolved task root |
| workspace snapshot/list/read | resolved task root + validated relative path |

Project selection and explicit manual-worktree creation are user project-level
operations, not run ownership. They remain canonicalized native operations and
never create managed DB/marker records.

## Managed-worktree lifecycle

### Create

1. Resolve task Local binding and inspect Git repository/common-dir/HEAD/prefix.
2. Generate UUIDv7, collision-resistant branch and canonical managed paths from
   native app-data root.
3. Persist `preparing` ownership intent in a short transaction.
4. Run `git worktree add -b <branch> <checkout> <baseCommit>` without DB lock.
5. Canonicalize checkout and nested execution root under managed root.
6. Atomically write and sync `ownership.json` outside checkout.
7. Verify marker + Git evidence.
8. Atomically mark record `active` and bind task to managed mode.
9. On failure, remove only resources proven created by this preparation, record
   bounded failure diagnostic and keep task Local.

### Cleanup

1. UI loads record/path/disk usage/dirty state and receives explicit confirmation.
2. Native transitions exact active record to `removing`.
3. Re-read and match marker fields/version/path/hash.
4. Verify canonical checkout under managed root.
5. Verify exact Git porcelain worktree path/branch/common-dir.
6. Run `git worktree remove --force` for that exact checkout only.
7. Remove the external ownership directory; never reset the main workspace.
8. Mark record removed and task Local in one transaction.
9. Any mismatch refuses deletion and preserves files/record for inspection.

## Required automated cases

### Migration/repository

- Fresh schema applies migrations 1 and 2 once.
- Upgrade a real schema-v1-shaped database to v2.
- Every existing task backfills Local environment/mode.
- New workspace/task receives native IDs and Local binding.
- Generic task update cannot forge environment/worktree ownership.
- Future schema rejection remains intact.
- Preparing/activate/fail/removing/removed transitions enforce exact IDs/status.
- Concurrent setup for one task yields one owner.

### Git/ownership

- Create and reopen managed worktree.
- Dirty main status bytes remain identical before/after setup/cleanup.
- Nested workspace resolves matching nested root in checkout.
- Branch/path collision refuses or retries without reusing ownership.
- Non-Git and unborn repository return explicit isolation-unavailable errors.
- Marker missing, malformed, symlinked or field-mismatched refuses cleanup.
- DB path/branch/hash mismatch refuses cleanup.
- Checkout outside managed root/path traversal refuses cleanup.
- Manual worktree is listed but never accepted as Xiao-owned.
- Stale DB record and missing Git worktree refuse destructive cleanup.
- Cleanup removes exact managed checkout only; main workspace/HEAD/status remain.
- Setup failure compensation never deletes pre-existing paths.

### Root routing

- Agent session cwd equals terminal cwd, Git root and file root for one task.
- Workspace-write sandbox roots are overwritten with native root.
- Frontend-provided wrong cwd/roots cannot escape native root.
- Local task resolves project path; managed task resolves isolated nested root.
- Switching task changes effective snapshot/root without changing project identity.

### Frontend

- M1/browser documents default Local safely.
- Environment fields round-trip without frontend authority over native binding.
- New draft can select Isolated only in native Git context.
- Setup failure keeps Local and shows diagnostic.
- Cleanup confirmation includes path and bounded disk usage.
- Submit is blocked while environment transition/history/save is incomplete.
- Manual worktree UI is labelled unowned.

## Manual isolated verification

Use only temporary repositories and the debug-only M1 state-root override.

1. Create clean Git project; create Local task and verify agent/file/Git/terminal
   context reports the same canonical project root.
2. Make tracked + untracked dirty main changes; capture status/HEAD/content hash.
3. Create isolated task; verify worktree layout, DB record, marker, branch and
   nested execution root.
4. Modify isolated checkout; verify main status/HEAD/content are unchanged.
5. Restart Xiao; verify task reopens against the same owned worktree.
6. Tamper each proof independently on copied fixtures; cleanup must refuse and
   preserve paths.
7. Restore proof, request cleanup, verify prompt includes size/path and only the
   managed checkout disappears.
8. Kill during setup and cleanup failpoints; restart must expose stale state and
   never auto-delete.
9. Repeat with nested workspace, dirty main, non-Git and Unicode/long-ish paths.
10. Verify no process/temp/worktree leak and real Xiao profile remains untouched.

## Full gate

Run in order:

1. `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
2. focused migration/repository/managed-worktree/root-routing tests
3. focused frontend environment/persistence tests
4. `npm run check`
5. `npm test -- --run`
6. `npm run build`
7. `cargo test --manifest-path src-tauri/Cargo.toml`
8. `cargo check --manifest-path src-tauri/Cargo.toml`
9. scoped Clippy, allowing only documented pre-existing warnings
10. isolated executable create/restart/tamper/cleanup probes
11. Windows release compile + NSIS package
12. `git diff --check`
13. changed-path/privacy/cleanup scope checks

## Completion evidence — 2026-07-16

- Schema-v1 upgrade, fresh schema, native-field anti-forgery, lifecycle,
  concurrent reservation and future-schema tests passed. The copied beta fixture
  migrated to schema 2 with SHA-256 prefix `b072f684c2690c03`, 3 workspaces, 27
  tasks and 660 timeline entries; source/backup bytes, integrity and foreign keys
  remained valid.
- The Windows safety matrix passed for dirty main state, nested projects,
  non-Git/unborn repositories, setup compensation, full-ID branch collisions,
  Unicode/long-ish paths, case variants, missing/malformed/mismatched markers,
  outside-root database paths, checkout junction replacement, manual unowned
  worktrees, cross-workspace task IDs and exact cleanup confirmation.
- Controlled child-process aborts after `git worktree add` and after Git removal
  left durable `preparing`/`removing` intent. Explicit retry resumed/finalized
  safely with zero leaked checkout paths; no startup path performed automatic
  deletion or turn/approval resubmission.
- Native routing tests overwrite renderer `cwd`, search roots and writable roots,
  reject nested path smuggling, bind thread IDs to task + execution root, limit
  direct command execution to the confirmed draft-PR action, and stop task PTYs
  during an environment transition. Frontend persistence/fork/cleanup-copy tests
  passed, including path, bounded size and dirty warnings.
- A two-launch debug executable smoke test used a synthetic Git project and
  isolated absolute state root: schema 2, one workspace/task/environment,
  idempotent migration, immutable JSON/backup, integrity and foreign keys all
  passed. The real profile remained byte-identical at 4,907,068 bytes with
  SHA-256 `b072f684c2690c03e7cb6776a170f4db5b4d0ebc6d3e1e5a8206fef852f4e0a5`.
- Full gates passed: 86 Rust tests (`82` passed, `4` intentional manual probes
  ignored), 46 frontend tests, TypeScript, production web build, Cargo check,
  format, scoped Clippy and `git diff --check`. The explicit crash and copied-beta
  ignored probes passed separately.
- Managed-worktree benchmark on the Windows fixture measured 473 ms setup and
  201 ms cleanup, below the 5 s / 3 s thresholds. Dirty-main status/HEAD/content
  delta and leaked-path count were zero.
- Version metadata is synchronized at `0.0.0-day07162026`. Windows release and
  NSIS packaging passed; executable is 15,345,152 bytes and installer is
  4,418,802 bytes. Release artifacts exclude debug state/crash override names.

### Residual risks and intentional deferrals

- `bundle.targets = "all"` / MSI still rejects the human-readable nonnumeric
  prerelease identifier; the day-16 NSIS artifact is valid. Version-scheme/MSI
  work remains separate from M2.
- Production still uses one process-local Codex app-server. Thread bindings are
  environment-scoped and ephemeral; durable run ownership, queue reconciliation
  and persistent-session policy remain M3.
- Renderer scheduling remains Local and non-durable until M3/M4. M2 adds no
  scheduler, concurrency controller, verification engine or analytics.
- Same-user filesystem/Git mutation racing between proof and deletion cannot be
  proven impossible on Windows. Xiao rechecks database, marker, canonical path
  and Git evidence and fails closed on observed drift; this is measured safety,
  not a zero-bug claim.
- Managed branch refs and failed/removed audit rows are intentionally retained;
  cleanup removes only the proven checkout/ownership directory.

## Exit criteria

- [x] Every persisted task has exactly one native execution environment.
- [x] Local remains the default and non-Git projects remain usable.
- [x] Managed setup works without changing dirty main state.
- [x] Agent/Git/terminal/filesystem roots are native-resolved and identical.
- [x] Four-way ownership proof gates every destructive checkout cleanup.
- [x] Cleanup UI shows path/disk usage and requires confirmation.
- [x] Crash/stale/tamper cases never delete an unproven path.
- [x] Full automated, executable and NSIS package gates pass.
- [x] M2 status/docs are updated to DONE.

## STOP conditions

- A managed checkout/execution root cannot canonicalize under the native root.
- Existing nested-workspace Git scoping breaks.
- Any cleanup path needs `reset --hard`, main checkout mutation or marker-only proof.
- A repository lock must be held during Git/process/filesystem traversal.
- Frontend-provided execution paths remain authoritative for a task operation.
- Setup failure can delete a path that existed before the operation.
- Full gate fails twice after a scoped correction.
