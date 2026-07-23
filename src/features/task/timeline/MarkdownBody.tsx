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
import { convertFileSrc } from "@tauri-apps/api/core";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import {
  projectStreamingMarkdown,
  type MarkdownStreamProjection,
} from "./markdownStream";

const markdownPlugins = [remarkGfm];
const maxMarkdownCharacters = 200_000;
const highlightCacheLimit = 64;

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

const workspacePathHref = (value: string) => {
  const path = value.trim();
  if (/^[a-z]:[\\/]/i.test(path)) return true;
  if (!/^file:\/\//i.test(path)) return false;
  try {
    const url = new URL(path);
    return Boolean(url.hostname) || /^\/[a-z]:\//i.test(url.pathname);
  } catch {
    return false;
  }
};

export const localMarkdownImagePath = (value: string | undefined) => {
  const source = value?.trim();
  if (!source) return null;
  if (/^[a-z]:[\\/]/i.test(source) || /^\\\\[^\\]/.test(source)) return source;
  if (/^\/[a-z]:[\\/]/i.test(source)) return source.slice(1);
  if (source.startsWith("/") && !source.startsWith("//")) return source;
  if (!/^file:\/\//i.test(source)) return null;

  try {
    const url = new URL(source);
    if (url.protocol !== "file:") return null;
    const path = decodeURIComponent(url.pathname);
    if (url.hostname) return `\\\\${url.hostname}${path.replace(/\//g, "\\")}`;
    return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
};

export const markdownUrlTransform = (value: string, allowWorkspacePaths: boolean) =>
  allowWorkspacePaths && workspacePathHref(value) ? value : defaultUrlTransform(value);

type HighlightedCode = {
  code: string;
  html: string;
  language: string;
};

const highlightedCodeCache = new Map<string, HighlightedCode>();

const rememberHighlightedCode = (key: string, value: HighlightedCode) => {
  highlightedCodeCache.delete(key);
  highlightedCodeCache.set(key, value);
  if (highlightedCodeCache.size > highlightCacheLimit) {
    const oldest = highlightedCodeCache.keys().next().value;
    if (oldest) highlightedCodeCache.delete(oldest);
  }
};

const streamedTextPaceMs = 24;
const streamedTextImmediateLimit = 512;
const streamedTextBoundary = /[\s.,!?;:)\]]/;

const pacedStep = (remaining: number) => {
  if (remaining <= 12) return 2;
  if (remaining <= 48) return 4;
  if (remaining <= 96) return 8;
  return Math.min(256, Math.ceil(remaining / 4));
};

const nextPacedEnd = (text: string, start: number) => {
  const end = Math.min(text.length, start + pacedStep(text.length - start));
  const boundary = Math.min(text.length, end + 8);
  for (let index = end; index < boundary; index += 1) {
    if (streamedTextBoundary.test(text[index] ?? "")) return index + 1;
  }
  return end;
};

const usePacedStreamingText = (content: string, streaming: boolean) => {
  const [visible, setVisible] = useState(content);
  const visibleRef = useRef(content);
  const contentRef = useRef(content);
  const streamingRef = useRef(streaming);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    contentRef.current = content;
    streamingRef.current = streaming;

    const clear = () => {
      if (timerRef.current === null) return;
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    const sync = (value: string) => {
      visibleRef.current = value;
      setVisible(value);
    };
    const advance = () => {
      timerRef.current = null;
      const latest = contentRef.current;
      const shown = visibleRef.current;
      if (!streamingRef.current || !latest.startsWith(shown) || latest.length <= shown.length) {
        sync(latest);
        return;
      }
      const end = nextPacedEnd(latest, shown.length);
      sync(latest.slice(0, end));
      if (end < latest.length) timerRef.current = window.setTimeout(advance, streamedTextPaceMs);
    };

    clear();
    const shown = visibleRef.current;
    if (
      !streaming ||
      !content.startsWith(shown) ||
      content.length <= shown.length ||
      content.length - shown.length <= streamedTextImmediateLimit
    ) {
      sync(content);
      return clear;
    }
    timerRef.current = window.setTimeout(advance, streamedTextPaceMs);
    return clear;
  }, [content, streaming]);

  return streaming ? visible : content;
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

function MarkdownImage({
  node: _node,
  src,
  alt,
  onError,
  ...props
}: ComponentProps<"img"> & { node?: unknown }) {
  const [failed, setFailed] = useState(false);
  const localPath = localMarkdownImagePath(src);
  const tauriHost = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const resolvedSource = localPath
    ? tauriHost
      ? convertFileSrc(localPath)
      : null
    : src;
  const label = alt || localPath?.split(/[\\/]/).pop() || "Image";

  if (!resolvedSource || failed) {
    return (
      <span
        className="markdown-image-fallback"
        role="img"
        aria-label={`${label}: image unavailable`}
        title={localPath ?? src}
      >
        <XiaoIcon name="file" size={14} />
        <span>{label}</span>
        <small>{localPath ? "Open Xiao desktop to view this local image" : "Image unavailable"}</small>
      </span>
    );
  }

  return (
    <img
      {...props}
      src={resolvedSource}
      alt={alt}
      data-local-image={localPath ? "true" : undefined}
      decoding={props.decoding ?? "async"}
      loading={props.loading ?? "lazy"}
      onError={(event) => {
        onError?.(event);
        setFailed(true);
      }}
    />
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
  const codeKind = shellLanguages.has(language) || shellLanguages.has(normalizedLanguage) ? "shell" : "source";
  const cacheKey = `${normalizedLanguage}\u0000${code}`;
  const [highlighted, setHighlighted] = useState<HighlightedCode | null>(null);
  const [wrapped, setWrapped] = useState(false);

  useEffect(() => {
    if (!code.trim() || code.length > 60_000 || ["code", "text", "txt", "plaintext"].includes(language)) {
      return;
    }

    const cached = highlightedCodeCache.get(cacheKey);
    if (cached) {
      setHighlighted(cached);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const highlight = async () => {
        try {
          const highlighter = await import("./highlightCode");
          if (!highlighter.isHighlightLanguage(normalizedLanguage)) return;
          const html = await highlighter.highlightCode(code, normalizedLanguage);
          if (!cancelled) {
            const value = { code, html, language };
            rememberHighlightedCode(cacheKey, value);
            setHighlighted(value);
          }
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
  }, [cacheKey, code, language, normalizedLanguage, streaming]);

  const highlightedHtml =
    highlighted?.code === code && highlighted.language === language ? highlighted.html : null;

  return (
    <div
      className="markdown-code"
      data-code-kind={codeKind}
      data-language={normalizedLanguage}
      data-wrap={wrapped ? "true" : "false"}
    >
      <span className="markdown-code__actions">
        <button
          className="markdown-code__wrap"
          type="button"
          aria-pressed={wrapped}
          onClick={() => setWrapped((value) => !value)}
        >
          {wrapped ? "Scroll" : "Wrap"}
        </button>
        <CopyButton text={code} />
      </span>
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
    img: (props: ComponentProps<"img"> & { node?: unknown }) => <MarkdownImage {...props} />,
    a: ({ children, node: _node, href, onClick, ...props }: ComponentProps<"a"> & { node?: unknown }) => {
      const internalResource = Boolean(href && workspacePathHref(href));
      return (
        <a
          {...props}
          href={internalResource ? "#" : href}
          target={!internalResource && href ? "_blank" : undefined}
          rel={!internalResource && href ? "noopener noreferrer" : undefined}
          onClick={(event) => {
            onClick?.(event);
            if (!event.defaultPrevented && href && onOpenResource) {
              const handled = onOpenResource(href);
              if (handled || internalResource) event.preventDefault();
            } else if (!event.defaultPrevented && internalResource) {
              event.preventDefault();
            }
          }}
        >{children}</a>
      );
    },
  }), [onOpenResource, streaming]);

  return (
    <ReactMarkdown
      remarkPlugins={markdownPlugins}
      urlTransform={(value, key) =>
        key === "src" && localMarkdownImagePath(value)
          ? value
          : markdownUrlTransform(value, Boolean(onOpenResource))}
      components={components}
    >
      {source}
    </ReactMarkdown>
  );
});

const ProjectedMarkdownBody = memo(function ProjectedMarkdownBody({
  content,
  streaming,
  onOpenResource,
}: {
  content: string;
  streaming: boolean;
  onOpenResource?: (target: string) => boolean;
}) {
  const pacedContent = usePacedStreamingText(content, streaming);
  const projectionRef = useRef<MarkdownStreamProjection | undefined>(undefined);
  const projection = useMemo(
    () => projectStreamingMarkdown(projectionRef.current, pacedContent, streaming),
    [pacedContent, streaming],
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

export const MarkdownBody = memo(function MarkdownBody({
  content,
  streaming = false,
  onOpenResource,
}: {
  content: string;
  streaming?: boolean;
  onOpenResource?: (target: string) => boolean;
}) {
  if (content.length > maxMarkdownCharacters) {
    return (
      <div className="markdown-body markdown-body--huge">
        <div className="markdown-huge-text">
          <header>
            <span>Large response · shown as plain text</span>
            <CopyButton text={content} />
          </header>
          <pre>{content}</pre>
        </div>
      </div>
    );
  }

  return (
    <ProjectedMarkdownBody
      content={content}
      streaming={streaming}
      onOpenResource={onOpenResource}
    />
  );
});
