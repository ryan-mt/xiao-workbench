import type { XiaoIconName } from "../../../components/icons/XiaoIcon";

export type SlashCommandId =
  | "review"
  | "test"
  | "init"
  | "plan"
  | "goal"
  | "compact"
  | "undo"
  | "changes"
  | "files"
  | "browser"
  | "context"
  | "terminal"
  | "capabilities"
  | "runtime";

export type SlashCommand = {
  id: SlashCommandId;
  trigger: string;
  aliases?: string[];
  title: string;
  description: string;
  group: "Workflow" | "Task" | "Workspace";
  icon: XiaoIconName;
  prompt?: string;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "review",
    trigger: "review",
    title: "Review current changes",
    description: "Find bugs, regressions, security risks, and missing tests",
    group: "Workflow",
    icon: "changes",
    prompt: "Review the current workspace changes. Prioritize bugs, behavioral regressions, security risks, and missing tests. Report findings first with file and line references.",
  },
  {
    id: "test",
    trigger: "test",
    title: "Run and repair tests",
    description: "Verify the current work and fix failures caused by it",
    group: "Workflow",
    icon: "check",
    prompt: "Run the relevant checks and tests for the current changes. Fix failures caused by the changes, then report exactly what passed and what could not be verified.",
  },
  {
    id: "init",
    trigger: "init",
    title: "Build repository guidance",
    description: "Create a compact, verified AGENTS.md for future sessions",
    group: "Workflow",
    icon: "brief",
    prompt: "Create or update AGENTS.md for this repository. Inspect executable configuration and existing instructions first. Keep only verified, high-signal commands, architecture facts, conventions, and operational gotchas that a future coding agent would otherwise miss.",
  },
  { id: "plan", trigger: "plan", title: "Toggle plan mode", description: "Plan the approach before implementation", group: "Task", icon: "plan" },
  { id: "goal", trigger: "goal", title: "Set task goal", description: "Keep a persistent objective above the conversation", group: "Task", icon: "target" },
  {
    id: "compact",
    trigger: "compact",
    aliases: ["summarize"],
    title: "Compact session context",
    description: "Summarize earlier history and free context space",
    group: "Task",
    icon: "result",
  },
  { id: "undo", trigger: "undo", title: "Undo last turn", description: "Restore the task and workspace checkpoint", group: "Task", icon: "undo" },
  { id: "changes", trigger: "changes", title: "Inspect working changes", description: "Open the scoped diff and repository actions", group: "Workspace", icon: "changes" },
  { id: "files", trigger: "files", title: "Browse workspace files", description: "Open the file tree and source preview", group: "Workspace", icon: "files" },
  { id: "browser", trigger: "browser", title: "Open research browser", description: "Browse Google, YouTube, and research links inside Xiao", group: "Workspace", icon: "browser" },
  { id: "context", trigger: "context", title: "Inspect session context", description: "Review token usage and active context", group: "Workspace", icon: "result" },
  { id: "terminal", trigger: "terminal", title: "Open terminal", description: "Use the shell rooted in this workspace", group: "Workspace", icon: "terminal" },
  { id: "capabilities", trigger: "capabilities", title: "Open capabilities", description: "Inspect skills, plugins, MCP servers, and apps", group: "Workspace", icon: "capability" },
  { id: "runtime", trigger: "runtime", title: "Inspect runtime", description: "Open Codex connection details and logs", group: "Workspace", icon: "runtime" },
];

const slashCommandIdentifiers = (command: SlashCommand) => [
  command.trigger,
  ...(command.aliases ?? []),
].map((value) => value.toLocaleLowerCase());

export const filterSlashCommands = (commands: SlashCommand[], query: string) => {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return commands;

  const exact = commands.filter((command) =>
    slashCommandIdentifiers(command).includes(normalized),
  );
  if (exact.length) return exact;

  return commands.filter((command) =>
    slashCommandIdentifiers(command).some((identifier) => identifier.startsWith(normalized)) ||
    command.title.toLocaleLowerCase().includes(normalized),
  );
};

export const slashCommandDisabledReason = (
  command: SlashCommand,
  context: { canCompact: boolean; compacting: boolean; hasThread: boolean },
) => {
  if (command.id !== "compact" || context.canCompact) return null;
  if (context.compacting) return "Context compaction in progress";
  if (!context.hasThread) return "Start a conversation first";
  return "Available when the session is idle";
};
