export type TimelineResource =
  | { kind: "browser"; url: string }
  | { kind: "html"; relativePath: string; fragment: string }
  | { kind: "file"; relativePath: string };

const supportedFileName = /^(?:AGENTS\.md|Cargo\.(?:lock|toml)|Dockerfile|Makefile|package(?:-lock)?\.json|pnpm-lock\.yaml|README(?:\.[a-z0-9]+)?|tsconfig\.json)$/i;
const supportedFileExtension = /\.(?:[cm]?[jt]sx?|css|go|html?|java|jsonc?|mdx?|php|py|rb|rs|scss|sh|sql|svelte|toml|vue|ya?ml|zig)$/i;

const decodePath = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeAbsolutePath = (value: string) => {
  const source = value.replace(/\\/g, "/");
  const drive = source.match(/^([a-zA-Z]:)(?:\/|$)/)?.[1];
  const unc = source.startsWith("//");
  const absolute = Boolean(drive) || source.startsWith("/");
  if (!absolute) return null;
  const body = drive ? source.slice(drive.length) : source;
  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  if (drive) return `${drive}/${segments.join("/")}`;
  return `${unc ? "//" : "/"}${segments.join("/")}`;
};

const localPathParts = (target: string) => {
  let value = target.trim().replace(/^<|>$/g, "");
  let fragment = "";
  const fragmentIndex = value.indexOf("#");
  if (fragmentIndex >= 0) {
    fragment = value.slice(fragmentIndex);
    value = value.slice(0, fragmentIndex);
  }
  value = value.replace(/:(\d+)(?:-(\d+))?$/, "");
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      value = decodePath(url.pathname).replace(/^\/([a-zA-Z]:\/)/, "$1");
    } catch {
      return null;
    }
  } else {
    value = decodePath(value);
  }
  return { value, fragment };
};

export const resolveTimelineResource = (
  target: string,
  executionRoot: string,
): TimelineResource | null => {
  const value = target.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return { kind: "browser", url: url.toString() };
      }
    } catch {
      return null;
    }
  }

  const parts = localPathParts(value);
  if (!parts?.value || /^[a-z][a-z0-9+.-]*:/i.test(parts.value) && !/^[a-z]:[\\/]/i.test(parts.value)) {
    return null;
  }
  const root = normalizeAbsolutePath(executionRoot);
  if (!root) return null;
  const candidate = normalizeAbsolutePath(
    /^(?:[a-z]:[\\/]|[\\/]{2}|\/)/i.test(parts.value)
      ? parts.value
      : `${root}/${parts.value}`,
  );
  if (!candidate) return null;
  const windowsPath = /^[a-z]:\//i.test(root) || root.startsWith("//");
  const comparableRoot = windowsPath ? root.toLocaleLowerCase() : root;
  const comparableCandidate = windowsPath ? candidate.toLocaleLowerCase() : candidate;
  if (
    comparableCandidate !== comparableRoot
    && !comparableCandidate.startsWith(`${comparableRoot}/`)
  ) {
    return null;
  }
  const relativePath = candidate.slice(root.length).replace(/^\//, "");
  const fileName = relativePath.split("/").at(-1) ?? "";
  if (!supportedFileName.test(fileName) && !supportedFileExtension.test(fileName)) return null;
  if (/\.html?$/i.test(fileName)) {
    return { kind: "html", relativePath, fragment: parts.fragment };
  }
  return { kind: "file", relativePath };
};
