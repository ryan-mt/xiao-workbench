export type FileNode = {
  name: string;
  path: string;
  kind: "directory" | "file";
  children: FileNode[];
};

export type GitSummary = {
  branch: string;
  repositoryRoot: string;
  workspaceScoped: boolean;
  added: number;
  modified: number;
  deleted: number;
  untracked: number;
  clean: boolean;
  changes: GitFileChange[];
  changesTruncated: boolean;
};

export type GitBranch = {
  name: string;
  current: boolean;
  remote: boolean;
};

export type GitFileChange = {
  path: string;
  status: "added" | "modified" | "deleted" | "untracked";
  additions: number;
  deletions: number;
  patch: string;
  patchTruncated: boolean;
};

export type WorkspaceSnapshot = {
  name: string;
  path: string;
  files: FileNode[];
  git: GitSummary | null;
};

export type SystemInfo = {
  platform: string;
  shell: string;
  codexVersion: string | null;
};

export type CodexUpdateStatus = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  canUpdate: boolean;
  updateMethod: string | null;
  installationSource: string;
};

export type CodexUpdateResult = {
  previousVersion: string;
  version: string;
  output: string;
};
