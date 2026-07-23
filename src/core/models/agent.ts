export type RuntimePhase = "offline" | "starting" | "ready" | "working" | "error";
export type AgentTurnOutcome = "completed" | "failed" | "interrupted";

export type AgentMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

export type AgentExplorationAction = {
  kind: "list" | "read" | "search";
  command: string;
  label: string;
  path?: string;
  query?: string;
};

export type AgentQuestionOption = {
  label: string;
  description: string;
};

export type AgentQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: AgentQuestionOption[];
};

export type AgentQuestionRequest = {
  requestId: number | string;
  pendingInputId: string;
  runId: string;
  taskId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: AgentQuestion[];
  autoResolutionMs: number | null;
  receivedAt: number;
};

export type AgentMcpElicitationOption = {
  value: string;
  label: string;
};

type AgentMcpElicitationFieldBase = {
  name: string;
  label: string;
  description: string;
  required: boolean;
};

export type AgentMcpElicitationField = AgentMcpElicitationFieldBase & (
  | {
      kind: "text";
      format: "text" | "email" | "uri" | "date" | "date-time";
      minLength: number | null;
      maxLength: number | null;
      defaultValue: string | null;
    }
  | {
      kind: "number";
      integer: boolean;
      minimum: number | null;
      maximum: number | null;
      defaultValue: number | null;
    }
  | {
      kind: "boolean";
      defaultValue: boolean | null;
    }
  | {
      kind: "select";
      options: AgentMcpElicitationOption[];
      defaultValue: string | null;
    }
  | {
      kind: "multi-select";
      options: AgentMcpElicitationOption[];
      minItems: number | null;
      maxItems: number | null;
      defaultValue: string[];
    }
  | {
      kind: "unsupported";
      schemaType: string;
    }
);

export type AgentMcpElicitationRequest = {
  requestId: number | string;
  pendingInputId: string;
  runId: string;
  taskId: string;
  threadId: string;
  turnId: string;
  serverName: string;
  message: string;
  fields: AgentMcpElicitationField[];
  receivedAt: number;
};

export type AgentMcpElicitationResponse = {
  action: "accept" | "decline";
  content: Record<string, unknown> | null;
  _meta: null;
};

export type AgentApprovalRequestKind = "action" | "permissions";

export type AgentCollaboratorStatus =
  | "pendingInit"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"
  | "shutdown"
  | "notFound"
  | "unknown";

export type AgentCollaborator = {
  threadId: string;
  status: AgentCollaboratorStatus;
  message: string | null;
};

export type TimelineEntry = {
  id: string;
  kind: "brief" | "thought" | "command" | "explore" | "change" | "result" | "approval" | "user" | "agent";
  title: string;
  createdAt?: number;
  body?: string;
  meta?: string;
  status?: "idle" | "active" | "success" | "warning" | "error";
  command?: string;
  exploration?: AgentExplorationAction[];
  files?: Array<{ path: string; additions: number; deletions: number; patch?: string }>;
  attachments?: AgentAttachment[];
  requestId?: number | string;
  pendingInputId?: string;
  runId?: string;
  approvalKind?: AgentApprovalRequestKind;
  approvalPermissions?: Record<string, unknown>;
  turnId?: string;
  turnDiff?: string;
  collaborators?: AgentCollaborator[];
  collaborationTool?: "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent";
};

export type AgentRuntimeState = {
  phase: RuntimePhase;
  taskId: string | null;
  threadId: string | null;
  turnId: string | null;
  turnStartedAt: number | null;
  error: string | null;
  eventsSeen: number;
};

export type AgentAttachment = {
  id?: string;
  name: string;
  path: string;
  kind: "directory" | "file" | "image" | "review";
  url?: string;
  lineStart?: number;
  lineEnd?: number;
  comment?: string;
  preview?: string;
};

export type AgentFollowUp = {
  id: string;
  prompt: string;
  attachments: AgentAttachment[];
  createdAt: number;
};

const selectedContextIntroduction = [
  "Use this text selected from the current conversation as context:",
  "",
].join("\n") + "\n";
const selectedContextPrefix = `${selectedContextIntroduction}<selected_text>\n`;
const selectedContextSuffix = "\n</selected_text>\n\n";

export const selectedContextPromptParts = (value: string) => {
  if (!value.startsWith(selectedContextIntroduction)) return null;
  const framedHeader = /^<selected_text length="(\d+)">\n/.exec(
    value.slice(selectedContextIntroduction.length),
  );
  if (framedHeader) {
    const contextLength = Number(framedHeader[1]);
    const contextStart = selectedContextIntroduction.length + framedHeader[0].length;
    const suffixIndex = contextStart + contextLength;
    if (
      !Number.isSafeInteger(contextLength) ||
      value.slice(suffixIndex, suffixIndex + selectedContextSuffix.length) !== selectedContextSuffix
    ) return null;
    return {
      context: value.slice(contextStart, suffixIndex),
      prompt: value.slice(suffixIndex + selectedContextSuffix.length).trim(),
    };
  }
  if (!value.startsWith(selectedContextPrefix)) return null;
  const suffixIndex = value.lastIndexOf(selectedContextSuffix);
  if (suffixIndex < selectedContextPrefix.length) return null;
  return {
    context: value.slice(selectedContextPrefix.length, suffixIndex).trim(),
    prompt: value.slice(suffixIndex + selectedContextSuffix.length).trim(),
  };
};

export const promptWithSelectedContext = (prompt: string, selectedContext: string | null) => {
  const context = selectedContext?.trim();
  if (!context) return prompt;
  const request = prompt.trim() || "Please respond to this selection.";
  const prefix = context.includes(selectedContextSuffix) || request.includes(selectedContextSuffix)
    ? `${selectedContextIntroduction}<selected_text length="${context.length}">\n`
    : selectedContextPrefix;
  return `${prefix}${context}${selectedContextSuffix}${request}`;
};

export const visiblePromptFromSelectedContext = (value: string) =>
  selectedContextPromptParts(value)?.prompt || value;

export const replaceVisiblePromptInSelectedContext = (value: string, prompt: string) => {
  const parts = selectedContextPromptParts(value);
  return parts ? promptWithSelectedContext(prompt, parts.context) : prompt;
};

export type AgentUndoResult = {
  prompt: string;
  attachments: AgentAttachment[];
  timeline?: TimelineEntry[];
  resetTitle?: boolean;
};

export type AgentMode = "default" | "plan";
export type AgentApprovalPolicy = "never" | "on-request" | "untrusted";
export type AgentSandboxMode = "danger-full-access" | "read-only" | "workspace-write";

export type AgentGoal = {
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
};

export type AgentPlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

export type AgentPlan = {
  explanation: string | null;
  steps: AgentPlanStep[];
};

export type RuntimeLogEntry = {
  id: string;
  timestamp: number;
  stream: "system" | "event" | "stdout" | "stderr";
  text: string;
};

export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type ThreadTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
};

export const normalizeThreadTokenUsage = (
  usage: ThreadTokenUsage | TokenUsageBreakdown | null,
  fallbackContextWindow?: number | null,
): ThreadTokenUsage | null => {
  if (!usage) return null;
  if ("total" in usage && "last" in usage) return usage;
  return {
    total: usage,
    last: usage,
    modelContextWindow: fallbackContextWindow ?? null,
  };
};

export const contextUsedPercent = (
  usage: ThreadTokenUsage | TokenUsageBreakdown | null,
  fallbackContextWindow?: number | null,
) => {
  const normalized = normalizeThreadTokenUsage(usage, fallbackContextWindow);
  if (!normalized) return null;
  const contextWindow = normalized.modelContextWindow ?? fallbackContextWindow;
  if (!contextWindow || contextWindow <= 0) return null;

  const baselineTokens = 12_000;
  if (contextWindow <= baselineTokens) return 100;
  const effectiveWindow = contextWindow - baselineTokens;
  const used = Math.max(0, normalized.last.totalTokens - baselineTokens);
  const remaining = Math.max(0, effectiveWindow - used);
  const remainingPercent = Math.round((remaining / effectiveWindow) * 100);
  return Math.min(100, Math.max(0, 100 - remainingPercent));
};

export type CodexUsageDay = TokenUsageBreakdown & {
  date: string;
};

export type CodexUsageSnapshot = {
  days: CodexUsageDay[];
  totals: TokenUsageBreakdown;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
};

export type AgentAccountSummary = {
  authenticated: boolean;
  authMode: string | null;
  email: string | null;
  planType: string | null;
  requiresOpenaiAuth: boolean;
};

export type AgentAccountUsage = {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  dailyUsageBuckets: Array<{ startDate: string; tokens: number }>;
};

export type AgentRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type AgentRateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: AgentRateLimitWindow | null;
  secondary: AgentRateLimitWindow | null;
};

export type AgentRateLimitsResponse = {
  rateLimits: AgentRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, AgentRateLimitSnapshot> | null;
};

export type AgentModelSummary = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: AgentReasoningEffortOption[];
  serviceTiers: AgentModelServiceTier[];
  contextWindow?: number | null;
};

export type AgentModelServiceTier = {
  id: string;
  name: string;
  description: string;
};

export type AgentReasoningEffortOption = {
  reasoningEffort: string;
  description: string;
};

export type XiaoHistoryItem = {
  role: "user" | "assistant";
  text: string;
};
