import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import {
  projectStreamingMarkdown,
  type MarkdownStreamProjection,
} from "./markdownStream";

const markdownPlugins = [remarkGfm];

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

const workspacePathHref = (value: string) =>
  /^(?:[a-z]:[\\/]|file:\/\/\/[a-z]:[\\/])/i.test(value.trim());

export const markdownUrlTransform = (value: string, allowWorkspacePaths: boolean) =>
  allowWorkspacePaths && workspacePathHref(value) ? value : defaultUrlTransform(value);

type HighlightedCode = {
  code: string;
  html: string;
  language: string;
};

function InlineCode({
  children,
  className,
  node: _node,
  onOpenResource,
  ...props
}: ComponentProps<"code"> & {
  node?: unknown;
  onOpenResource?: (target: string) => boolean;
}) {
  const text = childText(children);
  const kind = className ? undefined : inlineCodeKind(text);
  const interactive = Boolean(kind && onOpenResource);
  return (
    <code
      {...props}
      className={className}
      data-inline-code-kind={kind}
      role={interactive ? "link" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? () => onOpenResource?.(text) : undefined}
      onKeyDown={interactive ? (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpenResource?.(text);
      } : undefined}
    >{children}</code>
  );
}

const CodeCard = memo(function CodeCard({
  code,
  language = "text",
  streaming,
}: {
  code: string;
  language?: string;
  streaming: boolean;
}) {
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
        <pre><code className={language === "text" ? undefined : `language-${language}`}>{code}</code></pre>
      )}
    </div>
  );
});

function CodeBlock({ children, streaming }: { children: ReactNode; streaming: boolean }) {
  const child = Children.toArray(children).find(isValidElement);
  const element = isValidElement(child)
    ? (child as ReactElement<{ className?: string; children?: ReactNode }>)
    : null;
  const code = childText(element?.props.children ?? child);
  const language = element?.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase() ?? "text";
  return <CodeCard code={code} language={language} streaming={streaming} />;
}

const MarkdownChunk = memo(function MarkdownChunk({
  source,
  streaming,
  onOpenResource,
}: {
  source: string;
  streaming: boolean;
  onOpenResource?: (target: string) => boolean;
}) {
  const components = useMemo(() => ({
    pre: ({ children }: ComponentProps<"pre">) => <CodeBlock streaming={streaming}>{children}</CodeBlock>,
    code: (props: ComponentProps<"code"> & { node?: unknown }) => (
      <InlineCode {...props} onOpenResource={onOpenResource} />
    ),
    table: ({ children, node: _node, ...props }: ComponentProps<"table"> & { node?: unknown }) => (
      <div className="markdown-table" role="region" aria-label="Scrollable table" tabIndex={0}>
        <table {...props}>{children}</table>
      </div>
    ),
    a: ({ children, node: _node, href, onClick, ...props }: ComponentProps<"a"> & { node?: unknown }) => (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented && href && onOpenResource) {
            const handled = onOpenResource(href);
            if (handled || workspacePathHref(href)) event.preventDefault();
          } else if (!event.defaultPrevented && href && workspacePathHref(href)) {
            event.preventDefault();
          }
        }}
      >{children}</a>
    ),
  }), [onOpenResource, streaming]);

  return (
    <ReactMarkdown
      remarkPlugins={markdownPlugins}
      urlTransform={(value) => markdownUrlTransform(value, Boolean(onOpenResource))}
      components={components}
    >
      {source}
    </ReactMarkdown>
  );
});

export const MarkdownBody = memo(function MarkdownBody({
  content,
  streaming = false,
  onOpenResource,
}: {
  content: string;
  streaming?: boolean;
  onOpenResource?: (target: string) => boolean;
}) {
  const projectionRef = useRef<MarkdownStreamProjection | undefined>(undefined);
  const projection = useMemo(
    () => projectStreamingMarkdown(projectionRef.current, content, streaming),
    [content, streaming],
  );
  projectionRef.current = projection;

  return (
    <div className={`markdown-body ${streaming ? "is-streaming" : ""}`} aria-busy={streaming}>
      {projection.blocks.map((block, index) =>
        block.mode === "code" ? (
          <CodeCard
            code={block.source}
            key={`${index}:code`}
            language={block.language}
            streaming={streaming && !block.complete}
          />
        ) : (
          <MarkdownChunk
            key={`${index}:${block.mode}`}
            source={block.source}
            streaming={streaming && block.mode === "live"}
            onOpenResource={onOpenResource}
          />
        ),
      )}
    </div>
  );
});
