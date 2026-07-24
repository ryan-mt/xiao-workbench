use tauri::State;

use super::models::{
    CodexProfile, CodexProfileUpdate, ProjectGroup, ProjectGroupUpdate, ProjectPresentationUpdate,
    TaskCodexProfileBinding, TaskStageTransition, TaskStageTransitionRequest,
    XiaoHistorySearchResult, XiaoProjectSummary, XiaoTimelinePage, XiaoWorkspaceDocument,
    XiaoWorkspaceUpdate,
};
use super::repository::XiaoRepository;
use super::service;

#[tauri::command]
pub fn load_xiao_workspace(
    workspace_path: String,
    include_active_timeline: Option<bool>,
    repository: State<'_, XiaoRepository>,
) -> Result<Option<XiaoWorkspaceDocument>, String> {
    service::load_workspace(
        &repository,
        &workspace_path,
        include_active_timeline.unwrap_or(true),
    )
}

#[tauri::command]
pub fn load_xiao_timeline_page(
    workspace_path: String,
    task_id: String,
    before: Option<usize>,
    limit: Option<usize>,
    repository: State<'_, XiaoRepository>,
) -> Result<XiaoTimelinePage, String> {
    service::load_timeline_page(&repository, &workspace_path, &task_id, before, limit)
}

#[tauri::command]
pub fn search_xiao_history(
    workspace_path: String,
    query: String,
    limit: Option<usize>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<XiaoHistorySearchResult>, String> {
    service::search_history(&repository, &workspace_path, &query, limit)
}

#[tauri::command]
pub fn save_xiao_workspace(
    update: XiaoWorkspaceUpdate,
    repository: State<'_, XiaoRepository>,
) -> Result<(), String> {
    service::save_workspace(&repository, update)
}

#[tauri::command]
pub fn list_xiao_projects(
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<XiaoProjectSummary>, String> {
    service::list_projects(&repository)
}

#[tauri::command]
pub fn search_xiao_history_global(
    query: String,
    limit: Option<usize>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<XiaoHistorySearchResult>, String> {
    service::search_history_global(&repository, &query, limit)
}

#[tauri::command]
pub fn save_xiao_project_group(
    update: ProjectGroupUpdate,
    repository: State<'_, XiaoRepository>,
) -> Result<ProjectGroup, String> {
    service::save_project_group(&repository, update)
}

#[tauri::command]
pub fn list_xiao_project_groups(
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<ProjectGroup>, String> {
    service::list_project_groups(&repository)
}

#[tauri::command]
pub fn reorder_xiao_project_groups(
    group_ids: Vec<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<ProjectGroup>, String> {
    service::reorder_project_groups(&repository, group_ids)
}

#[tauri::command]
pub fn delete_xiao_project_group(
    group_id: String,
    repository: State<'_, XiaoRepository>,
) -> Result<(), String> {
    service::delete_project_group(&repository, &group_id)
}

#[tauri::command]
pub fn update_xiao_project_presentation(
    update: ProjectPresentationUpdate,
    repository: State<'_, XiaoRepository>,
) -> Result<XiaoProjectSummary, String> {
    service::update_project_presentation(&repository, update)
}

#[tauri::command]
pub fn save_xiao_codex_profile(
    update: CodexProfileUpdate,
    repository: State<'_, XiaoRepository>,
) -> Result<CodexProfile, String> {
    service::save_codex_profile(&repository, update)
}

#[tauri::command]
pub fn list_xiao_codex_profiles(
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<CodexProfile>, String> {
    service::list_codex_profiles(&repository)
}

#[tauri::command]
pub fn delete_xiao_codex_profile(
    profile_id: String,
    repository: State<'_, XiaoRepository>,
) -> Result<(), String> {
    service::delete_codex_profile(&repository, &profile_id)
}

#[tauri::command]
pub fn bind_xiao_task_codex_profile(
    workspace_path: String,
    task_id: String,
    profile_id: String,
    expected_stage_version: i64,
    compatibility_confirmed: Option<bool>,
    repository: State<'_, XiaoRepository>,
) -> Result<TaskCodexProfileBinding, String> {
    service::bind_task_codex_profile(
        &repository,
        &workspace_path,
        &task_id,
        &profile_id,
        expected_stage_version,
        compatibility_confirmed.unwrap_or(false),
    )
}

#[tauri::command]
pub fn transition_xiao_task_stage(
    request: TaskStageTransitionRequest,
    repository: State<'_, XiaoRepository>,
) -> Result<TaskStageTransition, String> {
    service::transition_task_stage(&repository, request)
}

#[tauri::command]
pub fn list_xiao_task_stage_transitions(
    workspace_path: String,
    task_id: String,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<TaskStageTransition>, String> {
    service::list_task_stage_transitions(&repository, &workspace_path, &task_id)
}

#[tauri::command]
pub fn open_xiao_project(path: String) -> Result<(), String> {
    service::open_project(&path)
}
