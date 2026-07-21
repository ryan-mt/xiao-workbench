const windowsDrivePath = /^[a-z]:\//i;
const windowsUncPath = /^\/\/[^/]/;

export const normalizeWorkspacePath = (path: string) => {
  const normalized = path.replaceAll("\\", "/");
  if (normalized === "/" || normalized === "//") return normalized;
  if (/^[a-z]:\/+$/i.test(normalized)) return `${normalized.slice(0, 2)}/`;
  return normalized.replace(/\/+$/, "");
};

export const workspacePathComparisonKey = (path: string) => {
  const normalized = normalizeWorkspacePath(path);
  return windowsDrivePath.test(normalized) || windowsUncPath.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
};

export const workspacePathIsWithin = (root: string, path: string) => {
  const rootKey = workspacePathComparisonKey(root);
  const pathKey = workspacePathComparisonKey(path);
  if (!rootKey) return false;
  if (pathKey === rootKey) return true;
  const prefix = rootKey.endsWith("/") ? rootKey : `${rootKey}/`;
  return pathKey.startsWith(prefix);
};

export const workspacePathRelativeTo = (root: string, path: string) => {
  const normalizedPath = normalizeWorkspacePath(path);
  const isAbsolute = normalizedPath.startsWith("/") || windowsDrivePath.test(normalizedPath);
  if (!isAbsolute) return normalizedPath;
  if (!workspacePathIsWithin(root, normalizedPath)) return null;
  const normalizedRoot = normalizeWorkspacePath(root);
  const offset = normalizedRoot.endsWith("/") ? normalizedRoot.length : normalizedRoot.length + 1;
  return normalizedPath.slice(offset);
};
