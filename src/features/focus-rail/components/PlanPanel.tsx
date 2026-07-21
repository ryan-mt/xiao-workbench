import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentPlan, AgentRuntimeState } from "../../../core/models/agent";

type PlanPanelProps = {
  runtime: AgentRuntimeState;
  plan: AgentPlan | null;
};

export function PlanPanel({ runtime, plan }: PlanPanelProps) {
  return (
    <section className="rail-section">
      <header className="rail-section__header">
        <h2>Plan</h2>
      </header>

      {plan?.steps.length ? (
        <>
          {plan.explanation && <p className="rail-section__summary">{plan.explanation}</p>}
          <div className="plan-list">
            {plan.steps.map((item, index) => (
              <div
                className={item.status === "completed" ? "is-done" : item.status === "inProgress" ? "is-current" : "is-pending"}
                key={`${index}-${item.step}`}
              >
                <span className="plan-list__index">{index + 1}</span>
                <p>{item.step}</p>
                {item.status === "completed" ? (
                  <XiaoIcon name="check" size={15} strokeWidth={1.9} />
                ) : item.status === "inProgress" ? (
                  <XiaoIcon className="is-spinning" name="pending" size={14} />
                ) : <XiaoIcon name="todoPending" size={14} />}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="rail-empty">
          <XiaoIcon name="plan" size={24} />
          <strong>No agent plan yet</strong>
          <p>When Codex publishes a turn plan, its live steps will appear here.</p>
        </div>
      )}

      <div className="rail-note">
        <XiaoIcon name="target" size={18} />
        <div>
          <strong>{runtime.phase === "working" ? "Agent is executing" : "Ready for direction"}</strong>
          <small>{runtime.phase === "working" ? "Following agent events in real time." : "Start a task to receive a plan."}</small>
        </div>
      </div>
    </section>
  );
}
