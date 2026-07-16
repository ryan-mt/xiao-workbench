import "./file-type-icon.css";

type FileTypeIconProps = {
  path: string;
  size?: number;
  className?: string;
};

type FileKind =
  | "config"
  | "css"
  | "git"
  | "go"
  | "html"
  | "image"
  | "javascript"
  | "json"
  | "markdown"
  | "npm"
  | "python"
  | "react"
  | "rust"
  | "shell"
  | "svg"
  | "typescript"
  | "file";

const fileKind = (path: string): FileKind => {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? path.toLowerCase();
  const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";

  if (name === "package.json" || name.startsWith("package-lock.") || name === "npm-shrinkwrap.json") return "npm";
  if (name === "cargo.toml" || name === "cargo.lock" || extension === "rs") return "rust";
  if (name === ".gitignore" || name === ".gitattributes" || name === ".gitmodules") return "git";
  if (extension === "tsx" || extension === "jsx") return "react";
  if (extension === "ts") return "typescript";
  if (["js", "mjs", "cjs"].includes(extension)) return "javascript";
  if (["css", "scss", "sass", "less"].includes(extension)) return "css";
  if (["html", "htm"].includes(extension)) return "html";
  if (["json", "jsonc"].includes(extension)) return "json";
  if (["md", "mdx"].includes(extension)) return "markdown";
  if (extension === "svg") return "svg";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp"].includes(extension)) return "image";
  if (["yaml", "yml", "toml", "ini", "env", "properties"].includes(extension) || name.startsWith(".env")) return "config";
  if (extension === "py") return "python";
  if (extension === "go") return "go";
  if (["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"].includes(extension)) return "shell";
  return "file";
};

export function FileTypeIcon({ path, size = 16, className }: FileTypeIconProps) {
  const kind = fileKind(path);
  const classes = ["file-type-icon", `file-type-icon--${kind}`, className].filter(Boolean).join(" ");

  return (
    <svg className={classes} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {kind === "typescript" && <><rect x="1" y="1" width="14" height="14" rx="2" fill="#3178c6" /><text x="3.1" y="11.5">TS</text></>}
      {kind === "javascript" && <><rect x="1" y="1" width="14" height="14" rx="2" fill="#f0db4f" /><text className="is-dark" x="3.2" y="11.5">JS</text></>}
      {kind === "react" && <><circle cx="8" cy="8" r="1.25" fill="#149eca" /><g fill="none" stroke="#149eca" strokeWidth="1"><ellipse cx="8" cy="8" rx="6.2" ry="2.35" /><ellipse cx="8" cy="8" rx="6.2" ry="2.35" transform="rotate(60 8 8)" /><ellipse cx="8" cy="8" rx="6.2" ry="2.35" transform="rotate(120 8 8)" /></g></>}
      {kind === "rust" && <><circle cx="8" cy="8" r="6.3" fill="#d66b32" /><circle cx="8" cy="8" r="4.8" fill="var(--canvas)" /><text className="is-rust" x="5" y="11.1">R</text></>}
      {kind === "npm" && <><rect x="1" y="3" width="14" height="10" rx="1" fill="#cb3837" /><path d="M3.1 5.4h9.8v5.2h-2.5V7H8.9v3.6H3.1z" fill="#fff" /></>}
      {kind === "html" && <><path d="M2.2 1.5h11.6l-1 11.3L8 14.5l-4.8-1.7z" fill="#e44d26" /><path d="M8 3v9.2l3.1-.9.5-5H8V4.7h3.8l.1-1.7z" fill="#f16529" /><text className="is-white" x="4.6" y="10.2">5</text></>}
      {kind === "css" && <><path d="M2.2 1.5h11.6l-1 11.3L8 14.5l-4.8-1.7z" fill="#264de4" /><path d="M8 3v9.2l3.1-.9.5-5H8V4.7h3.8l.1-1.7z" fill="#2965f1" /><text className="is-white" x="4.2" y="10.2">#</text></>}
      {kind === "json" && <><path d="M6.5 1.8c-1.4 0-2 .8-2 2.2v2c0 .8-.4 1.2-1.3 1.2v1.6c.9 0 1.3.4 1.3 1.2v2c0 1.4.6 2.2 2 2.2M9.5 1.8c1.4 0 2 .8 2 2.2v2c0 .8.4 1.2 1.3 1.2v1.6c-.9 0-1.3.4-1.3 1.2v2c0 1.4-.6 2.2-2 2.2" fill="none" stroke="#d39a20" strokeWidth="1.5" /></>}
      {kind === "markdown" && <><rect x="1" y="2.5" width="14" height="11" rx="2" fill="#56606b" /><path d="M3.1 10.8V5.2h1.5l1.7 2.1L8 5.2h1.5v5.6H8V7.4L6.3 9.5 4.6 7.4v3.4zm8.4-5.6h1.4v3h1.2l-1.9 2.2-1.9-2.2h1.2z" fill="#fff" /></>}
      {kind === "git" && <><rect x="3" y="3" width="10" height="10" rx="1.4" fill="#f05133" transform="rotate(45 8 8)" /><path d="M5.2 5.2 10.8 10.8M7 7l2-2M9 9l-2 2" fill="none" stroke="#fff" strokeWidth="1.2" /><circle cx="5.2" cy="5.2" r="1" fill="#fff" /><circle cx="10.8" cy="10.8" r="1" fill="#fff" /><circle cx="9" cy="5" r="1" fill="#fff" /></>}
      {kind === "python" && <><path d="M8 1.5c-3 0-3.2 1.3-3.2 2.6v1.2H8v.6H3.5C2.2 5.9 1 7 1 8.7c0 1.8.9 2.8 2.2 2.8h1.1V9.9c0-1.5 1.3-2.8 2.8-2.8h3.2c1.2 0 2.2-1 2.2-2.2V4c0-1.6-1.4-2.5-3.2-2.5z" fill="#3776ab" /><path d="M8 14.5c3 0 3.2-1.3 3.2-2.6v-1.2H8v-.6h4.5c1.3 0 2.5-1.1 2.5-2.8 0-1.8-.9-2.8-2.2-2.8h-1.1v1.6c0 1.5-1.3 2.8-2.8 2.8H5.7c-1.2 0-2.2 1-2.2 2.2v.9c0 1.6 1.4 2.5 3.2 2.5z" fill="#ffd43b" /><circle cx="6.5" cy="3.5" r=".65" fill="#fff" /><circle cx="9.5" cy="12.5" r=".65" fill="#fff" /></>}
      {kind === "go" && <><circle cx="8" cy="8" r="6.5" fill="#00add8" /><text className="is-white is-wide" x="2.4" y="10.7">GO</text></>}
      {kind === "svg" && <><circle cx="8" cy="8" r="5.8" fill="#ffb13b" /><path d="M8 2.2v11.6M2.2 8h11.6M3.9 3.9l8.2 8.2M12.1 3.9l-8.2 8.2" stroke="#8b4f00" strokeWidth=".8" /><circle cx="8" cy="8" r="2.3" fill="#fff" /></>}
      {kind === "image" && <><rect x="1.5" y="2" width="13" height="12" rx="2" fill="#4d9b6a" /><circle cx="5" cy="5.5" r="1.3" fill="#dff4e5" /><path d="m2.8 12 3.5-3.8 2.2 2.1 1.6-1.6 3.1 3.3z" fill="#dff4e5" /></>}
      {kind === "config" && <><rect x="2" y="2" width="12" height="12" rx="2.5" fill="#737b87" /><path d="M4.5 5.2h7M4.5 8h7M4.5 10.8h7" stroke="#fff" strokeWidth="1" /><circle cx="7" cy="5.2" r="1.2" fill="#fff" /><circle cx="10" cy="8" r="1.2" fill="#fff" /><circle cx="6" cy="10.8" r="1.2" fill="#fff" /></>}
      {kind === "shell" && <><rect x="1.5" y="2" width="13" height="12" rx="2" fill="#3e4651" /><path d="m4.2 5.2 2.5 2.3-2.5 2.3M8 10h3.6" fill="none" stroke="#fff" strokeWidth="1.2" /></>}
      {kind === "file" && <><path d="M3 1.5h6.2L13 5.3v9.2H3z" fill="var(--surface-raised)" stroke="var(--muted)" /><path d="M9.2 1.5v3.8H13" fill="none" stroke="var(--muted)" /></>}
    </svg>
  );
}
