use super::models::GitWorktree;
use super::service::{
    apply_workspace_patch, create_workspace_checkpoint, create_worktree,
    discard_workspace_checkpoint, finish_workspace_checkpoint, list_worktrees, run_git_action,
};

#[tauri::command]
pub fn mutate_git(
    workspace_path: String,
    action: String,
    paths: Vec<String>,
    message: Option<String>,
) -> Result<String, String> {
    run_git_action(&workspace_path, &action, &paths, message.as_deref())
}

#[tauri::command]
pub fn get_git_worktrees(workspace_path: String) -> Result<Vec<GitWorktree>, String> {
    list_worktrees(&workspace_path)
}

#[tauri::command]
pub fn add_git_worktree(
    workspace_path: String,
    target_path: String,
    branch: String,
) -> Result<(), String> {
    create_worktree(&workspace_path, &target_path, &branch)
}

#[tauri::command]
pub fn apply_git_patch(
    workspace_path: String,
    patch: String,
    reverse: bool,
    check_only: bool,
) -> Result<(), String> {
    apply_workspace_patch(&workspace_path, &patch, reverse, check_only)
}

#[tauri::command]
pub fn create_git_checkpoint(workspace_path: String) -> Result<String, String> {
    create_workspace_checkpoint(&workspace_path)
}

#[tauri::command]
pub fn finish_git_checkpoint(workspace_path: String, token: String) -> Result<String, String> {
    finish_workspace_checkpoint(&workspace_path, &token)
}

#[tauri::command]
pub fn discard_git_checkpoint(token: String) -> Result<(), String> {
    discard_workspace_checkpoint(&token)
}
