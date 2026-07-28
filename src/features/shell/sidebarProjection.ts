import type { TaskStage } from "../../core/models/xiao";
import type { WorkbenchTask } from "../task/task.types";

export type SidebarTaskTone =
  | "running"
  | "review"
  | "published"
  | "progress"
  | "draft"
  | "completed";

export type SidebarTaskPresentation = {
  status: string;
  tone: SidebarTaskTone;
};

const activeStagePriority: Record<TaskStage, number> = {
  ready_for_review: 0,
  published: 1,
  in_progress: 2,
  draft: 3,
  completed: 4,
};

export function sidebarTaskPresentation(
  task: Pick<WorkbenchTask, "stage" | "timelineEntryCount" | "threadId">,
  running: boolean,
): SidebarTaskPresentation {
  if (running) return { status: "Running", tone: "running" };
  if (task.stage === "ready_for_review") {
    return { status: "Ready for review", tone: "review" };
  }
  if (task.stage === "published") return { status: "Published", tone: "published" };
  if (task.stage === "completed") return { status: "Completed", tone: "completed" };
  if (
    task.stage === "draft" ||
    (task.timelineEntryCount === 0 && !task.threadId)
  ) {
    return { status: "Draft", tone: "draft" };
  }
  return { status: "In progress", tone: "progress" };
}

const compareTaskRecency = (left: WorkbenchTask, right: WorkbenchTask) =>
  Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt;

export function projectSidebarTasks(
  tasks: readonly WorkbenchTask[],
  workingTaskIds: readonly string[],
): {
  active: WorkbenchTask[];
  completed: WorkbenchTask[];
} {
  const working = new Set(workingTaskIds);
  const visible = tasks.filter((task) => !task.archived);
  const active = visible
    .filter((task) => task.stage !== "completed")
    .sort((left, right) => {
      const runningPriority =
        Number(working.has(right.id)) - Number(working.has(left.id));
      return runningPriority ||
        activeStagePriority[left.stage] - activeStagePriority[right.stage] ||
        compareTaskRecency(left, right);
    });
  const completed = visible
    .filter((task) => task.stage === "completed")
    .sort(compareTaskRecency);
  return { active, completed };
}
