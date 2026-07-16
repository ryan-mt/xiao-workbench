import type { CSSProperties } from "react";

import type { AgentReasoningEffortOption } from "../../../core/models/agent";

type ReasoningControlProps = {
  options: AgentReasoningEffortOption[];
  defaultEffort: string;
  selectedEffort: string | null;
  onChange: (effort: string | null) => void;
};

const labels: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Xhigh",
  ultra: "Ultra",
};

export const reasoningLabel = (effort: string) =>
  labels[effort] ?? effort.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase());

export function ReasoningControl({
  options,
  defaultEffort,
  selectedEffort,
  onChange,
}: ReasoningControlProps) {
  const fallbackEffort = defaultEffort || options[0]?.reasoningEffort || "medium";
  const effectiveEffort = options.some((option) => option.reasoningEffort === selectedEffort)
    ? selectedEffort!
    : fallbackEffort;
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.reasoningEffort === effectiveEffort),
  );
  const activeOption = options[activeIndex];
  const progress = options.length > 1 ? (activeIndex / (options.length - 1)) * 100 : 0;

  if (!options.length) {
    return (
      <section className="reasoning-control reasoning-control--empty">
        <span>Thinking</span>
        <p>This model does not advertise adjustable reasoning.</p>
      </section>
    );
  }

  return (
    <section
      className={`reasoning-control${effectiveEffort === "ultra" ? " reasoning-control--ultra" : ""}`}
    >
      <header>
        <div>
          <span>Thinking</span>
          <strong>{reasoningLabel(effectiveEffort)}</strong>
        </div>
        {effectiveEffort === defaultEffort && <small>Model default</small>}
      </header>

      <p>{activeOption?.description || "Balance response speed with reasoning depth."}</p>

      <div className="reasoning-control__track">
        <input
          type="range"
          min={0}
          max={Math.max(1, options.length - 1)}
          step={1}
          value={activeIndex}
          aria-label="Thinking depth"
          disabled={options.length < 2}
          style={{ "--reasoning-progress": `${progress}%` } as CSSProperties}
          onChange={(event) => {
            const next = options[Number(event.currentTarget.value)]?.reasoningEffort;
            if (next) onChange(next === defaultEffort ? null : next);
          }}
        />
        <div className="reasoning-control__ticks" aria-hidden="true">
          {options.map((option, index) => (
            <i className={index <= activeIndex ? "is-active" : ""} key={option.reasoningEffort} />
          ))}
        </div>
      </div>

      <footer>
        <span>Faster</span>
        <span>Deeper</span>
      </footer>
    </section>
  );
}
