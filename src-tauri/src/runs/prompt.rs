use serde_json::{json, Map, Value};

pub(crate) const EXECUTION_LIFECYCLE_INSTRUCTIONS: &str = "Act as Xiao's execution agent for this turn. First classify the request as answer, diagnose, review, or change. Inspect enough local context to avoid assumptions. For changes, implement the smallest complete solution, verify it in proportion to risk, and report the concrete outcome. For diagnosis or review, do not mutate external state unless the user also requested a fix. Keep user-visible progress accurate and never claim completion from intent alone.";
pub(crate) const PLAN_PROGRESS_INSTRUCTIONS: &str = "When you publish a task plan with update_plan, keep it current throughout execution. As soon as a step finishes, mark it completed and set the next step to in_progress before continuing. Do not wait until the final response to batch plan status changes.";
pub(crate) const COMMAND_FAILURE_RECOVERY_INSTRUCTIONS: &str = "Before calling a command tool, verify that the invocation matches the active shell and tool schema, especially quoting, wildcard expansion, and multiline arguments. When the active shell is PowerShell, remember that backslash does not escape quotes: prefer single-quoted arguments for literal regexes and paths. With ripgrep, prefer `rg -F -e 'literal'` for literal alternatives, and pass a directory plus `-g '*.ts'` instead of a Windows wildcard path such as `src\\*.ts`. If a search has a meaningful no-result exit code, treat it as an empty result only when absence is acceptable (for `rg`, exit 1); never mask parser or usage failures (`rg` exit 2 or greater). Before applying a patch, re-read the exact current context whenever the target may have changed. Do not use a check-only command as a probe when its expected nonzero exit would merely tell you to run the corresponding formatter or fixer; after editing, run the formatter or fixer first and reserve its check-only form for final verification. Do not batch a command that may fail as part of normal probing with independent checks, because one expected failure makes the whole batch appear failed. After any failure, inspect the complete output and identify the root cause before making another tool call. Never rerun an unchanged command after a sandbox denial, missing executable, unavailable dependency, spawn failure, tool-schema error, shell-parser error, or invalid patch. Make at most one corrected recovery attempt for the same objective and root cause, and only when the next call materially addresses that cause. If that recovery fails for the same reason, stop: report the blocker and continue with checks that do not depend on it. Do not cycle through alternate wrappers, quoting styles, shells, or invocation transports to force a blocked action.";
pub(crate) const MANAGED_WORKTREE_INSTRUCTIONS: &str = "This turn runs in a managed Git worktree. Untracked dependency directories from the source checkout, such as node_modules, may be absent. Check that required dependencies are available before running project scripts, and do not repeatedly run scripts whose runtime dependencies are unavailable.";
pub(crate) const FULL_ACCESS_INSTRUCTIONS: &str = "This Xiao turn runs with the sandbox disabled. Xiao does not restrict filesystem, process, or network access to the execution root. The execution root and runtime workspace roots identify the active project; they are not access boundaries. Use access outside the project only when it is in scope for the user's task. Full access does not make an unavailable tool, disconnected integration, or external service available.";
pub(crate) const GOAL_LIFECYCLE_INSTRUCTIONS: &str = "This task has an active Xiao goal. At the start of every goal turn, call get_goal before planning or editing; use its objective, status, and budget as authoritative, and do not ask the user to repeat them. Treat the turn as one real iteration toward that objective: inspect the latest workspace and plan, choose the next concrete milestone, perform meaningful work, and verify the result before ending the turn. Honor any newer user request that narrows, pauses, or asks only about the work. Preserve and update an existing plan when the work is multi-step. Use update_goal with status complete only when the objective is genuinely achieved and no required work remains. If the goal remains active, leave durable progress and a clear next step so the automatic continuation advances instead of restarting or merely restating the goal. Do not mark the goal complete because a turn ended, time is short, or the remaining work is difficult.";
pub(crate) const VERIFICATION_LOOP_INSTRUCTIONS: &str = "This run has a Xiao acceptance contract. Treat its gates as completion conditions. After making changes, run the relevant checks and inspect their actual output. If a gate fails, fix the cause and verify again when it is safe to do so. Do not present the work as verified merely because the agent turn completed; Xiao's recorded verification outcome is authoritative.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PromptSource {
    Core,
    Runtime,
    Workspace,
    Task,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PromptSection {
    pub key: &'static str,
    pub version: u16,
    pub source: PromptSource,
    pub content: &'static str,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct XiaoPromptContext {
    pub default_mode: bool,
    pub managed_worktree: bool,
    pub full_access: bool,
    pub active_goal: bool,
    pub verification_contract: bool,
}

const EXECUTION_LIFECYCLE: PromptSection = PromptSection {
    key: "xiao.execution-lifecycle",
    version: 1,
    source: PromptSource::Core,
    content: EXECUTION_LIFECYCLE_INSTRUCTIONS,
};
const PLAN_PROGRESS: PromptSection = PromptSection {
    key: "xiao.plan-progress",
    version: 1,
    source: PromptSource::Core,
    content: PLAN_PROGRESS_INSTRUCTIONS,
};
const COMMAND_FAILURE_RECOVERY: PromptSection = PromptSection {
    key: "xiao.command-failure-recovery",
    version: 2,
    source: PromptSource::Runtime,
    content: COMMAND_FAILURE_RECOVERY_INSTRUCTIONS,
};
const MANAGED_WORKTREE: PromptSection = PromptSection {
    key: "xiao.managed-worktree",
    version: 1,
    source: PromptSource::Workspace,
    content: MANAGED_WORKTREE_INSTRUCTIONS,
};
const FULL_ACCESS: PromptSection = PromptSection {
    key: "xiao.full-access",
    version: 1,
    source: PromptSource::Runtime,
    content: FULL_ACCESS_INSTRUCTIONS,
};
const GOAL_LIFECYCLE: PromptSection = PromptSection {
    key: "xiao.goal-lifecycle",
    version: 2,
    source: PromptSource::Task,
    content: GOAL_LIFECYCLE_INSTRUCTIONS,
};
const VERIFICATION_LOOP: PromptSection = PromptSection {
    key: "xiao.verification-loop",
    version: 1,
    source: PromptSource::Task,
    content: VERIFICATION_LOOP_INSTRUCTIONS,
};

pub(crate) fn compile_prompt_sections(context: XiaoPromptContext) -> Vec<PromptSection> {
    let mut sections = Vec::new();
    if context.default_mode {
        sections.extend([EXECUTION_LIFECYCLE, PLAN_PROGRESS]);
    }
    sections.push(COMMAND_FAILURE_RECOVERY);
    if context.default_mode && context.managed_worktree {
        sections.push(MANAGED_WORKTREE);
    }
    if context.full_access {
        sections.push(FULL_ACCESS);
    }
    if context.default_mode && context.active_goal {
        sections.push(GOAL_LIFECYCLE);
    }
    if context.default_mode && context.verification_contract {
        sections.push(VERIFICATION_LOOP);
    }
    sections
}

pub(crate) fn compile_additional_context(context: XiaoPromptContext) -> Map<String, Value> {
    compile_prompt_sections(context)
        .into_iter()
        .map(|section| {
            (
                section.key.to_owned(),
                json!({
                    "kind": "application",
                    "value": section.content,
                }),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn compiler_is_ordered_versioned_and_has_unique_keys() {
        let sections = compile_prompt_sections(XiaoPromptContext {
            default_mode: true,
            managed_worktree: true,
            full_access: true,
            active_goal: true,
            verification_contract: true,
        });
        assert_eq!(
            sections
                .iter()
                .map(|section| section.key)
                .collect::<Vec<_>>(),
            vec![
                "xiao.execution-lifecycle",
                "xiao.plan-progress",
                "xiao.command-failure-recovery",
                "xiao.managed-worktree",
                "xiao.full-access",
                "xiao.goal-lifecycle",
                "xiao.verification-loop",
            ]
        );
        assert_eq!(
            sections
                .iter()
                .map(|section| section.version)
                .collect::<Vec<_>>(),
            vec![1, 1, 2, 1, 1, 2, 1]
        );
        assert_eq!(
            sections
                .iter()
                .map(|section| section.key)
                .collect::<HashSet<_>>()
                .len(),
            sections.len()
        );
        assert_eq!(sections[0].source, PromptSource::Core);
        assert_eq!(sections[3].source, PromptSource::Workspace);
        assert_eq!(sections[5].source, PromptSource::Task);
    }

    #[test]
    fn plan_mode_only_receives_required_runtime_policy() {
        let sections = compile_prompt_sections(XiaoPromptContext {
            default_mode: false,
            managed_worktree: true,
            full_access: true,
            active_goal: true,
            verification_contract: true,
        });
        assert_eq!(
            sections
                .iter()
                .map(|section| section.key)
                .collect::<Vec<_>>(),
            vec!["xiao.command-failure-recovery", "xiao.full-access"]
        );
    }

    #[test]
    fn command_recovery_policy_covers_powershell_and_ripgrep_failures() {
        assert!(COMMAND_FAILURE_RECOVERY_INSTRUCTIONS.contains("backslash does not escape quotes"));
        assert!(COMMAND_FAILURE_RECOVERY_INSTRUCTIONS.contains("exit 1"));
        assert!(COMMAND_FAILURE_RECOVERY_INSTRUCTIONS.contains("-g '*.ts'"));
    }

    #[test]
    fn goal_and_verification_prompts_are_conditional() {
        let baseline = compile_additional_context(XiaoPromptContext {
            default_mode: true,
            ..XiaoPromptContext::default()
        });
        assert!(!baseline.contains_key("xiao.goal-lifecycle"));
        assert!(!baseline.contains_key("xiao.verification-loop"));

        let iterative = compile_additional_context(XiaoPromptContext {
            default_mode: true,
            active_goal: true,
            verification_contract: true,
            ..XiaoPromptContext::default()
        });
        assert!(iterative["xiao.goal-lifecycle"]["value"]
            .as_str()
            .unwrap()
            .contains("automatic continuation"));
        assert!(iterative["xiao.goal-lifecycle"]["value"]
            .as_str()
            .unwrap()
            .contains("call get_goal"));
        assert!(iterative["xiao.verification-loop"]["value"]
            .as_str()
            .unwrap()
            .contains("fix the cause and verify again"));
    }
}
