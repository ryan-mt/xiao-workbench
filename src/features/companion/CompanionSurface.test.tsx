// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CompanionHostAuthorityPanel,
  CompanionSurface,
  type CompanionHostAuthorityPanelProps,
  type CompanionSurfaceProps,
} from "./CompanionSurface";
import {
  buildCompanionCommand,
  emptyCompanionProjection,
  type CompanionAction,
  type CompanionState,
  type CompanionTargetScope,
} from "./companionContract";

let commandSequence = 0;

const liveState = (): CompanionState => ({
  connection: "live",
  stale: false,
  hostGeneration: 2,
  cursor: 8,
  capturedAt: 1_800_000_000_000,
  commands: {},
  lastAnnouncement: "Companion data is live.",
  projection: {
    ...emptyCompanionProjection(),
    projects: [{ id: "project-1", name: "Xiao", taskCount: 1, attentionCount: 1 }],
    tasks: [{
      id: "task-1",
      projectId: "project-1",
      title: "Companion release",
      stage: "published",
      version: 4,
      currentRunId: "run-1",
      outcomeAcceptancePermitted: true,
    }],
    runs: [{
      id: "run-1",
      taskId: "task-1",
      status: "waiting_for_input",
      version: 5,
      canStop: true,
      canRetry: false,
      canFollowUp: true,
      safeSummary: "Waiting for an operator decision.",
    }],
    pendingInputs: [{
      id: "pending-1",
      runId: "run-1",
      version: 2,
      kind: "approval",
      safePrompt: "Allow the bounded verification command?",
      options: [
        { id: "allow_once", label: "Allow once" },
        { id: "decline", label: "Decline" },
      ],
    }],
    attention: [{
      id: "attention-1",
      projectId: "project-1",
      taskId: "task-1",
      runId: "run-1",
      version: 3,
      kind: "decision",
      title: "Approval needed",
      safeSummary: "A Run is waiting for input.",
      acknowledged: false,
    }],
    timeline: [{
      id: "timeline-1",
      taskId: "task-1",
      runId: "run-1",
      occurredAt: 1_800_000_000_000,
      kind: "Pending input",
      safeSummary: "A bounded decision is waiting.",
    }],
    verification: [{
      runId: "run-1",
      status: "passed",
      safeSummary: "All frozen gates passed.",
    }],
    observatory: [{
      runId: "run-1",
      activeAgents: 1,
      waitingAgents: 1,
      safeLatestActivity: "Waiting for approval",
    }],
  },
});

const props = (
  state: CompanionState = liveState(),
  onCommand = vi.fn(),
): CompanionSurfaceProps => ({
  state,
  createCommand: (
    action: CompanionAction,
    targetScope: CompanionTargetScope,
    expectedEntityVersion: number,
  ) => {
    commandSequence += 1;
    return buildCompanionCommand({
      deviceId: "device-1",
      commandId: `command-${commandSequence}`,
      idempotencyKey: `device-1:command-${commandSequence}`,
      auditTimestamp: 1_800_000_000_000,
    }, expectedEntityVersion, targetScope, action);
  },
  onCommand,
  onReconnect: vi.fn(),
  onOpenAttention: vi.fn(),
});

const hostAuthorityProps = (): CompanionHostAuthorityPanelProps => ({
  authority: "primary_host",
  devices: [{
    id: "device-2",
    name: "Operator phone",
    version: 2,
    createdAt: 1_799_000_000_000,
    lastSeenAt: 1_800_000_000_000,
    grants: ["Projects", "Tasks", "Attention"],
    revokedAt: null,
    sessions: [{
      id: "session-1",
      version: 3,
      createdAt: 1_799_000_000_000,
      lastSeenAt: 1_800_000_000_000,
      rotatedAt: null,
      revokedAt: null,
    }],
  }],
  pairing: {
    status: "ready",
    ownerCredential: "XIAO-PAIR-123",
    expiresAt: 1_800_000_060_000,
    error: null,
  },
  onCreatePairing: vi.fn(),
  onRotateSession: vi.fn(),
  onRevokeSession: vi.fn(),
  onRevokeDevice: vi.fn(),
});

afterEach(() => {
  cleanup();
  commandSequence = 0;
});

describe("CompanionSurface", () => {
  it("renders authorized summaries, non-color statuses, device sessions, and bounded actions", () => {
    render(
      <>
        <CompanionHostAuthorityPanel {...hostAuthorityProps()} />
        <CompanionSurface {...props()} />
      </>,
    );

    expect(screen.getByRole("heading", { name: "Xiao Companion" })).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("Operator phone")).toBeTruthy();
    expect(screen.getByText(/Session session-1 · Active/)).toBeTruthy();
    expect(screen.getByText("Companion release")).toBeTruthy();
    expect(screen.getByText(/passed: All frozen gates passed/)).toBeTruthy();
    expect(screen.getByText("1 active, 1 waiting")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept outcome" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open canonical item" })).toBeTruthy();
    expect(screen.queryByText(/terminal/i)).toBeTruthy();
    expect(document.querySelector('[data-authority="primary_host"]')).toBeTruthy();
  });

  it("keeps device and session administration behind the primary-host boundary", () => {
    const hostProps = hostAuthorityProps();
    render(<CompanionHostAuthorityPanel {...hostProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    fireEvent.click(screen.getByRole("button", { name: /^Revoke$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke device" }));

    expect(hostProps.onRotateSession).toHaveBeenCalledWith("device-2", "session-1", 3);
    expect(hostProps.onRevokeSession).toHaveBeenCalledWith("device-2", "session-1", 3);
    expect(hostProps.onRevokeDevice).toHaveBeenCalledWith("device-2", 2);
  });

  it("disables every canonical action while stale and offers recovery", () => {
    const state: CompanionState = {
      ...liveState(),
      connection: "disconnected",
      stale: true,
      lastAnnouncement: "Disconnected. Cached Companion data is stale.",
    };
    render(<CompanionSurface {...props(state)} />);

    expect(screen.getByText("Disconnected — stale")).toBeTruthy();
    expect(screen.getByText("Cached data is stale")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Allow once" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("button", { name: "Accept outcome" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("button", { name: "Acknowledge" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("emits only typed bounded commands with expected versions and target scopes", () => {
    const onCommand = vi.fn();
    render(<CompanionSurface {...props(liveState(), onCommand)} />);

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.change(screen.getByLabelText("Bounded follow-up"), {
      target: { value: "Please report the verification result." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send follow-up" }));
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept outcome" }));

    expect(onCommand.mock.calls.map(([command]) => ({
      action: command.action,
      expectedEntityVersion: command.expectedEntityVersion,
      targetScope: command.targetScope,
    }))).toEqual([
      {
        action: {
          kind: "resolve_pending_input",
          pendingInputId: "pending-1",
          inputKind: "approval",
          optionId: "allow_once",
        },
        expectedEntityVersion: 2,
        targetScope: {
          taskId: "task-1",
          runId: "run-1",
          pendingInputId: "pending-1",
        },
      },
      {
        action: { kind: "stop_run", runId: "run-1" },
        expectedEntityVersion: 5,
        targetScope: { taskId: "task-1", runId: "run-1" },
      },
      {
        action: {
          kind: "follow_up",
          runId: "run-1",
          message: "Please report the verification result.",
        },
        expectedEntityVersion: 5,
        targetScope: { taskId: "task-1", runId: "run-1" },
      },
      {
        action: { kind: "acknowledge_attention", attentionId: "attention-1" },
        expectedEntityVersion: 3,
        targetScope: {
          projectId: "project-1",
          taskId: "task-1",
          runId: "run-1",
          attentionId: "attention-1",
        },
      },
      {
        action: { kind: "accept_outcome", taskId: "task-1" },
        expectedEntityVersion: 4,
        targetScope: { projectId: "project-1", taskId: "task-1" },
      },
    ]);
  });

  it("bounds follow-ups and announces only the current host state", () => {
    render(<CompanionSurface {...props()} />);

    expect(screen.getByLabelText("Bounded follow-up").getAttribute("maxlength")).toBe("500");
    const liveRegion = screen.getByText("Companion data is live.");
    expect(liveRegion.getAttribute("aria-live")).toBe("polite");
    expect(liveRegion.getAttribute("aria-atomic")).toBe("true");
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
  });

  it("gives rejected actions scoped effect and recovery copy", () => {
    const base = liveState();
    const command = buildCompanionCommand({
      deviceId: "device-1",
      commandId: "command-rejected",
      idempotencyKey: "device-1:command-rejected",
      auditTimestamp: 1_800_000_000_000,
    }, 5, { runId: "run-1" }, { kind: "stop_run", runId: "run-1" });
    const state: CompanionState = {
      ...base,
      commands: {
        "command-rejected": {
          state: "rejected",
          command,
          rejectedAt: 1_800_000_000_100,
          error: {
            scope: "Run run-1",
            durableEffect: "The Run was not stopped.",
            recovery: "Refresh the Run and retry if it is still eligible.",
          },
        },
      },
    };
    render(<CompanionSurface {...props(state)} />);

    const error = screen.getByRole("alert", { name: "Companion action error" });
    expect(error.textContent).toContain("Run run-1");
    expect(error.textContent).toContain("Durable effect: The Run was not stopped.");
    expect(error.textContent).toContain(
      "Safe recovery: Refresh the Run and retry if it is still eligible.",
    );
  });

  it("keeps cross-Project navigation bounded at the documented Project, Task, and Attention scale", () => {
    const base = liveState();
    const projects = Array.from({ length: 100 }, (_, project) => ({
      id: `project-${project}`,
      name: `Project ${project}`,
      taskCount: 100,
      attentionCount: 10,
    }));
    const tasks = projects.flatMap((project) =>
      Array.from({ length: 100 }, (_, task) => ({
        id: `task-${project.id}-${task}`,
        projectId: project.id,
        title: `Task ${project.id}-${task}`,
        stage: "in_progress" as const,
        version: 1,
        currentRunId: null,
        outcomeAcceptancePermitted: false,
      })));
    const attention = projects.flatMap((project) =>
      Array.from({ length: 10 }, (_, item) => ({
        id: `attention-${project.id}-${item}`,
        projectId: project.id,
        taskId: `task-${project.id}-0`,
        runId: null,
        version: 1,
        kind: "review",
        title: `Attention ${project.id}-${item}`,
        safeSummary: "Canonical Attention summary.",
        acknowledged: false,
      })));
    const started = performance.now();
    render(<CompanionSurface {...props({
      ...base,
      projection: {
        ...emptyCompanionProjection(),
        projects,
        tasks,
        attention,
      },
    })} />);

    expect(performance.now() - started).toBeLessThan(2_000);
    expect(screen.getByText("Task project-0-99")).toBeTruthy();
    expect(screen.queryByText("Task project-99-99")).toBeNull();

    fireEvent.change(screen.getByLabelText("Project"), {
      target: { value: "project-99" },
    });
    expect(screen.getByText("Task project-99-99")).toBeTruthy();
    expect(screen.queryByText("Task project-0-99")).toBeNull();
  });

  it("opens a notification target across Projects and beyond the first Attention page", async () => {
    window.requestAnimationFrame = (callback) => {
      callback(0);
      return 1;
    };
    const base = liveState();
    const attention = Array.from({ length: 60 }, (_, item) => ({
      id: `attention-target-${item}`,
      projectId: "project-2",
      taskId: "task-2",
      runId: null,
      version: item + 1,
      kind: "review",
      title: `Target ${item}`,
      safeSummary: "Canonical Attention summary.",
      acknowledged: false,
    }));
    const onOpenAttention = vi.fn();
    render(<CompanionSurface
      {...props({
        ...base,
        projection: {
          ...emptyCompanionProjection(),
          projects: [
            ...base.projection.projects,
            { id: "project-2", name: "Second", taskCount: 1, attentionCount: 60 },
          ],
          tasks: [{
            id: "task-2",
            projectId: "project-2",
            title: "Second task",
            stage: "in_progress",
            version: 1,
            currentRunId: null,
            outcomeAcceptancePermitted: false,
          }],
          attention,
        },
      })}
      attentionTargetId="attention-target-55"
      onOpenAttention={onOpenAttention}
    />);

    await waitFor(() => {
      expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("project-2");
      expect(document.activeElement?.id).toBe("companion-attention-attention-target-55");
    });
    expect(onOpenAttention).toHaveBeenCalledWith("attention-target-55");
  });

  it("retries a notification target when its canonical Attention projection arrives", async () => {
    const base = liveState();
    const target = {
      id: "attention-later",
      projectId: "project-1",
      taskId: "task-1",
      runId: "run-1",
      version: 4,
      kind: "review",
      title: "Arrived later",
      safeSummary: "Canonical Attention summary.",
      acknowledged: false,
    };
    const onOpenAttention = vi.fn();
    const rendered = render(<CompanionSurface
      {...props({
        ...base,
        projection: {
          ...base.projection,
          attention: [],
        },
      })}
      attentionTargetId={target.id}
      onOpenAttention={onOpenAttention}
    />);

    expect(onOpenAttention).not.toHaveBeenCalled();

    rendered.rerender(<CompanionSurface
      {...props({
        ...base,
        projection: {
          ...base.projection,
          attention: [target],
        },
      })}
      attentionTargetId={target.id}
      onOpenAttention={onOpenAttention}
    />);

    await waitFor(() => {
      expect(document.activeElement?.id).toBe("companion-attention-attention-later");
    });
    expect(onOpenAttention).toHaveBeenCalledWith(target.id);
  });
});
