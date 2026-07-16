# Trusted local autonomy — product contract

Status: **Accepted for M0**

Baseline: Xiao `33bfa96`, Codex CLI `0.144.5`, 2026-07-16

This document defines the user promise for Xiao's autonomy roadmap. It is a
product contract, not a claim that every milestone is already implemented.
When UI copy or implementation behavior conflicts with this document, the
implementation must be corrected or an ADR must explicitly revise the contract.

## Position

> **Xiao is local mission control for verified agent work.**

Xiao should be the place where a Windows developer can hand off a long-running
coding goal, retain control at approval boundaries, inspect what happened, and
accept or restore the result based on evidence rather than model confidence.

Xiao is not trying to become:

- the widest model-provider catalog;
- a cloud/mobile remote-control service;
- a full IDE or editor;
- an agent plugin marketplace;
- an unattended system that bypasses human approval policy.

Provider breadth may later come from one runtime adapter. Editing continues in
the user's preferred editor. The product moat is trustworthy local execution.

## North-star workflow

```text
Goal
  -> Acceptance contract
  -> Isolated run
  -> Human input when policy requires it
  -> Deterministic verification
  -> Evidence
  -> Accept / compare / restore
```

Each arrow must be inspectable. Xiao must not hide an automatic retry, approval,
workspace switch, provider handoff, candidate fork, or destructive recovery.

## Product vocabulary

### Goal

The outcome the user wants. A goal can outlive one prompt or run. It is not a
claim that the work is complete.

### Task

The durable user-facing container for goal, conversation, plan, defaults and
run history. A task has one selected execution environment and workspace mode.

### Run

One immutable execution attempt. A retry, provider handoff or Arena candidate
creates another run with visible lineage; it does not rewrite the previous run.

### Routine

A durable schedule plus a run template. Each due occurrence creates at most one
run record. A routine is not a renderer timer.

### Acceptance contract

User-approved deterministic conditions for calling work Verified. The initial
gates are command exit status, changed-path scope and workspace cleanliness.

### Evidence

Bounded, inspectable output produced by execution or verification: command
result, diff summary, patch, screenshot or review. Agent prose is not evidence
that a deterministic gate passed.

### Managed worktree

A Git worktree created and owned by Xiao under Xiao app data. Xiao never treats
a manually-created worktree as owned merely because it can see it.

## Status language

Internal agent state and verification state are separate. UI surfaces must use
the following meanings consistently.

| User-facing status | Meaning | Terminal? |
|---|---|---:|
| Queued | Durable run exists but execution has not started | No |
| Preparing | Environment/worktree/runtime is being validated | No |
| Running | Agent turn is active | No |
| Needs input | A correlated approval or question is waiting for the user | No |
| Verifying | Agent settled and deterministic gates are running | No |
| Verified | Agent settled and every required gate passed | Yes |
| Done | Agent settled, but no acceptance contract was requested | Yes |
| Verification failed | At least one gate failed; work is preserved | Yes for this verification attempt |
| Verification blocked | A gate could not run, for example missing binary or timeout policy | Yes for this verification attempt |
| Failed | Agent/runtime failed before a valid completion | Yes |
| Interrupted | Process/session continuity was lost or the user interrupted it | Yes |
| Cancelled | User cancelled before successful completion | Yes |

Rules:

1. “Done” never means “Verified.”
2. “Verified” never comes from an assistant message such as “tests pass.”
3. A timeout is not displayed as a test failure; it is Verification blocked.
4. Failed verification never discards changes automatically.
5. A retry is a linked new attempt, not a status rewrite that erases evidence.
6. After process death, an in-flight run becomes Interrupted unless the runtime
   can prove a terminal outcome. Xiao never silently resubmits it.

## Core user journeys

### 1. Interactive isolated task

1. User opens a Git project and creates a task.
2. Xiao shows the selected environment and Local/Isolated Worktree mode.
3. Xiao validates the execution root before starting.
4. The agent runs; any approval appears on the exact task/run.
5. Xiao preserves changes and checkpoint/evidence references.
6. User reviews changes and accepts, continues or restores them.

Default behavior remains Local for migrated interactive tasks so upgrades do not
silently move existing work. New automation in a Git project defaults to an
isolated managed worktree.

### 2. Recurring routine

1. User selects one-shot, daily or weekly recurrence.
2. Xiao shows timezone, next occurrence, missed-run policy, environment,
   isolation, sandbox and approval policy before save.
3. Native state reserves a unique occurrence before dispatch.
4. Closing the main window leaves Xiao resident in the tray; the routine remains
   eligible.
5. A request for input pauses that run and emits a notification; it is not
   auto-approved.
6. The user opens the exact run, responds, and later sees Done/Verified/evidence.

Running after the Xiao process has fully exited is not promised by Routines v1.
The UI must say “Runs while Xiao is open or in the system tray,” not merely
“Runs while Xiao is open.”

### 3. Verification failure

1. Agent settles normally.
2. Xiao runs the saved acceptance contract in the same execution environment
   and root.
3. One gate fails or is blocked.
4. Xiao preserves the worktree and displays bounded evidence.
5. User may rerun verification without paying for another model turn, ask the
   agent to fix the issue in a new linked run, or inspect manually.

### 4. Crash or runtime loss

1. Xiao/app-server dies during a run.
2. On restart, native reconciliation identifies every non-terminal run.
3. Runs are marked Interrupted; stale approval controls are disabled.
4. Xiao may resume the persisted thread for a new user-authorized continuation,
   but it does not claim the lost turn continued and does not auto-retry it.
5. The isolated worktree/checkpoint remains available for inspection.

### 5. Candidate comparison

Task Arena is later than the critical path. Its contract is still fixed:

- exactly two candidates in the first release;
- identical baseline, separate Xiao-owned worktrees and run lineages;
- the same acceptance contract evaluated independently;
- deterministic evidence shown before any advisory AI comparison;
- no automatic merge or destructive checkout when choosing a candidate.

## Safety promises

### Local-first and private by default

- Task/run/routine/evidence state lives in Xiao app data on the machine.
- Xiao adds no analytics or remote transcript storage.
- Codex continues to follow the user's local Codex account/configuration.
- Export is explicit and sanitized; attachments require opt-in.
- Raw credentials, auth headers, environment maps, secret question answers,
  encrypted reasoning and unbounded process output are not stored as run events.

### Explicit execution root

Every privileged operation has one native-resolved execution environment and
canonical root. Agent, Git, terminal and verification for one run use that same
root. Frontend/model-provided paths are never sufficient authority.

### Human approval remains authoritative

- Xiao never turns an ask/deny policy into auto-allow.
- Approval requests are routed by request ID plus thread/turn/item identity.
- After app-server death, old request IDs are invalid and UI actions are disabled.
- A routine that requires approval pauses and notifies the user.

### No automatic duplicate execution

A routine occurrence has a unique idempotency key. Xiao persists the occurrence
and run before dispatch. If process death makes turn acceptance ambiguous, the
run is Interrupted. Only an explicit user retry creates a linked new run.

This is an “at most one automatic dispatch” promise, not a claim of distributed
exactly-once execution against an external model service.

### Non-destructive recovery

- No cleanup path force-resets the main workspace.
- Xiao only deletes managed worktrees with matching database ownership, external
  marker and Git worktree evidence.
- Restore preflights every reverse patch before applying the first patch.
- Conflicts stop recovery and preserve the current files.

## Defaults

| Setting | Interactive migrated task | New routine | Task Arena |
|---|---|---|---|
| Workspace mode | Local | Managed worktree when Git is available | Managed worktree required |
| Concurrency | Eligible under global bound | Eligible under global bound | Two candidates count toward bound |
| Approval | Preserve task value | On request | Preserve candidate template value |
| Sandbox | Preserve task value | Workspace write | Workspace write |
| Verification | Optional | Optional, recommended | Shared contract required for Verified comparison |
| Retry | Explicit | Explicit after failure/interruption | Explicit per candidate |

Danger-full-access is never a silent default. Creating a routine with that mode
requires explicit confirmation and a persistent warning label.

## Routines v1 release boundary

Included:

- one-shot, daily and weekly schedules;
- local timezone with explicit next-run display;
- missed-run policy `skip` or `run-once`;
- enable, disable, edit, run-now and delete;
- tray-resident execution and desktop notification;
- approval/question pause;
- isolated worktree default for Git projects;
- run history and optional acceptance contract.

Not included:

- arbitrary cron syntax;
- file/Git/webhook triggers;
- cloud or SSH execution;
- execution after the Xiao process exits completely;
- automatic commit, push or pull request;
- automatic approval.

## Verified Done v1 release boundary

Included deterministic gate types:

1. command argv + timeout + expected exit code;
2. changed-path allow/deny scope;
3. explicit staged/unstaged/untracked cleanliness policy.

Deferred:

- browser screenshot or DOM gates until preview automation is reliable;
- independent AI review as a clearly advisory result;
- performance budgets until reproducible project-specific baselines exist.

## Success criteria without analytics

Xiao does not add telemetry to measure adoption. Release readiness is evaluated
through deterministic behavior and opt-in feedback:

- no duplicate occurrence in restart tests;
- no unowned worktree deletion in adversarial tests;
- no Verified label without persisted passing gates;
- exact run deep-link for every notification/input request;
- upgrade fixture preserves all current user-visible task fields;
- Windows release matrix passes;
- issue reports contain local, user-triggered diagnostic exports rather than
  automatically uploaded logs.

## Compatibility and honest degradation

- A missing/old Codex capability disables only the dependent control and shows a
  concise remediation; it does not fabricate support.
- If native thread resume fails, Xiao creates a visibly linked continuation from
  a structured capsule after user confirmation. It does not silently claim the
  original runtime session resumed.
- Non-Git projects remain usable in Local mode; Xiao explains that managed
  worktree isolation and Task Arena are unavailable.
- WSL never silently falls back to Windows execution.

## Product release gate

The critical-path release is not ready until a user can:

1. create a daily isolated routine;
2. close the window while Xiao remains in the tray;
3. survive process restart without duplicate dispatch;
4. respond to a correlated approval request;
5. receive deterministic verification evidence;
6. distinguish Done, Verified, Failed and Interrupted;
7. inspect or retain the worktree after any failure.
