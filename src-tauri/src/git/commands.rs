use tauri::State;

use crate::execution::service::resolve_execution_context;
use crate::xiao::repository::XiaoRepository;

use super::models::{
    GitBranch, GitCheckSummary, GitPullRequestSummary, GitPushResult, GitSummary, GitWorktree,
};
use super::service::{
    apply_workspace_patch, create_draft_pull_request, create_workspace_checkpoint, create_worktree,
    discard_workspace_checkpoint, find_pull_request_observation, finish_workspace_checkpoint,
    list_branches, list_worktrees, publish_current_branch, read_git_comparison,
    read_pull_request_checks, read_pull_request_checks_for_pull_request, run_git_action,
};

fn task_root(
    repository: &XiaoRepository,
    project_path: &str,
    task_id: Option<&str>,
) -> Result<String, String> {
    resolve_execution_context(repository, project_path, task_id)
        .map(|context| context.execution_root)
}

fn persisted_task_root(
    repository: &XiaoRepository,
    project_path: &str,
    task_id: Option<&str>,
) -> Result<String, String> {
    let task_id = task_id.ok_or("This Git operation requires a persisted Xiao task.")?;
    task_root(repository, project_path, Some(task_id))
}

#[tauri::command]
pub fn mutate_git(
    project_path: String,
    task_id: Option<String>,
    action: String,
    paths: Vec<String>,
    message: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<String, String> {
    let task_id = task_id
        .as_deref()
        .ok_or("This Git operation requires a persisted Xiao task.")?;
    let context = resolve_execution_context(&repository, &project_path, Some(task_id))?;
    if action == "switch"
        && context.workspace_mode == crate::xiao::models::XiaoWorkspaceMode::ManagedWorktree
    {
        return Err("Branch switching is disabled inside a Xiao-managed worktree.".to_owned());
    }
    run_git_action(&context.execution_root, &action, &paths, message.as_deref())
}

#[tauri::command]
pub fn get_git_branches(
    project_path: String,
    task_id: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<GitBranch>, String> {
    let root = task_root(&repository, &project_path, task_id.as_deref())?;
    list_branches(&root)
}

#[tauri::command]
pub async fn compare_git_branch(
    project_path: String,
    task_id: Option<String>,
    base_branch: String,
    repository: State<'_, XiaoRepository>,
) -> Result<GitSummary, String> {
    let root = task_root(&repository, &project_path, task_id.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || read_git_comparison(&root, &base_branch))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn get_git_worktrees(
    project_path: String,
    task_id: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<GitWorktree>, String> {
    let root = task_root(&repository, &project_path, task_id.as_deref())?;
    list_worktrees(&root)
}

#[tauri::command]
pub async fn publish_git_branch(
    project_path: String,
    task_id: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<GitPushResult, String> {
    let task_id = task_id.ok_or("This Git operation requires a persisted Xiao task.")?;
    repository.ensure_task_outcome_publishable(&project_path, &task_id)?;
    let root = persisted_task_root(&repository, &project_path, Some(&task_id))?;
    let result = tauri::async_runtime::spawn_blocking(move || publish_current_branch(&root))
        .await
        .map_err(|error| error.to_string())??;
    let upstream_prefix = format!("{}/", result.remote);
    let published_branch = result
        .upstream
        .strip_prefix(&upstream_prefix)
        .ok_or("Git reported an invalid upstream branch after publishing.")?;
    repository.record_branch_publication(
        &project_path,
        &task_id,
        published_branch,
        &result.remote,
    )?;
    Ok(result)
}

#[tauri::command]
pub async fn get_git_pull_request(
    project_path: String,
    task_id: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<Option<GitPullRequestSummary>, String> {
    let task_id = task_id.ok_or("This Git operation requires a persisted Xiao task.")?;
    let root = persisted_task_root(&repository, &project_path, Some(&task_id))?;
    let pull_request =
        tauri::async_runtime::spawn_blocking(move || find_pull_request_observation(&root))
            .await
            .map_err(|error| error.to_string())??;
    let mut associated = false;
    if let Some(pull_request) = pull_request.as_ref() {
        associated = repository
            .record_discovered_pull_request_publication(
                &project_path,
                &task_id,
                &pull_request.head_ref_name,
                &pull_request.url,
                pull_request.number as i64,
                &pull_request.state,
            )?
            .is_some();
        if associated {
            repository.refresh_pull_request_state(
                &project_path,
                &task_id,
                pull_request.number as i64,
                &pull_request.state,
            )?;
        }
    }
    Ok(pull_request
        .filter(|pull_request| associated && pull_request.state.eq_ignore_ascii_case("open")))
}

#[tauri::command]
pub async fn create_git_draft_pull_request(
    project_path: String,
    task_id: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<GitPullRequestSummary, String> {
    let task_id = task_id.ok_or("This Git operation requires a persisted Xiao task.")?;
    repository.ensure_task_outcome_publishable(&project_path, &task_id)?;
    let root = persisted_task_root(&repository, &project_path, Some(&task_id))?;
    let pull_request =
        tauri::async_runtime::spawn_blocking(move || create_draft_pull_request(&root))
            .await
            .map_err(|error| error.to_string())??;
    repository
        .record_discovered_pull_request_publication(
            &project_path,
            &task_id,
            &pull_request.head_ref_name,
            &pull_request.url,
            pull_request.number as i64,
            &pull_request.state,
        )?
        .ok_or("The pull request does not match the current published Task outcome.")?;
    repository.refresh_pull_request_state(
        &project_path,
        &task_id,
        pull_request.number as i64,
        &pull_request.state,
    )?;
    Ok(pull_request)
}

#[tauri::command]
pub async fn get_git_pull_request_checks(
    project_path: String,
    task_id: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<GitCheckSummary>, String> {
    let task_id = task_id.ok_or("This Git operation requires a persisted Xiao task.")?;
    let root = persisted_task_root(&repository, &project_path, Some(&task_id))?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let pull_request = find_pull_request_observation(&root)?;
        let checks = match pull_request.as_ref() {
            Some(pull_request) => {
                read_pull_request_checks_for_pull_request(&root, pull_request.number)?
            }
            None => read_pull_request_checks(&root)?,
        };
        Ok::<_, String>((pull_request, checks))
    })
    .await
    .map_err(|error| error.to_string())??;
    let (pull_request, checks) = result;
    if let Some(pull_request) = pull_request {
        let check_state = if checks
            .iter()
            .any(|check| matches!(check.bucket.as_str(), "fail" | "cancel"))
        {
            "failing"
        } else if checks.iter().any(|check| check.bucket == "pending") {
            "pending"
        } else if checks.is_empty() {
            "unknown"
        } else {
            "passing"
        };
        let checks_json = serde_json::to_string(&checks)
            .map_err(|error| format!("Could not encode pull-request checks: {error}"))?;
        repository.refresh_pull_request_publication(
            &project_path,
            &task_id,
            pull_request.number as i64,
            &pull_request.state,
            check_state,
            &checks_json,
        )?;
    }
    Ok(checks)
}

#[tauri::command]
pub fn add_git_worktree(
    project_path: String,
    target_path: String,
    branch: String,
) -> Result<(), String> {
    create_worktree(&project_path, &target_path, &branch)
}

#[tauri::command]
pub fn apply_git_patch(
    project_path: String,
    task_id: Option<String>,
    patch: String,
    reverse: bool,
    check_only: bool,
    repository: State<'_, XiaoRepository>,
) -> Result<(), String> {
    let root = persisted_task_root(&repository, &project_path, task_id.as_deref())?;
    apply_workspace_patch(&root, &patch, reverse, check_only)
}

#[tauri::command]
pub fn create_git_checkpoint(
    project_path: String,
    task_id: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<String, String> {
    let root = persisted_task_root(&repository, &project_path, task_id.as_deref())?;
    create_workspace_checkpoint(&root)
}

#[tauri::command]
pub fn finish_git_checkpoint(
    project_path: String,
    task_id: Option<String>,
    token: String,
    repository: State<'_, XiaoRepository>,
) -> Result<String, String> {
    let root = persisted_task_root(&repository, &project_path, task_id.as_deref())?;
    finish_workspace_checkpoint(&root, &token)
}

#[tauri::command]
pub fn discard_git_checkpoint(token: String) -> Result<(), String> {
    discard_workspace_checkpoint(&token)
}
