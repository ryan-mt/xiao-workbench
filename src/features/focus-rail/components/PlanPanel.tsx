import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { AgentPlan, AgentRuntimeState } from "../../../core/models/agent";

type PlanPanelProps = {
  runtime: AgentRuntimeState;
  plan: AgentPlan | null;
};

export function PlanPanel({ runtime, plan }: PlanPanelProps) {
  const completedSteps = plan?.steps.filter((item) => item.status === "completed").length ?? 0;
  const totalSteps = plan?.steps.length ?? 0;

  return (
    <section className="rail-section rail-section--plan">
      <header className="rail-section__header">
        <div>
          <h2>Tasks</h2>
          <span>
            {totalSteps > 0
              ? `${completedSteps} of ${totalSteps} complete`
              : runtime.phase === "working"
                ? "Waiting for the agent plan"
                : "No active tasks"}
          </span>
        </div>
      </header>

      {plan?.steps.length ? (
        <>
          {plan.explanation && <p className="rail-section__summary">{plan.explanation}</p>}
          <div className="plan-list">
            {plan.steps.map((item, index) => (
              <div
                className={item.status === "completed" ? "is-done" : item.status === "inProgress" ? "is-current" : "is-pending"}
                aria-label={`${item.status === "completed" ? "Completed" : item.status === "inProgress" ? "In progress" : "Pending"}: ${item.step}`}
                key={`${index}-${item.step}`}
              >
                <span className="plan-list__check" aria-hidden="true">
                  {item.status === "completed" ? (
                    <XiaoIcon name="check" size={10} strokeWidth={2.2} />
                  ) : item.status === "inProgress" ? <i /> : null}
                </span>
                <p>{item.step}</p>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="plan-empty">
          <strong>No tasks yet</strong>
          <p>Tasks appear here when Codex publishes a plan.</p>
        </div>
      )}
    </section>
  );
}
