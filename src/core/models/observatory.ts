import type { PendingInputKind } from "./run";

export type ObservatoryAgentStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted"
  | "shutdown"
  | "unknown";

export type ObservatoryActivityCategory =
  | "status"
  | "tools"
  | "approvals"
  | "changes"
  | "verification";

export type ObservatoryAgentNode = {
  threadId: string;
  parentThreadId: string | null;
  depth: number;
  label: string;
  status: ObservatoryAgentStatus;
  model: string | null;
  reasoningEffort: string | null;
  startedAt: number;
  finishedAt: number | null;
  latestAction: string | null;
  latestTimelineEntryId: string | null;
  totalTokens: number | null;
  pendingInputIds: string[];
};

export type ObservatoryActivity = {
  id: string;
  runId: string;
  sequence: number;
  timestamp: number;
  category: ObservatoryActivityCategory;
  status: "active" | "success" | "warning" | "error" | "idle";
  title: string;
  detail: string | null;
  threadId: string | null;
  timelineEntryId: string | null;
};

export type ObservatorySnapshot = {
  nodes: ObservatoryAgentNode[];
  activities: ObservatoryActivity[];
};

export type TurnCheckpointSummary = {
  id: string;
  runId: string;
  turnId: string;
  prompt: string;
  runStatus: string;
  patchBytes: number;
  beforeFingerprint: string;
  afterFingerprint: string;
  createdAt: number;
  restoredAt: number | null;
};

export type RestoreTurnsResult = {
  restoreBatchId: string;
  restoredCheckpointIds: string[];
  restoredTurnCount: number;
  targetFingerprint: string;
  restoredAt: number;
};

export type ExportHandoffResult = {
  destinationPath: string;
  bundleSha256: string;
  byteLength: number;
  entryCount: number;
};

export type ImportHandoffResult = {
  taskId: string;
  runId: string;
  bundleSha256: string;
  importedAt: number;
  alreadyImported: boolean;
};

export type ObservatoryPendingInput = {
  id: string;
  threadId: string;
  kind: PendingInputKind;
};
