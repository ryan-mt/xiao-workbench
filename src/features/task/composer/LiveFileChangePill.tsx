import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type { LiveFileChangeSummary } from "./liveFileChanges";

export function LiveFileChangePill({
  summary,
  onReview,
}: {
  summary: LiveFileChangeSummary | null;
  onReview: () => void;
}) {
  if (!summary) return null;
  const revision = `${summary.stepIndex}:${summary.stepTotal}:${summary.fileCount}:${summary.additions}:${summary.deletions}`;
  const stepLabel = summary.stepIndex && summary.stepTotal
    ? `Step ${summary.stepIndex} / ${summary.stepTotal}`
    : null;
  return (
    <button
      className="composer-live-changes"
      type="button"
      title="Review changed files"
      aria-label={`${summary.fileCount} files changed, ${summary.additions} additions, ${summary.deletions} deletions. Review changes`}
      onClick={onReview}
    >
      <XiaoIcon className={stepLabel ? "spin" : undefined} name={stepLabel ? "pending" : "changes"} size={13} />
      <span key={revision} aria-live="polite">
        {stepLabel ? <span className="composer-live-changes__step">{stepLabel}<i>·</i></span> : null}
        <span>{summary.fileCount} {summary.fileCount === 1 ? "file" : "files"} changed</span>
        <b>+{summary.additions}</b>
        <em>-{summary.deletions}</em>
      </span>
    </button>
  );
}
