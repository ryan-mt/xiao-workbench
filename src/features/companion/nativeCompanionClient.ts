import { nativeBridge } from "../../core/bridges/tauri";
import type { CompanionCommandEnvelope, CompanionGrant } from "../../core/models/companion";
import type {
  CompanionAction,
  CompanionCommand,
  CompanionTargetScope,
} from "./companionContract";
import type { NativeCompanionClient } from "./companionClient";

const DEFAULT_GRANTS: CompanionGrant[] = [
  "read_projects",
  "read_tasks",
  "read_runs",
  "read_attention",
  "read_safe_timeline",
  "read_conversation",
  "read_verification",
  "read_observatory",
  "resolve_pending_input",
  "stop_run",
  "retry_run",
  "send_follow_up",
  "create_task",
  "acknowledge_attention",
  "accept_outcome",
];

const capability = (action: CompanionAction) => {
  switch (action.kind) {
    case "resolve_pending_input":
      return action.inputKind === "approval"
        ? "resolve_approval"
        : action.inputKind === "question"
          ? "resolve_question"
          : "resolve_mcp_elicitation";
    case "stop_run": return "stop_run";
    case "retry_run": return "retry_run";
    case "follow_up": return "send_follow_up";
    case "acknowledge_attention": return "acknowledge_attention";
    case "accept_outcome": return "accept_outcome";
  }
};

const target = (
  action: CompanionAction,
  scope: CompanionTargetScope,
): CompanionCommandEnvelope["target"] => {
  switch (action.kind) {
    case "resolve_pending_input":
      return { kind: "pending_input", id: action.pendingInputId, projectId: scope.projectId };
    case "stop_run":
    case "retry_run":
    case "follow_up":
      return { kind: "run", id: action.runId, projectId: scope.projectId };
    case "acknowledge_attention":
      return { kind: "attention", id: action.attentionId, projectId: scope.projectId };
    case "accept_outcome":
      return { kind: "task", id: action.taskId, projectId: scope.projectId };
  }
};

const payload = (action: CompanionAction) => {
  switch (action.kind) {
    case "resolve_pending_input": return { optionId: action.optionId };
    case "follow_up": return { message: action.message };
    default: return {};
  }
};

const envelope = (
  command: CompanionCommand,
  session: Parameters<NativeCompanionClient["command"]>[0],
): CompanionCommandEnvelope => ({
  sessionId: session.sessionId,
  sessionGeneration: session.generation,
  deviceId: session.deviceId,
  commandId: command.commandId,
  idempotencyKey: command.idempotencyKey,
  expectedVersion: command.expectedEntityVersion,
  target: target(command.action, command.targetScope),
  auditTimestamp: command.auditTimestamp,
  capability: capability(command.action),
  payload: payload(command.action),
});

export const nativeCompanionClient: NativeCompanionClient = {
  async pair(request) {
    const pairingCode = JSON.stringify({
      endpoint: request.endpoint,
      serverName: request.serverName,
      certificatePem: request.certificatePem,
      certificateFingerprint: request.certificateFingerprint,
      pairingId: request.pairingId,
      ownerCredential: request.ownerCredential,
      expiresAt: request.expiresAt,
    });
    const session = await nativeBridge.pairRemoteCompanion(
      pairingCode,
      request.deviceId,
      request.deviceName,
      DEFAULT_GRANTS,
    );
    return {
      session,
      certificateFingerprint: session.certificateFingerprint,
    };
  },
  poll(session, cursor) {
    return nativeBridge.pollRemoteCompanion(session.referenceId, cursor, 500);
  },
  confirmReconciled(session, cursor) {
    return nativeBridge.confirmRemoteCompanion(session.referenceId, cursor);
  },
  pollNotifications(session, cursor) {
    return nativeBridge.pollRemoteCompanionNotifications(session.referenceId, cursor);
  },
  async command(session, command) {
    const request = envelope(command, session);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await nativeBridge.executeRemoteCompanionCommand(
        session.referenceId,
        request,
      );
      if (result.state === "succeeded" && result.acknowledgement) {
        return {
          status: "acknowledged",
          acknowledgedAt: result.acknowledgement.acknowledgedAt,
        };
      }
      if (result.state === "refused") {
        return {
          status: "rejected",
          rejectedAt: Date.now(),
          error: {
            scope: result.refusalCode ?? "The primary host refused this Companion action.",
            durableEffect: "No host acknowledgement was recorded.",
            recovery: result.message ?? "Refresh current host state before trying again.",
          },
        };
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 200));
    }
    throw new Error("The primary host did not acknowledge the Companion action in time.");
  },
  installRotation(session, rotationCode) {
    return nativeBridge.installRemoteCompanionRotation(session.referenceId, rotationCode);
  },
  delete(session) {
    return nativeBridge.forgetRemoteCompanion(session.referenceId);
  },
};
