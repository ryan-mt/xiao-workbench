export type WorkspaceServiceError = {
  workspacePath: string | null;
  message: string;
};

const comparableWorkspacePath = (path: string) => {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
};

export const workspaceServiceErrorMessage = (
  workspacePath: string,
  error: WorkspaceServiceError,
) => error.workspacePath &&
  comparableWorkspacePath(error.workspacePath) === comparableWorkspacePath(workspacePath)
    ? error.message
    : null;
