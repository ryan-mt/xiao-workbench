# Plan 003: M1 — Durable SQLite store và migration an toàn

> **Executor instructions**: Chỉ thực hiện M1. Không chuyển Codex sang persistent
> production threads, không thêm queue/concurrency/scheduler/worktree. Mọi write
> phải transactional; legacy JSON chỉ được đọc và backup, không sửa/xóa. Không
> đánh dấu DONE trước khi migration matrix, paged timeline và full gate đều đạt.
>
> **Drift check**:
> `git diff --stat 33bfa96..HEAD -- package.json src src-tauri docs README.md CONTRIBUTING.md`
> M0 đang tồn tại trong working tree nhưng production behavior chưa đổi. Nếu
> persistence/runtime files khác trạng thái đã audit, dừng và reconcile.

## Status

- **Execution status**: DONE
- **Priority**: P0 foundation
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 002 (DONE)
- **Planned at**: `33bfa96`, 2026-07-16

## Objective

Thay `xiao-state-v1.json` bằng SQLite canonical store có numbered migrations,
transactional legacy import, backup bất biến và timeline load theo page, trong
khi giữ nguyên workflow/task fields hiện tại.

## Fixed decisions

- `rusqlite 0.40.1`, `default-features = false`, feature `bundled`.
- Một connection do Rust/Tauri quản lý sau `Mutex`; không giữ lock qua `.await`
  hoặc external process.
- DB: `<app-data>/xiao-state.sqlite3`.
- Legacy source: `<app-data>/xiao-state-v1.json`.
- Backup tên theo SHA-256 để idempotent và không ghi đè.
- SQLite là canonical ngay sau import thành công; không dual-write JSON.
- Current Codex thread vẫn ephemeral. ID được lưu dưới explicit
  `threadBinding.persistence = ephemeral|legacy-untrusted`, không được coi là
  resumable và không hiển thị như active session sau restart.
- Workspace load lấy metadata của mọi task nhưng chỉ latest bounded timeline page
  của active task. Frontend tiếp tục tải page cũ trong nền và disable submit cho
  tới khi active history đầy đủ.
- Save snapshot chỉ thay timeline khi `timelineComplete = true`; partial pages
  không được truncate dữ liệu trong DB.

## Scope

### In scope

- SQLite initialization, pragmas và embedded numbered migrations.
- Tables cho workspace/task/timeline và M3-ready run/run_event records.
- Repository layer; commands không chứa SQL.
- Transactional legacy import, hash/count verification, immutable backup và
  migration marker.
- Incremental bounded timeline API.
- Explicit thread-binding DTO.
- Frontend integration preserving task/archive/pin/draft/follow-up/goal/plan/
  timeline behavior.
- Migration/repository/frontend tests and isolated-profile manual verification.

### Out of scope

- Native Codex resume in production.
- Runtime registry, durable run dispatch hoặc scheduler.
- Worktree/environment model.
- Routine/verification UI.
- Preference/localStorage migration.
- Commit, push hoặc release.

## Files allowed

- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/src/lib.rs`
- `src-tauri/src/xiao/mod.rs`
- `src-tauri/src/xiao/commands.rs`
- `src-tauri/src/xiao/models.rs`
- `src-tauri/src/xiao/service.rs`
- `src-tauri/src/xiao/repository.rs` (new)
- `src/core/models/xiao.ts`
- `src/core/bridges/tauri.ts`
- `src/features/task/task.types.ts`
- `src/features/task/taskPersistence.ts` (new)
- `src/features/task/taskPersistence.test.ts` (new)
- `src/features/task/taskFork.ts`
- `src/features/task/taskFork.test.ts`
- `src/features/task/composer/Composer.tsx`
- `src/features/task/workspace/TaskWorkspace.tsx`
- `src/features/task/timeline/TaskTimeline.tsx`
- `src/features/task/styles/task.css` only if a loading indicator needs styling
- `src/features/shell/components/Sidebar.tsx` for persisted history-count projection
- `src/app/App.tsx`
- focused new frontend tests under existing feature/app locations
- `docs/architecture/execution-domain.md`
- `docs/architecture/codex-runtime-decisions.md`
- `plans/001-xiao-trusted-autonomy-roadmap.md`
- `plans/003-m1-durable-sqlite-store.md`
- `plans/README.md`

Anything else requires revising this plan before editing.

## Schema v1

Required tables:

- `schema_migrations`
- `legacy_imports`
- `workspaces`
- `tasks`
- `task_timeline_entries`
- `runs`
- `run_events`

Workspace/task/timeline are production-used in M1. Run tables establish typed
constraints only; no dispatch API is exposed until M3.

Required pragmas:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

## Migration contract

1. Open/configure database.
2. Reject DB schema newer than supported.
3. Apply missing SQL migrations one-by-one transactionally.
4. If legacy marker exists, never import again.
5. If no legacy file, finish with empty canonical DB.
6. If legacy exists, read full bytes and parse/validate before write.
7. Normalize/merge canonical duplicate paths with current semantics.
8. Convert legacy `threadId` to `legacy-untrusted` binding.
9. Write or verify immutable hash-named backup.
10. Import all records in one transaction.
11. Reload full records inside transaction; verify counts and canonical hashes.
12. Insert migration marker in same transaction and commit.
13. Leave original JSON untouched forever.

Corrupt/unsupported JSON or a non-empty unmarked DB produces a recoverable
repository error. It must not display an empty fake workspace and must not alter
legacy source.

## Required automated cases

### Schema/repository

- Fresh install applies schema once.
- Reopen is idempotent.
- Foreign keys, WAL and schema version are active.
- Full round-trip covers every task field and explicit thread binding.
- Partial timeline update preserves all existing entries.
- Full timeline update replaces exactly.
- Timeline page enforces max limit and stable order.
- Removing task cascades timeline, run and run events as designed.
- Failed transaction leaves previous committed state unchanged.
- Concurrent/reentrant lock access is serialized without poisoning production.

### Legacy migration

- Missing legacy file.
- Valid single workspace.
- Duplicate canonical workspace paths.
- Every field preserved.
- Empty bootstrap cleanup remains consistent.
- Legacy thread ID retained only as `legacy-untrusted` binding.
- Corrupt JSON.
- Unsupported schema.
- Existing identical backup.
- Conflicting backup.
- Interrupted temporary backup followed by safe replacement.
- Failure before commit followed by successful retry.
- Already migrated despite legacy file remaining.
- Non-empty DB without marker refuses implicit merge.
- Original source bytes/hash/mtime remain unchanged.

### Frontend

- Native document mapping defaults fields safely.
- Partial task history is never serialized as complete.
- Active task pages prepend in stable order without duplicates.
- Submit stays disabled until active history is complete.
- Fork/continue/new task produce complete timeline metadata.
- Browser fallback remains fully loaded.

## Manual isolated-profile verification

Never test migration first against the real beta profile. On Windows, changing
`APPDATA`/`LOCALAPPDATA` is **not sufficient** because Tauri resolves a known
folder directly. Build a debug executable and set the absolute
`XIAO_WORKBENCH_STATE_DIR` test override; release builds ignore this variable.

1. Create temporary state, `APPDATA` and `LOCALAPPDATA` directories; point the
   debug executable at the state directory with `XIAO_WORKBENCH_STATE_DIR`.
2. Copy a read-only fixture equivalent to beta schema, including archive/pin,
   draft, follow-up, goal, plan, timeline and legacy thread ID.
3. Launch Xiao once; verify DB, marker and hash backup exist.
4. Verify original bytes/hash/mtime unchanged.
5. Launch again; verify no duplicate task/timeline/run rows.
6. Modify task through UI or command harness; verify SQLite changes while JSON
   remains unchanged.
7. Kill during a test transaction/failpoint; verify prior commit remains.
8. Compare pre/post field manifest and counts.

Only after synthetic verification may a **copy** of the real beta JSON be used.
Never operate on the actual profile during M1 testing.

## Full gate

Run in order:

1. `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
2. focused Rust repository/migration tests
3. focused frontend persistence tests
4. `npm run check`
5. `npm test -- --run`
6. `npm run build`
7. `cargo test --manifest-path src-tauri/Cargo.toml`
8. `cargo check --manifest-path src-tauri/Cargo.toml`
9. isolated-profile migration verification
10. `git diff --check`
11. changed-path scope check

## Verification record (2026-07-16)

- Rust full gate: 60 passed, 0 failed, 2 intentional ignored probes.
  Repository focus: 20 passed plus the benchmark and external-copy probe ignored
  by default. Five repeated concurrent-initialization probes also passed.
- Frontend full gate: 8 files / 44 tests. Focused persistence/fork gate: 8 tests.
- TypeScript check, production web build, `cargo check`, format, scoped Clippy
  (allowing only two pre-existing agent `too_many_arguments` warnings) and
  `git diff --check` passed.
- Synthetic debug-executable migration passed two launches with exactly 1
  workspace, 2 tasks and 655 timeline entries; source hash/mtime and one backup
  remained unchanged.
- A copied beta state passed repository and executable probes with exactly 3
  workspaces, 27 tasks and 660 entries. SQLite integrity and foreign-key checks
  passed without logging task contents.
- Hard-crash probe killed the executable after durable backup but before import
  commit. The recovered database had zero imported rows; restart produced
  exactly 1 workspace, 1 task and 500 entries without duplicates. A separate
  corrupt-source executable probe kept the diagnostic window alive with zero
  imported rows, no backup, an unchanged source and a valid empty schema.
- Debug benchmark (5 workspaces / 100 tasks / 8,000 entries): median deliberate
  full save 242 ms, incremental metadata update <1 ms, full load 56 ms, bounded
  load 3 ms. Identical timelines avoid row replacement.
- Windows release compilation with bundled SQLite passed. NSIS packaging passed:
  release executable 14.20 MiB, installer 4.13 MiB. The existing `bundle=all`
  path still rejects the pre-existing nonnumeric MSI prerelease version
  `0.0.0-day07152026`; release metadata was intentionally not changed in M1.
- Test-isolation incident: the first executable probe relied on temporary
  `APPDATA`, which Tauri's Windows known-folder API ignored. It created only a
  new database/backup beside the real JSON. The original hash/mtime stayed
  unchanged; the process was stopped, every newly-created DB/WAL/SHM/backup
  artifact was verified and removed, and the profile was rechecked to contain
  only the original JSON. All later probes used the debug-only absolute state
  override; release builds were verified not to contain either test override.

## Exit criteria

- [x] SQLite is canonical; production no longer reads/writes legacy JSON after import.
- [x] Every current user-visible task field round-trips.
- [x] Legacy source remains byte-identical and immutable backup is verified.
- [x] Migration is atomic and idempotent across restart/failure.
- [x] Corrupt input surfaces recoverable error without data loss.
- [x] Active timeline loads through bounded pages and cannot be truncated by partial save.
- [x] Ephemeral/legacy thread IDs are explicit and never treated as resumable.
- [x] Full automated and isolated-profile gates pass.
- [x] M1 status/docs are updated to DONE.

## STOP conditions

- Any current task field cannot be represented or round-tripped.
- Migration needs to mutate/delete legacy JSON.
- A partial timeline payload can overwrite complete persisted history.
- Corrupt input causes Xiao to continue with an empty canonical state.
- Connection lock must be held across async/external operations.
- Persistent thread behavior would need to change before M3.
- Full gate fails twice after a scoped correction.
