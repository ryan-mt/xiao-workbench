const previewTokenPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isTaskPreviewTarget = (value: string) => {
  try {
    const url = new URL(value);
    if (url.protocol === "xiao-preview:") {
      return previewTokenPattern.test(url.hostname);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname === "localhost" ||
      url.hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname) ||
      (url.hostname.startsWith("xiao-preview.") &&
        previewTokenPattern.test(url.hostname.slice("xiao-preview.".length)));
  } catch {
    return false;
  }
};

const safeLabelPart = (value: string, length: number) =>
  value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, length);

const previewScopeHash = (workspacePath: string, taskId: string) => {
  let hash = 14_695_981_039_346_656_037n;
  const bytes = new TextEncoder().encode(`${workspacePath}\0${taskId}`);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return hash.toString(16).padStart(16, "0");
};

export const taskPreviewWebviewLabel = (workspacePath: string, taskId: string, tabId?: string) => {
  const task = safeLabelPart(taskId, 12);
  return `xiao-task-preview-${previewScopeHash(workspacePath, taskId)}-${task}${tabId ? `--${safeLabelPart(tabId, 8)}` : ""}`;
};
