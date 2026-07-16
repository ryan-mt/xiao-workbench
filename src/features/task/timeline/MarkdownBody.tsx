import {
  Children,
  isValidElement,
  useEffect,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remend from "remend";
import remarkGfm from "remark-gfm";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";

const copyText = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through for WebViews where the Clipboard API exists but is permission-gated.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard write failed");
};

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      className="copy-button"
      type="button"
      aria-label={`${label} to clipboard`}
      onClick={() => {
        void copyText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        });
      }}
    >
      <XiaoIcon name={copied ? "check" : "copy"} size={13} />
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}

const nodeText = (children: ReactNode): string =>
  Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (!isValidElement(child)) return "";
      return nodeText((child as ReactElement<{ children?: ReactNode }>).props.children);
    })
    .join("");

const childText = (children: ReactNode) => nodeText(children).replace(/\n$/, "");

const languageAliases: Record<string, string> = {
  "c#": "csharp",
  "c++": "cpp",
  cjs: "javascript",
  cs: "csharp",
  htm: "html",
  js: "javascript",
  jsx: "jsx",
  jsonc: "json",
  md: "markdown",
  mjs: "javascript",
  ps1: "powershell",
  pwsh: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  ts: "typescript",
  tsx: "tsx",
  yml: "yaml",
  zsh: "bash",
};

const languageLabels: Record<string, string> = {
  bash: "Shell",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  html: "HTML",
  javascript: "JavaScript",
  json: "JSON",
  markdown: "Markdown",
  powershell: "PowerShell",
  python: "Python",
  rust: "Rust",
  sql: "SQL",
  text: "Plain text",
  tsx: "TSX",
  typescript: "TypeScript",
  yaml: "YAML",
};

const shellLanguages = new Set(["bash", "console", "fish", "powershell", "sh", "shell", "terminal", "zsh"]);

const pathFileNames = /^(?:AGENTS\.md|Cargo\.(?:lock|toml)|Dockerfile|Makefile|package(?:-lock)?\.json|pnpm-lock\.yaml|README(?:\.[a-z0-9]+)?|tsconfig\.json)$/i;
const pathExtension = /\.(?:[cm]?[jt]sx?|css|go|html?|java|jsonc?|mdx?|php|py|rb|rs|scss|sh|sql|svelte|toml|vue|ya?ml|zig)$/i;

const inlineCodeKind = (text: string): "path" | "url" | undefined => {
  const value = text.trim();
  if (/^https?:\/\/[^\s]+$/i.test(value)) return "url";
  if (!value || /\s/.test(value) || /[()[\]{}*+=<>|&^"';]/.test(value)) return undefined;
  if (
    /^(?:[a-z]:[\\/]|\.{0,2}[\\/])/i.test(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    pathFileNames.test(value) ||
    pathExtension.test(value)
  ) {
    return "path";
  }
  return undefined;
};

type HighlightedCode = {
  code: string;
  html: string;
  language: string;
};

function InlineCode({
  children,
  className,
  node: _node,
  ...props
}: ComponentProps<"code"> & { node?: unknown }) {
  const text = childText(children);
  const kind = className ? undefined : inlineCodeKind(text);
  return <code {...props} className={className} data-inline-code-kind={kind}>{children}</code>;
}

function CodeBlock({ children, streaming }: { children: ReactNode; streaming: boolean }) {
  const child = Children.toArray(children).find(isValidElement);
  const element = isValidElement(child)
    ? (child as ReactElement<{ className?: string; children?: ReactNode }>)
    : null;
  const code = childText(element?.props.children ?? child);
  const language = element?.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase() ?? "text";
  const normalizedLanguage = languageAliases[language] ?? language;
  const label = languageLabels[normalizedLanguage] ?? normalizedLanguage.toUpperCase();
  const lineCount = code ? code.split("\n").length : 0;
  const codeKind = shellLanguages.has(language) || shellLanguages.has(normalizedLanguage) ? "shell" : "source";
  const [highlighted, setHighlighted] = useState<HighlightedCode | null>(null);

  useEffect(() => {
    if (!code.trim() || code.length > 60_000 || ["code", "text", "txt", "plaintext"].includes(language)) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const highlight = async () => {
        try {
          const highlighter = await import("./highlightCode");
          if (!highlighter.isHighlightLanguage(normalizedLanguage)) return;
          const html = await highlighter.highlightCode(code, normalizedLanguage);
          if (!cancelled) setHighlighted({ code, html, language });
        } catch {
          // Keep the readable plain-code fallback when a grammar cannot be loaded.
        }
      };
      void highlight();
    }, streaming ? 120 : 20);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, language, normalizedLanguage, streaming]);

  const highlightedHtml =
    highlighted?.code === code && highlighted.language === language ? highlighted.html : null;

  return (
    <div className="markdown-code" data-code-kind={codeKind} data-language={normalizedLanguage}>
      <header>
        <span>
          <XiaoIcon name={codeKind === "shell" ? "command" : "file"} size={13} />
          <strong>{label}</strong>
          <small>{lineCount} {lineCount === 1 ? "line" : "lines"}</small>
        </span>
        <CopyButton text={code} />
      </header>
      {highlightedHtml ? (
        <div className="markdown-code__highlight" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
      ) : (
        <pre><code className={element?.props.className}>{code}</code></pre>
      )}
    </div>
  );
}

export function MarkdownBody({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const rendered = streaming ? remend(content, { linkMode: "text-only" }) : content;

  return (
    <div className={`markdown-body ${streaming ? "is-streaming" : ""}`} aria-busy={streaming}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <CodeBlock streaming={streaming}>{children}</CodeBlock>,
          code: InlineCode,
          table: ({ children, node: _node, ...props }) => (
            <div className="markdown-table" role="region" aria-label="Scrollable table" tabIndex={0}>
              <table {...props}>{children}</table>
            </div>
          ),
          a: ({ children, node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>
          ),
        }}
      >
        {rendered}
      </ReactMarkdown>
    </div>
  );
}
