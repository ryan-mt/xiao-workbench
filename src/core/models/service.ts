import { workspacePathComparisonKey } from "../workspacePath";

export type WorkspaceServiceError = {
  workspacePath: string | null;
  message: string;
};

export const workspaceServiceErrorMessage = (
  workspacePath: string,
  error: WorkspaceServiceError,
) => error.workspacePath === null ||
  workspacePathComparisonKey(error.workspacePath) === workspacePathComparisonKey(workspacePath)
    ? error.message
    : null;
