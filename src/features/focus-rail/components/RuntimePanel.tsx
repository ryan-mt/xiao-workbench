import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentRuntimeState, RuntimeLogEntry } from "../../../core/models/agent";
import type { SystemInfo } from "../../../core/models/workspace";

type RuntimePanelProps = {
  runtime: AgentRuntimeState;
  logs: RuntimeLogEntry[];
  system: SystemInfo;
  error: string | null;
  onRefresh: () => void;
};

const logTime = (timestamp: number) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);

export function RuntimePanel({ runtime, logs, system, error, onRefresh }: RuntimePanelProps) {
  return (
    <section className="rail-section">
      <header className="rail-section__header">
        <div>
          <span>Native runtime</span>
          <h2>Execution surface</h2>
        </div>
        <button className="icon-button" onClick={onRefresh} aria-label="Refresh runtime">
          <XiaoIcon name="refresh" size={16} />
        </button>
      </header>

      <div className="runtime-facts">
        <div>
          <XiaoIcon name="cpu" size={16} />
          <span>Platform</span>
          <strong>{system.platform}</strong>
        </div>
        <div>
          <XiaoIcon name="terminal" size={16} />
          <span>Shell</span>
          <strong>{system.shell}</strong>
        </div>
      </div>

      <div className="terminal-view">
        <header>
          <span className="terminal-view__lights"><i /></span>
          <strong>live app-server log</strong>
          <small>{runtime.phase}</small>
        </header>
        <pre>
          {logs.length ? logs.map((entry) => (
            <span className={`terminal-${entry.stream}`} key={entry.id}>
              <time>{logTime(entry.timestamp)}</time> {entry.text}
            </span>
          )) : <span className="terminal-dim">No runtime activity yet.</span>}
          {runtime.error && <span className="terminal-error">agent: {runtime.error}</span>}
          {error && <span className="terminal-error">workspace: {error}</span>}
        </pre>
      </div>
    </section>
  );
}
