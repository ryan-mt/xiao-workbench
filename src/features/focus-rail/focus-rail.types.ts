export type FocusView = "plan" | "files" | "changes" | "context" | "verification" | "extensions" | "terminal" | "browser" | "run" | "schedule" | "runtime";

export type FocusResourceRequest =
  | { id: number; kind: "browser"; url: string }
  | { id: number; kind: "file"; path: string };
