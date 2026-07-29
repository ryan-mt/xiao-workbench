import { useEffect, useRef, useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentAttachment } from "../../../core/models/agent";
import "./stashed-prompts.css";

type StashedPrompt = {
  id: string;
  prompt: string;
  attachments: AgentAttachment[];
  createdAt: number;
};

type StashedPromptsProps = {
  taskId: string;
  prompt: string;
  attachments: AgentAttachment[];
  disabled?: boolean;
  onClear: () => void;
  onRestore: (prompt: string, attachments: AgentAttachment[]) => void;
};

const storageKey = (taskId: string) => `xiao.stashed-prompts.v1:${taskId}`;
const maxStashedPrompts = 24;

const readStashedPrompts = (taskId: string): StashedPrompt[] => {
  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey(taskId)) ?? "[]") as unknown;
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as Partial<StashedPrompt>;
      if (
        typeof value.id !== "string" ||
        typeof value.prompt !== "string" ||
        typeof value.createdAt !== "number" ||
        !Array.isArray(value.attachments)
      ) return [];
      return [{
        id: value.id,
        prompt: value.prompt,
        attachments: value.attachments,
        createdAt: value.createdAt,
      }];
    }).slice(0, maxStashedPrompts);
  } catch {
    return [];
  }
};

const writeStashedPrompts = (taskId: string, prompts: StashedPrompt[]) => {
  try {
    window.localStorage.setItem(storageKey(taskId), JSON.stringify(prompts.slice(0, maxStashedPrompts)));
  } catch {
    // Stashing remains optional when local storage is unavailable or full.
  }
};

const promptPreview = (prompt: StashedPrompt) =>
  prompt.prompt.trim().replace(/\s+/g, " ")
  || prompt.attachments.map((attachment) => attachment.name).join(", ")
  || "Attached context";

const relativeTime = (createdAt: number) => {
  const elapsed = Math.max(0, Date.now() - createdAt);
  if (elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const imageSource = (item: StashedPrompt) => {
  const attachment = item.attachments.find((candidate) => candidate.kind === "image");
  if (!attachment) return null;
  return attachment.url ?? null;
};

export function StashedPrompts({
  taskId,
  prompt,
  attachments,
  disabled = false,
  onClear,
  onRestore,
}: StashedPromptsProps) {
  const [items, setItems] = useState<StashedPrompt[]>(() => readStashedPrompts(taskId));
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const canStash = Boolean(prompt.trim() || attachments.length);

  useEffect(() => {
    setItems(readStashedPrompts(taskId));
    setOpen(false);
  }, [taskId]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const stashCurrent = () => {
    if (!canStash) return;
    const next = [{
      id: crypto.randomUUID(),
      prompt,
      attachments: [...attachments],
      createdAt: Date.now(),
    }, ...items].slice(0, maxStashedPrompts);
    setItems(next);
    writeStashedPrompts(taskId, next);
    onClear();
    setOpen(false);
  };

  const remove = (id: string) => {
    const next = items.filter((item) => item.id !== id);
    setItems(next);
    writeStashedPrompts(taskId, next);
  };

  const restore = (item: StashedPrompt) => {
    onRestore(item.prompt, item.attachments);
    remove(item.id);
    setOpen(false);
  };

  return (
    <div className="stashed-prompts" ref={root}>
      <button
        className="stashed-prompts__trigger"
        type="button"
        disabled={disabled || (!items.length && !canStash)}
        aria-label={items.length ? `Stashed prompts, ${items.length}` : "Stash current prompt"}
        aria-expanded={open}
        title={items.length ? "Open stashed prompts" : "Stash this prompt for later"}
        onClick={() => canStash ? stashCurrent() : setOpen((current) => !current)}
      >
        <XiaoIcon name="pin" size={13} />
        <span>Stash</span>
        {items.length ? <b>{items.length}</b> : null}
      </button>
      {open ? (
        <section className="stashed-prompts__popover" aria-label="Stashed prompts">
          <header>
            <span><XiaoIcon name="pin" size={13} /><strong>Stashed prompts — Xiao</strong></span>
          </header>
          <div className="stashed-prompts__list">
            {items.map((item) => {
              const preview = imageSource(item);
              return (
              <article key={item.id}>
                <button type="button" title={item.prompt} onClick={() => restore(item)}>
                  {preview ? <img src={preview} alt="" /> : <span className="stashed-prompts__empty"><XiaoIcon name="pin" size={13} /></span>}
                  <span>{promptPreview(item)}</span>
                  <small>{relativeTime(item.createdAt)}</small>
                </button>
                <button type="button" aria-label="Delete stashed prompt" title="Delete stashed prompt" onClick={() => remove(item.id)}>
                  <XiaoIcon name="close" size={12} />
                </button>
              </article>
            )})}
          </div>
        </section>
      ) : null}
    </div>
  );
}
