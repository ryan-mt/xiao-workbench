import { useMemo } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentPlan, AgentRuntimeState } from "../../../core/models/agent";
import { BrowserPanel } from "./BrowserPanel";
import "../styles/xiao-run.css";

type XiaoRunPanelProps = {
  runtime: AgentRuntimeState;
  plan: AgentPlan | null;
  interactive: boolean;
};

const SUBWAY_SURFERS_URL = "https://poki.com/en/g/subway-surfers";
const GAME_WEBVIEW_LABEL = "xiao-game";

const gamePlaceholder = {
  title: "Desktop game",
  description: "Open Xiao as a desktop app to play the official browser version here.",
  meta: "Subway Surfers · poki.com",
};

const agentStatus = (runtime: AgentRuntimeState, plan: AgentPlan | null) => {
  const phase = {
    offline: "Agent offline",
    starting: "Agent starting",
    ready: "Agent ready",
    working: "Agent working",
    error: "Agent needs attention",
  }[runtime.phase];

  if (!plan?.steps.length) return phase;
  const activeStep = plan.steps.findIndex((step) => step.status === "inProgress");
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const current = activeStep >= 0 ? activeStep + 1 : Math.min(plan.steps.length, completed);
  return `${phase} · ${current} of ${plan.steps.length} steps`;
};

export function XiaoRunPanel({ runtime, plan, interactive }: XiaoRunPanelProps) {
  const status = useMemo(() => agentStatus(runtime, plan), [plan, runtime]);

  return (
    <section className="xiao-run" aria-label="Xiao Break game">
      <header className="xiao-run__agent-status">
        <span className={`xiao-run__status-dot is-${runtime.phase}`} />
        <XiaoIcon name="cpu" size={14} />
        <strong>{status}</strong>
        <span>Muted</span>
      </header>

      <div className="xiao-run__game">
        <BrowserPanel
          active={interactive}
          ariaLabel="Subway Surfers on Poki"
          fillWindowOnFullscreen
          homeLabel="Subway Surfers"
          homeUrl={SUBWAY_SURFERS_URL}
          muted
          placeholder={gamePlaceholder}
          webviewLabel={GAME_WEBVIEW_LABEL}
        />
      </div>

      <footer className="xiao-run__meta">
        <span><XiaoIcon name="secure" size={12} /> Official web game via Poki</span>
        <span className="xiao-run__keys">Audio muted · Arrow keys to move</span>
      </footer>
    </section>
  );
}
