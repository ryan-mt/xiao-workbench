# Plan 002: M0 — Khóa persistence, runtime và protocol decisions

> **Executor instructions**: Chỉ thực hiện M0. Không chuyển production persistence,
> không resume task thật, không thêm concurrency vào Xiao và không bắt đầu M1.
> Protocol probes phải chạy trong thư mục tạm, dùng sandbox read-only khi có thể,
> không ghi credentials/transcript riêng tư vào repository. Cập nhật trạng thái và
> chạy toàn bộ verification gate trước khi đánh dấu DONE.
>
> **Drift check**:
> `git diff --stat 33bfa96..HEAD -- package.json src src-tauri docs README.md CONTRIBUTING.md`
> Expected at start: no committed drift; only roadmap files are untracked.

## Status

- **Execution status**: DONE
- **Priority**: P0 foundation
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: Plan 001
- **Planned at**: `33bfa96`, 2026-07-16

## Objective

Kiểm chứng các giả định có thể làm hỏng toàn bộ roadmap, sau đó viết contract đủ
rõ để một agent ở context mới có thể triển khai M1–M3 mà không tự chọn lại kiến
trúc.

## Assumptions

- Codex CLI cài local là nguồn protocol authoritative cho compatibility hiện tại.
- Live model probes tối thiểu được phép vì người vận hành yêu cầu kiểm tra đầy đủ.
- Probe không được chạm workspace Xiao hoặc giữ lại test thread sau khi hoàn tất.
- Nếu live probe không thể xác nhận correlation/resume an toàn, M0 dừng BLOCKED.

## Scope

### In scope

- Generate app-server v2 schema/types từ CLI local.
- Probe initialize/account, persistent thread resume, concurrent ephemeral turns,
  interruption và pending approval recovery.
- Fixture-based Rust compatibility tests không cần credentials/network.
- Opt-in Node live-probe harness.
- Product/domain/runtime ADRs.
- Baseline startup/load/save measurements bằng fixture không chứa dữ liệu riêng tư.
- Roadmap/index status updates.

### Out of scope

- SQLite dependency hoặc production database.
- Thay `ephemeral: true` trong Xiao.
- Runtime registry/concurrency implementation.
- Scheduler/worktree/verification UI.
- Commit, push hoặc release.

## Files allowed

- `.gitignore`
- `package.json`
- `scripts/probe-codex-app-server.mjs` (new)
- `src-tauri/src/agent/protocol.rs`
- `src-tauri/src/agent/fixtures/codex-app-server-v2.jsonl` (new)
- `src-tauri/src/xiao/service.rs` (test-only reproducible storage baseline)
- `docs/product/trusted-autonomy.md` (new)
- `docs/architecture/execution-domain.md` (new)
- `docs/architecture/codex-runtime-decisions.md` (new)
- `plans/001-xiao-trusted-autonomy-roadmap.md`
- `plans/002-m0-runtime-protocol-decisions.md`
- `plans/README.md`

Anything else requires stopping and revising this plan first.

## Steps and verification

### 1. Make roadmap/docs trackable

- Add narrow `.gitignore` exceptions for the three M0 documents and `plans/*.md`.
- Mark Plan 001 and M0 IN PROGRESS.

Verify:

- `git check-ignore plans/001-xiao-trusted-autonomy-roadmap.md` exits non-zero.
- `git check-ignore docs/product/trusted-autonomy.md` exits non-zero after creation.

### 2. Add deterministic compatibility fixtures

- Add a sanitized JSONL fixture representing two correlated threads/turns, an
  approval request and terminal events.
- Add Rust tests proving required `threadId`, `turnId`, `itemId`, request ID and
  terminal status fields remain available.
- Fixture must contain no real user path, email, token, account or thread ID.

Verify:

- `cargo test --manifest-path src-tauri/Cargo.toml agent::protocol::tests` passes.

### 3. Add opt-in live protocol probe

Harness requirements:

- No third-party dependency.
- Spawn `codex app-server --stdio` and complete initialize handshake.
- Always use a unique temporary workspace.
- Metadata mode checks account availability and persistent start → process
  restart → `thread/resume` → cleanup.
- `--live` additionally starts two ephemeral turns concurrently and confirms
  events stay correlated; starts an interrupt probe and confirms terminal
  `interrupted`; starts an approval probe, kills the process while pending,
  resumes and records whether the request is reconstructed.
- Decline/cleanup any request when possible; delete every persistent test thread.
- Print a bounded JSON summary, not raw transcript/reasoning/output.
- Exit non-zero on an invariant failure.

Verify:

- `npm run probe:codex` passes metadata mode.
- `npm run probe:codex -- --live` passes live invariants or triggers a documented
  STOP condition.

### 4. Write three decision documents

`docs/product/trusted-autonomy.md` must define north star, user flows, status
language, safety promises, non-goals and release boundary.

`docs/architecture/execution-domain.md` must define Task, Run, Routine,
ExecutionEnvironment, AcceptanceContract, GateResult, Evidence, RunEvent,
state transitions, invariants and ownership boundaries.

`docs/architecture/codex-runtime-decisions.md` must record:

- CLI/schema version and reproducible commands;
- live probe results;
- SQLite library/connection ownership decision;
- native resume vs structured continuation decision;
- one app-server/environment vs process pool;
- initial concurrency bound;
- approval/restart behavior;
- event redaction and size limits;
- managed-worktree root/marker decision;
- baseline measurements and unresolved non-blocking risks.

Verify:

- No load-bearing `TBD`, `TODO` or “choose later”.
- A reviewer can answer where state lives, how restart behaves, where commands
  execute, and what “Verified” means by reading only these docs.

### 5. Full gate

Run in this order:

1. `npm run check`
2. `npm test -- --run`
3. `npm run build`
4. `cargo test --manifest-path src-tauri/Cargo.toml`
5. `cargo check --manifest-path src-tauri/Cargo.toml`
6. `git diff --check`
7. `git status --short --untracked-files=all`

Expected: all commands exit 0; changed files stay inside **Files allowed**.

## Exit criteria

- [x] Generated schema confirms required methods and correlation fields.
- [x] Persistent materialized thread resumes after app-server process restart.
- [x] One app-server safely correlates two overlapping active threads.
- [x] Interrupt reaches terminal `interrupted` during command execution without mutating Xiao workspace.
- [x] Pending approval restart behavior is proven: no re-emission, turn interrupted, no mutation.
- [x] CI-safe fixtures exercise turn/item/approval/subagent correlation and contain no private markers.
- [x] Three decision documents contain no unresolved architecture choice.
- [x] Full verification gate passes.
- [x] Plan 001 M0 and this plan are marked DONE.

## Verification record

- Codex CLI: `0.144.5`; generated schema checks passed.
- Metadata probe: persisted source-tagged thread resumed with the same ID after process restart and was deleted.
- Namespace probe: app-server state is shared despite temporary `CODEX_SQLITE_HOME`; Xiao-owned exact-ID allowlisting is now mandatory and documented.
- Live concurrency: two threads overlapped and retained distinct correlation IDs.
- Live interruption: command-running turn settled as `interrupted`.
- Live approval crash: request was not re-emitted; resumed turn was `interrupted`; requested file never appeared.
- Probe cleanup: zero persistent recovery threads and zero leftover probe process/temp path.
- Frontend: 7 files / 39 tests passed; typecheck and production build passed.
- Rust: 47 passed, 0 failed, 1 intentional ignored benchmark; `cargo check` passed.
- Manual ignored benchmark passed on a 5,847,556-byte synthetic store.
- `cargo fmt --check`, `git diff --check`, Node syntax and text-sanity checks passed.

## STOP conditions

- Concurrent events lack stable thread/turn identifiers.
- Resume by an exact Xiao-owned ID returns or mutates a different thread.
- Pending approvals are silently approved after restart.
- Probe cannot clean up persistent threads.
- Any required architecture decision still depends on undocumented behavior.
- Full verification fails twice after a scoped fix.
