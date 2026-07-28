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
  const revision = `${summary.fileCount}:${summary.additions}:${summary.deletions}`;
  return (
    <button
      className="composer-live-changes"
      type="button"
      title="Review changed files"
      aria-label={`${summary.fileCount} files changed, ${summary.additions} additions, ${summary.deletions} deletions. Review changes`}
      onClick={onReview}
    >
      <XiaoIcon name="changes" size={13} />
      <span key={revision} aria-live="polite">
        <span>{summary.fileCount} {summary.fileCount === 1 ? "file" : "files"} changed</span>
        <b>+{summary.additions}</b>
        <em>-{summary.deletions}</em>
      </span>
    </button>
  );
}
