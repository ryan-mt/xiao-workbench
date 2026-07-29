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
    setOpen(true);
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

  if (!items.length && !canStash) return null;

  return (
    <div className="stashed-prompts" ref={root}>
      <button
        className="stashed-prompts__trigger"
        type="button"
        disabled={disabled}
        aria-label={items.length ? `Stashed prompts, ${items.length}` : "Stash current prompt"}
        aria-expanded={open}
        title={items.length ? "Open stashed prompts" : "Stash this prompt for later"}
        onClick={() => canStash && !items.length ? stashCurrent() : setOpen((current) => !current)}
      >
        <XiaoIcon name="pin" size={13} />
        <span>Stash</span>
        {items.length ? <b>{items.length}</b> : null}
      </button>
      {open ? (
        <section className="stashed-prompts__popover" aria-label="Stashed prompts">
          <header>
            <span><XiaoIcon name="pin" size={13} /><strong>Stashed prompts</strong></span>
            <small>{items.length}</small>
          </header>
          {canStash ? (
            <button className="stashed-prompts__save" type="button" onClick={stashCurrent}>
              <XiaoIcon name="add" size={13} />
              <span><strong>Stash current draft</strong><small>Keep it here and clear the composer</small></span>
            </button>
          ) : null}
          <div className="stashed-prompts__list">
            {items.map((item) => (
              <article key={item.id}>
                <button type="button" title={item.prompt} onClick={() => restore(item)}>
                  <span>{promptPreview(item)}</span>
                  <small>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
                </button>
                <button type="button" aria-label="Delete stashed prompt" title="Delete stashed prompt" onClick={() => remove(item.id)}>
                  <XiaoIcon name="trash" size={12} />
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
