import { useEffect, useMemo, useState } from "react";

import { FileTypeIcon } from "../../../components/icons/FileTypeIcon";
import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { nativeBridge } from "../../../core/bridges/tauri";
import type { AgentAttachment } from "../../../core/models/agent";
import type {
  GitBranch,
  GitCheckSummary,
  GitPullRequestSummary,
  GitSummary,
  WorkspaceSnapshot,
} from "../../../core/models/workspace";
import {
  executeShipFlow,
  initialShipSteps,
  summarizeShipChecks,
  updateShipStep,
  type ShipStepStatus,
} from "./shipFlow";

type ChangesPanelProps = {
  workspace: WorkspaceSnapshot;
  taskId: string | null;
  transitioning: boolean;
  workspaceActionable: boolean;
  reviewContext: AgentAttachment[];
  onStageReviewContext: (attachment: AgentAttachment) => void;
  onRemoveReviewContext: (attachmentId: string) => void;
  onOpenBrowser: (url: string) => void;
  onRefresh: () => void;
};

type Worktree = { path: string; branch: string; head: string; isMain: boolean };
type DiffLineKind = "add" | "delete" | "hunk" | "context";
export type ParsedDiffLine = {
  text: string;
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
};

export const parseUnifiedDiff = (patch: string): ParsedDiffLine[] => {
  let oldLine: number | null = null;
  let newLine: number | null = null;
  return patch.split("\n").map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { text, kind: "hunk", oldLine: null, newLine: null };
    }
    if (oldLine === null || newLine === null || text.startsWith("\\ No newline")) {
      return { text, kind: "context", oldLine: null, newLine: null };
    }
    if (text.startsWith("+") && !text.startsWith("+++")) {
      const line = { text, kind: "add" as const, oldLine: null, newLine };
      newLine += 1;
      return line;
    }
    if (text.startsWith("-") && !text.startsWith("---")) {
      const line = { text, kind: "delete" as const, oldLine, newLine: null };
      oldLine += 1;
      return line;
    }
    const line = { text, kind: "context" as const, oldLine, newLine };
    oldLine += 1;
    newLine += 1;
    return line;
  });
};

const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const directory = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
const shipStepIcon = (status: ShipStepStatus) => {
  if (status === "complete") return "check" as const;
  if (status === "running" || status === "pending") return "pending" as const;
  if (status === "warning") return "result" as const;
  if (status === "error") return "close" as const;
  return "more" as const;
};
const checkTone = (check: GitCheckSummary) => {
  if (check.bucket === "pass" || check.bucket === "skipping") return "pass";
  if (check.bucket === "fail" || check.bucket === "cancel") return "fail";
  return "pending";
};

export function ChangesPanel({
  workspace,
  taskId,
  transitioning,
  workspaceActionable,
  reviewContext,
  onStageReviewContext,
  onRemoveReviewContext,
  onOpenBrowser,
  onRefresh,
}: ChangesPanelProps) {
  const git = workspace.git;
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [baseBranch, setBaseBranch] = useState("");
  const [comparison, setComparison] = useState<GitSummary | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = busy || transitioning || !workspaceActionable;
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [shipSteps, setShipSteps] = useState(initialShipSteps);
  const [pullRequest, setPullRequest] = useState<GitPullRequestSummary | null>(null);
  const [shipChecks, setShipChecks] = useState<GitCheckSummary[]>([]);
  const [shipCommitOutput, setShipCommitOutput] = useState<string | null>(null);
  const [diffSelection, setDiffSelection] = useState<{ start: number; end: number } | null>(null);
  const [diffComment, setDiffComment] = useState("");
  const [diffNotice, setDiffNotice] = useState<string | null>(null);
  const visibleGit = baseBranch ? comparison : git;
  const comparisonMode = Boolean(baseBranch);
  const preferredChange = visibleGit?.changes.find((change) => !change.patch.startsWith("Binary file")) ?? visibleGit?.changes[0] ?? null;
  const selectedChange = visibleGit?.changes.find((change) => change.path === selectedPath) ?? preferredChange;
  const diffLines = useMemo(() => parseUnifiedDiff(selectedChange?.patch ?? ""), [selectedChange?.patch]);
  const selectedSourceLines = useMemo(() => {
    if (!diffSelection) return [];
    return diffLines
      .slice(diffSelection.start, diffSelection.end + 1)
      .map((line) => line.newLine ?? line.oldLine)
      .filter((line): line is number => line !== null);
  }, [diffLines, diffSelection]);
  const filteredChanges = useMemo(() => {
    const value = query.trim().toLowerCase();
    return visibleGit?.changes.filter((change) => !value || change.path.toLowerCase().includes(value)) ?? [];
  }, [visibleGit?.changes, query]);

  useEffect(() => {
    setSelectedPath((current) =>
      current && visibleGit?.changes.some((change) => change.path === current)
        ? current
        : preferredChange?.path ?? null,
    );
  }, [preferredChange?.path, visibleGit?.changes]);

  useEffect(() => {
    setQuery("");
  }, [workspace.path]);

  useEffect(() => {
    setDiffSelection(null);
    setDiffComment("");
    setDiffNotice(null);
  }, [selectedChange?.path, selectedChange?.patch]);

  const selectDiffLine = (index: number, extend: boolean) => {
    const line = diffLines[index];
    if (!line || (line.oldLine === null && line.newLine === null)) return;
    setDiffSelection((current) => {
      if (!extend || !current) return { start: index, end: index };
      return { start: Math.min(current.start, index), end: Math.max(current.end, index) };
    });
    setDiffComment("");
    setDiffNotice(null);
  };

  const stageDiffComment = () => {
    if (!selectedChange || !diffSelection || !diffComment.trim()) return;
    const selectedLines = diffLines.slice(diffSelection.start, diffSelection.end + 1);
    if (!selectedSourceLines.length) return;
    const lineStart = Math.min(...selectedSourceLines);
    const lineEnd = Math.max(...selectedSourceLines);
    const preview = selectedLines
      .map((line) => `${line.oldLine ?? ""}\t${line.newLine ?? ""} | ${line.text}`)
      .join("\n");
    onStageReviewContext({
      id: crypto.randomUUID(),
      name: `${fileName(selectedChange.path)}:${lineStart}`,
      path: selectedChange.path,
      kind: "review",
      lineStart,
      lineEnd,
      comment: diffComment.trim(),
      preview,
    });
    setDiffNotice(`${fileName(selectedChange.path)}:${lineStart}${lineEnd !== lineStart ? `-${lineEnd}` : ""} added to the prompt`);
    setDiffComment("");
    setDiffSelection(null);
  };

  useEffect(() => {
    let cancelled = false;
    setBranches([]);
    setBaseBranch("");
    setComparison(null);
    setBranchError(null);
    if (!git || !workspaceActionable) return;
    void nativeBridge.getGitBranches(workspace.path, taskId).then((items) => {
      if (!cancelled) setBranches(items);
    }).catch((reason) => {
      if (!cancelled) setBranchError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [git?.branch, taskId, workspace.path, workspaceActionable]);

  useEffect(() => {
    let cancelled = false;
    if (!git || !baseBranch || !workspaceActionable) {
      setComparison(null);
      setComparisonLoading(false);
      setComparisonError(null);
      return;
    }
    setComparisonLoading(true);
    setComparisonError(null);
    void nativeBridge.compareGitBranch(workspace.path, taskId, baseBranch).then((result) => {
      if (!cancelled) setComparison(result);
    }).catch((reason) => {
      if (!cancelled) {
        setComparison(null);
        setComparisonError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      if (!cancelled) setComparisonLoading(false);
    });
    return () => { cancelled = true; };
  }, [baseBranch, git, taskId, workspace.path, workspaceActionable]);

  const refreshWorktrees = async () => {
    if (!git || !workspaceActionable) return;
    try {
      setWorktrees(await nativeBridge.getGitWorktrees(workspace.path, taskId));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    if (!workspaceActionable) {
      setWorktrees([]);
      return;
    }
    void refreshWorktrees();
  }, [workspace.path, taskId, Boolean(git), workspaceActionable]);

  useEffect(() => {
    setShipSteps(initialShipSteps());
    setPullRequest(null);
    setShipChecks([]);
    setShipCommitOutput(null);
  }, [git?.branch, taskId, workspace.path]);

  const runAction = async (
    action: "commit" | "discard" | "stage" | "stage-all" | "switch" | "unstage",
    paths: string[] = [],
    message?: string,
  ) => {
    if (blocked) return;
    setBusy(true);
    setActionError(null);
    setActionResult(null);
    try {
      const result = await nativeBridge.mutateGit(
        workspace.path,
        taskId,
        action,
        paths,
        message,
      );
      setActionResult(result.trim() || `${action} completed.`);
      if (action === "commit") setCommitMessage("");
      if (action === "switch") {
        setBranchName("");
        setBaseBranch("");
        setComparison(null);
      }
      onRefresh();
      await refreshWorktrees();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const createWorktree = async () => {
    if (blocked) return;
    setBusy(true);
    setActionError(null);
    try {
      await nativeBridge.addGitWorktree(workspace.path, worktreePath.trim(), branchName.trim());
      setWorktreePath("");
      setBranchName("");
      setActionResult("Worktree created.");
      await refreshWorktrees();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const shipChanges = async () => {
    const message = commitMessage.trim();
    if (blocked || !git || !taskId || (!message && !shipCommitOutput)) return;
    const confirmation = shipCommitOutput
      ? `Resume shipping ${git.branch} from push? The commit is already created.`
      : `Ship staged changes on ${git.branch}? This will commit, push the current branch, and create or reuse a pull request.`;
    if (!window.confirm(confirmation)) return;
    setBusy(true);
    setActionError(null);
    setActionResult(null);
    setPullRequest(null);
    setShipChecks([]);
    setShipSteps(initialShipSteps());
    try {
      const result = await executeShipFlow(
        {
          commit: async () => {
            const output = await nativeBridge.mutateGit(workspace.path, taskId, "commit", [], message);
            setShipCommitOutput(output);
            return output;
          },
          push: () => nativeBridge.publishGitBranch(workspace.path, taskId),
          findPullRequest: () => nativeBridge.getGitPullRequest(workspace.path, taskId),
          createDraftPullRequest: () => nativeBridge.createGitDraftPullRequest(workspace.path, taskId),
          readChecks: () => nativeBridge.getGitPullRequestChecks(workspace.path, taskId),
        },
        {
          onStep: (id, status, detail) => {
            setShipSteps((steps) => updateShipStep(steps, id, status, detail));
          },
          onPullRequest: setPullRequest,
          onChecks: setShipChecks,
        },
        { commitOutput: shipCommitOutput },
      );
      setCommitMessage("");
      setShipCommitOutput(null);
      setActionResult(`${result.pullRequest.isDraft ? "Draft " : ""}PR #${result.pullRequest.number} shipped. CI status loaded.`);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      onRefresh();
      setBusy(false);
    }
  };

  const refreshShipChecks = async () => {
    if (blocked || !pullRequest) return;
    setBusy(true);
    setActionError(null);
    setShipSteps((steps) => updateShipStep(steps, "ci", "running", "Refreshing GitHub checks"));
    try {
      const checks = await nativeBridge.getGitPullRequestChecks(workspace.path, taskId);
      const summary = summarizeShipChecks(checks);
      setShipChecks(checks);
      setShipSteps((steps) => updateShipStep(steps, "ci", summary.status, summary.detail));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setShipSteps((steps) => updateShipStep(steps, "ci", "error", message));
      setActionError(message);
    } finally {
      setBusy(false);
    }
  };

  if (!git) {
    return <div className="rail-empty"><XiaoIcon name="branch" size={24} /><strong>Git context unavailable</strong><p>Initialize a Git repository to unlock review and repository actions.</p></div>;
  }

  return (
    <section className="changes-review">
      <header className="changes-review__header">
        <div className="changes-review__branch" title={git.repositoryRoot}>
          <XiaoIcon name="branch" size={14} />
          <strong>{git.branch}</strong>
          <span>vs</span>
          <select
            aria-label="Compare changes against branch"
            title={branchError ?? "Compare without checking out another branch"}
            value={baseBranch}
            disabled={blocked || comparisonLoading}
            onChange={(event) => {
              setComparison(null);
              setBaseBranch(event.target.value);
            }}
          >
            <option value="">HEAD</option>
            {branches.filter((branch) => !branch.current).map((branch) => (
              <option key={branch.name} value={branch.name}>{branch.name}</option>
            ))}
          </select>
          {comparisonLoading ? <XiaoIcon className="spin" name="pending" size={12} /> : null}
          {git.workspaceScoped && <small>workspace scope</small>}
        </div>
        <div className="changes-review__totals">
          <span className="is-add">+{visibleGit?.changes.reduce((sum, change) => sum + change.additions, 0) ?? 0}</span>
          <span className="is-delete">-{visibleGit?.changes.reduce((sum, change) => sum + change.deletions, 0) ?? 0}</span>
        </div>
        <button className="icon-button" type="button" aria-label="Refresh changes" disabled={blocked} onClick={() => { if (!blocked) onRefresh(); }}><XiaoIcon name="refresh" size={14} /></button>
      </header>

      {comparisonLoading ? (
        <div className="changes-review__state"><XiaoIcon className="spin" name="pending" size={18} /><strong>Comparing branches</strong><p>Reading changes against {baseBranch} without checking it out.</p></div>
      ) : comparisonError ? (
        <div className="changes-review__state is-error"><XiaoIcon name="close" size={18} /><strong>Comparison unavailable</strong><p>{comparisonError}</p></div>
      ) : visibleGit?.changes.length ? (
        <div className="changes-review__workspace">
          <aside className="change-file-browser">
            <label><XiaoIcon name="search" size={14} /><input value={query} placeholder="Filter changed files" disabled={blocked} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" disabled={blocked} onClick={() => setQuery("")} aria-label="Clear change filter"><XiaoIcon name="close" size={11} /></button>}</label>
            <div className="change-file-browser__list">
              {filteredChanges.map((change) => (
                <button className={change.path === selectedChange?.path ? "is-active" : undefined} key={change.path} title={change.path} disabled={blocked} onClick={() => setSelectedPath(change.path)}>
                  <span className={`change-file-browser__status is-${change.status}`}>{change.status[0].toUpperCase()}</span>
                  <FileTypeIcon path={change.path} size={15} />
                  <span className="change-file-browser__path"><small>{directory(change.path)}</small><strong>{fileName(change.path)}</strong></span>
                  <span className="change-file-browser__stats"><b>+{change.additions}</b><em>-{change.deletions}</em></span>
                </button>
              ))}
              {!filteredChanges.length && <p>No files match “{query}”.</p>}
            </div>
            <footer>
              <span>{filteredChanges.length} of {visibleGit.changes.length} files</span>
              {comparisonMode ? <span>Read only</span> : <button type="button" disabled={blocked} onClick={() => void runAction("stage-all")}>Stage all</button>}
            </footer>
          </aside>

          <main className="change-diff-viewer">
            {selectedChange ? (
              <>
                <header>
                  <div className="change-diff-viewer__file"><FileTypeIcon path={selectedChange.path} size={15} /><span><strong>{selectedChange.path}</strong><small>{selectedChange.status}{selectedChange.patchTruncated ? " · truncated" : ""}</small></span></div>
                  <div>
                    {comparisonMode ? <span className="change-diff-viewer__readonly">Compared with {baseBranch}</span> : (
                      <>
                        <button type="button" disabled={blocked} onClick={() => void runAction("stage", [selectedChange.path])}>Stage</button>
                        <button type="button" disabled={blocked} onClick={() => void runAction("unstage", [selectedChange.path])}>Unstage</button>
                        <button className="is-danger" type="button" disabled={blocked || selectedChange.status === "untracked"} onClick={() => window.confirm(`Discard changes in ${selectedChange.path}?`) && void runAction("discard", [selectedChange.path])}>Discard</button>
                      </>
                    )}
                  </div>
                </header>
                {diffNotice && <div className="change-diff-viewer__notice"><XiaoIcon name="check" size={13} />{diffNotice}</div>}
                <div className="change-diff-viewer__code" role="region" aria-label={`Changes in ${selectedChange.path}`}>
                  {selectedChange.patch ? diffLines.map((line, index) => {
                    const selectable = line.oldLine !== null || line.newLine !== null;
                    const selected = Boolean(diffSelection && index >= diffSelection.start && index <= diffSelection.end);
                    const commentAfter = Boolean(diffSelection && index === diffSelection.end);
                    const lineNumber = line.newLine ?? line.oldLine;
                    const stagedComments = reviewContext.filter(
                      (attachment) => attachment.kind === "review" &&
                        attachment.path === selectedChange.path &&
                        lineNumber !== null &&
                        (attachment.lineEnd ?? attachment.lineStart) === lineNumber,
                    );
                    return (
                      <div className="change-diff-viewer__group" key={`${index}-${line.text}`}>
                        <div className={`change-diff-viewer__line diff-${line.kind} ${selected ? "is-selected" : ""}`}>
                          {selectable ? (
                            <button className="change-diff-viewer__comment" type="button" aria-label={`Comment on ${selectedChange.path} line ${lineNumber}`} onClick={() => selectDiffLine(index, false)}><XiaoIcon name="add" size={12} /></button>
                          ) : <span />}
                          <button type="button" disabled={!selectable} onClick={(event) => selectDiffLine(index, event.shiftKey)}>{line.oldLine}</button>
                          <button type="button" disabled={!selectable} onClick={(event) => selectDiffLine(index, event.shiftKey)}>{line.newLine}</button>
                          <b>{line.kind === "add" ? "+" : line.kind === "delete" ? "-" : ""}</b>
                          <code onClick={(event) => selectDiffLine(index, event.shiftKey)}>{line.text || " "}</code>
                        </div>
                        {stagedComments.map((staged) => (
                          <article className="staged-line-comment" key={staged.id}>
                            <span><XiaoIcon name="check" size={12} /></span>
                            <div><strong>Staged for Xiao</strong><p>{staged.comment}</p></div>
                            <button type="button" aria-label="Remove staged diff comment" onClick={() => staged.id && onRemoveReviewContext(staged.id)}><XiaoIcon name="close" size={12} /></button>
                          </article>
                        ))}
                        {commentAfter && diffSelection && (
                          <form className="line-comment" onSubmit={(event) => { event.preventDefault(); stageDiffComment(); }}>
                            <label htmlFor="xiao-diff-comment">Comment</label>
                            <textarea
                              id="xiao-diff-comment"
                              autoFocus
                              rows={3}
                              value={diffComment}
                              placeholder="Tell Xiao what should change"
                              onChange={(event) => setDiffComment(event.target.value)}
                              onKeyDown={(event) => {
                                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") stageDiffComment();
                                if (event.key === "Escape") setDiffSelection(null);
                              }}
                            />
                            <footer>
                              <small>line {Math.min(...selectedSourceLines)}{Math.max(...selectedSourceLines) !== Math.min(...selectedSourceLines) ? `-${Math.max(...selectedSourceLines)}` : ""}</small>
                              <button type="button" onClick={() => setDiffSelection(null)}>Cancel</button>
                              <button className="button button--primary" type="submit" disabled={!diffComment.trim()}>Comment</button>
                            </footer>
                          </form>
                        )}
                      </div>
                    );
                  }) : <div className="change-diff-viewer__line diff-context"><span /><button type="button" disabled /><button type="button" disabled /><b /><code>No textual patch is available.</code></div>}
                </div>
              </>
            ) : null}
          </main>
        </div>
      ) : (
        <div className="changes-review__clean"><span><XiaoIcon name="check" size={22} /></span><strong>{comparisonMode ? "Branches match" : "Working tree is clean"}</strong><p>{comparisonMode ? `No changes against ${baseBranch} in this workspace scope.` : "No changes in this workspace scope."}</p></div>
      )}

      <details className="repository-drawer">
        <summary><span><XiaoIcon name="branch" size={14} /><strong>Repository actions</strong></span><small>{worktrees.length} {worktrees.length === 1 ? "worktree" : "worktrees"}</small><XiaoIcon name="caret" size={12} /></summary>
        <div>
          <section className="ship-flow" aria-label="Ship flow">
            <header className="ship-flow__header">
              <span><XiaoIcon name="send" size={14} /><strong>Ship flow</strong></span>
              <small>Commit → Push → Draft PR → CI</small>
            </header>
            <label htmlFor="xiao-commit-message">Commit staged changes</label>
            <div className="ship-flow__composer">
              <input id="xiao-commit-message" value={commitMessage} placeholder="Commit message" disabled={blocked} onChange={(event) => {
                setCommitMessage(event.target.value);
                if (shipCommitOutput) setShipCommitOutput(null);
              }} />
              <button className="button button--quiet" disabled={blocked || !taskId || !commitMessage.trim() || Boolean(shipCommitOutput)} onClick={() => void runAction("commit", [], commitMessage)}>Commit only</button>
              <button className="button button--primary" disabled={blocked || !taskId || (!commitMessage.trim() && !shipCommitOutput)} title={taskId ? "Commit staged changes, push, open a draft PR, then read CI" : "Create a task before shipping changes"} onClick={() => void shipChanges()}>{shipCommitOutput ? "Resume push" : "Ship draft PR"}</button>
            </div>
            <p className="ship-flow__note">{shipCommitOutput ? "Commit created. Resume starts at push; edit the message to create another commit." : "Staged only. Explicit branch push. Never force-pushes."}</p>
            <ol className="ship-flow__steps">
              {shipSteps.map((step) => (
                <li className={`is-${step.status}`} key={step.id}>
                  <span><XiaoIcon className={step.status === "running" ? "spin" : undefined} name={shipStepIcon(step.status)} size={12} /></span>
                  <strong>{step.label}</strong>
                  <small>{step.detail}</small>
                </li>
              ))}
            </ol>
            {pullRequest ? (
              <div className="ship-flow__pull-request">
                <div>
                  <span>{pullRequest.isDraft ? "Draft" : pullRequest.state.toLowerCase()}</span>
                  <a href={pullRequest.url} onClick={(event) => {
                    event.preventDefault();
                    onOpenBrowser(pullRequest.url);
                  }}>PR #{pullRequest.number} · {pullRequest.title}<XiaoIcon name="external" size={11} /></a>
                  <small>{pullRequest.headRefName} → {pullRequest.baseRefName || "base"}</small>
                </div>
                <button className="button button--quiet" type="button" disabled={blocked} onClick={() => void refreshShipChecks()}><XiaoIcon name="refresh" size={11} />Refresh CI</button>
              </div>
            ) : null}
            {shipChecks.length ? (
              <ul className="ship-flow__checks">
                {shipChecks.slice(0, 8).map((check) => (
                  <li className={`is-${checkTone(check)}`} key={`${check.workflow}-${check.name}`}>
                    <i />
                    <span><strong>{check.name}</strong><small>{check.workflow || check.state}</small></span>
                    {check.link ? <a href={check.link} aria-label={`Open ${check.name} check`} onClick={(event) => {
                      event.preventDefault();
                      onOpenBrowser(check.link!);
                    }}><XiaoIcon name="external" size={11} /></a> : null}
                  </li>
                ))}
                {shipChecks.length > 8 ? <li className="ship-flow__checks-more">+{shipChecks.length - 8} more checks</li> : null}
              </ul>
            ) : null}
          </section>
          <section><label htmlFor="xiao-branch-name">Branch or manual worktree (not Xiao-managed)</label><div><input id="xiao-branch-name" value={branchName} placeholder="Branch name" disabled={blocked} onChange={(event) => setBranchName(event.target.value)} /><button className="button button--quiet" disabled={blocked || !branchName.trim() || workspace.execution.workspaceMode === "managed-worktree"} title={workspace.execution.workspaceMode === "managed-worktree" ? "Branch switching is disabled in Xiao-managed worktrees" : undefined} onClick={() => void runAction("switch", [], branchName)}>Switch</button></div><div><input value={worktreePath} placeholder="New worktree path" disabled={blocked} onChange={(event) => setWorktreePath(event.target.value)} /><button className="button button--quiet" disabled={blocked || !branchName.trim() || !worktreePath.trim()} onClick={() => void createWorktree()}>Add</button></div></section>
          {actionError && <p className="rail-error">{actionError}</p>}
          {actionResult && <p className="git-action-result">{actionResult}</p>}
          {worktrees.length > 0 && <div className="worktree-list"><strong>Git worktrees · unowned</strong>{worktrees.map((item) => <span key={item.path}><b>{item.branch}</b><small>{item.path}{item.isMain ? " · main" : ""}</small></span>)}</div>}
        </div>
      </details>
    </section>
  );
}
