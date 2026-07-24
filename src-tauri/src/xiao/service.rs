use std::path::Path;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use super::models::{
    AttentionSnapshot, CodexProfile, CodexProfileUpdate, ProjectGroup, ProjectGroupUpdate,
    ProjectPresentationUpdate, PublicationRecord, TaskCodexProfileBinding, TaskStageTransition,
    TaskStageTransitionRequest, XiaoHistorySearchResult, XiaoProjectSummary, XiaoTimelinePage,
    XiaoWorkspaceDocument, XiaoWorkspaceUpdate,
};
use super::repository::XiaoRepository;

pub fn load_workspace(
    repository: &XiaoRepository,
    workspace_path: &str,
    include_active_timeline: bool,
) -> Result<Option<XiaoWorkspaceDocument>, String> {
    repository.load_workspace(workspace_path, include_active_timeline)
}

pub fn load_timeline_page(
    repository: &XiaoRepository,
    workspace_path: &str,
    task_id: &str,
    before: Option<usize>,
    limit: Option<usize>,
) -> Result<XiaoTimelinePage, String> {
    repository.load_timeline_page(workspace_path, task_id, before, limit)
}

pub fn search_history(
    repository: &XiaoRepository,
    workspace_path: &str,
    query: &str,
    limit: Option<usize>,
) -> Result<Vec<XiaoHistorySearchResult>, String> {
    repository.search_history(workspace_path, query, limit)
}

pub fn save_workspace(
    repository: &XiaoRepository,
    update: XiaoWorkspaceUpdate,
) -> Result<(), String> {
    repository.save_workspace(update)
}

pub fn list_projects(repository: &XiaoRepository) -> Result<Vec<XiaoProjectSummary>, String> {
    repository.list_projects()
}

pub fn search_history_global(
    repository: &XiaoRepository,
    query: &str,
    limit: Option<usize>,
) -> Result<Vec<XiaoHistorySearchResult>, String> {
    repository.search_history_global(query, limit)
}

pub fn save_project_group(
    repository: &XiaoRepository,
    update: ProjectGroupUpdate,
) -> Result<ProjectGroup, String> {
    repository.save_project_group(update)
}

pub fn list_project_groups(repository: &XiaoRepository) -> Result<Vec<ProjectGroup>, String> {
    repository.list_project_groups()
}

pub fn reorder_project_groups(
    repository: &XiaoRepository,
    group_ids: Vec<String>,
) -> Result<Vec<ProjectGroup>, String> {
    repository.reorder_project_groups(group_ids)
}

pub fn delete_project_group(repository: &XiaoRepository, group_id: &str) -> Result<(), String> {
    repository.delete_project_group(group_id)
}

pub fn update_project_presentation(
    repository: &XiaoRepository,
    update: ProjectPresentationUpdate,
) -> Result<XiaoProjectSummary, String> {
    repository.update_project_presentation(update)
}

pub fn save_codex_profile(
    repository: &XiaoRepository,
    update: CodexProfileUpdate,
) -> Result<CodexProfile, String> {
    repository.save_codex_profile(update)
}

pub fn list_codex_profiles(repository: &XiaoRepository) -> Result<Vec<CodexProfile>, String> {
    repository.list_codex_profiles()
}

pub fn delete_codex_profile(repository: &XiaoRepository, profile_id: &str) -> Result<(), String> {
    repository.delete_codex_profile(profile_id)
}

pub fn bind_task_codex_profile(
    repository: &XiaoRepository,
    workspace_path: &str,
    task_id: &str,
    profile_id: &str,
    expected_stage_version: i64,
    compatibility_confirmed: bool,
) -> Result<TaskCodexProfileBinding, String> {
    repository.bind_task_codex_profile(
        workspace_path,
        task_id,
        profile_id,
        expected_stage_version,
        compatibility_confirmed,
    )
}

pub fn transition_task_stage(
    repository: &XiaoRepository,
    request: TaskStageTransitionRequest,
) -> Result<TaskStageTransition, String> {
    repository.transition_task_stage(request)
}

pub fn list_task_stage_transitions(
    repository: &XiaoRepository,
    workspace_path: &str,
    task_id: &str,
) -> Result<Vec<TaskStageTransition>, String> {
    repository.list_task_stage_transitions(workspace_path, task_id)
}

pub fn list_attention_items(repository: &XiaoRepository) -> Result<AttentionSnapshot, String> {
    repository.list_attention_items()
}

pub fn acknowledge_attention_item(
    repository: &XiaoRepository,
    item_id: &str,
) -> Result<bool, String> {
    repository.acknowledge_attention_item(item_id)
}

pub fn list_task_publications(
    repository: &XiaoRepository,
    project_path: &str,
    task_id: &str,
) -> Result<Vec<PublicationRecord>, String> {
    repository.list_task_publications(project_path, task_id)
}

pub fn open_project(path: &str) -> Result<(), String> {
    let directory = Path::new(path);
    if !directory.is_dir() {
        return Err(format!(
            "Xiao project path is not an existing directory: {}",
            directory.display()
        ));
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut command = Command::new("explorer");
        command.arg(directory).creation_flags(CREATE_NO_WINDOW);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(directory);
        command
    };

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(directory);
        command
    };

    command.spawn().map(|_| ()).map_err(|error| {
        format!(
            "Failed to open Xiao project directory {}: {error}",
            directory.display()
        )
    })
}
