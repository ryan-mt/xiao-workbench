"use client";

import { useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="command-box">
      <code>{command}</code>
      <button type="button" onClick={copy} aria-label="Copy command">
        {copied ? <Check size={18} weight="bold" /> : <Copy size={18} />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
