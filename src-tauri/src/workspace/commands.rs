use tauri::State;

use crate::execution::service::resolve_execution_context;
use crate::xiao::repository::XiaoRepository;
use crate::browser::preview::PreviewRegistry;

use super::models::FileNode;
use super::models::WorkspaceSnapshot;
use super::service::{
    list_workspace_directory, read_workspace_text_file, resolve_workspace_preview_file,
    snapshot_workspace,
};

#[tauri::command]
pub fn get_workspace_snapshot(
    path: Option<String>,
    task_id: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<WorkspaceSnapshot, String> {
    let path = path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let context = resolve_execution_context(&repository, &path, task_id.as_deref())?;
    snapshot_workspace(context)
}

#[tauri::command]
pub fn read_workspace_file(
    project_path: String,
    task_id: Option<String>,
    relative_path: String,
    repository: State<'_, XiaoRepository>,
) -> Result<String, String> {
    let context = resolve_execution_context(&repository, &project_path, task_id.as_deref())?;
    read_workspace_text_file(&context.execution_root, &relative_path)
}

#[tauri::command]
pub fn list_workspace_files(
    project_path: String,
    task_id: Option<String>,
    relative_path: String,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<FileNode>, String> {
    let context = resolve_execution_context(&repository, &project_path, task_id.as_deref())?;
    list_workspace_directory(&context.execution_root, &relative_path)
}

#[tauri::command]
pub fn open_workspace_preview(
    project_path: String,
    task_id: Option<String>,
    relative_path: String,
    repository: State<'_, XiaoRepository>,
    previews: State<'_, PreviewRegistry>,
) -> Result<String, String> {
    let context = resolve_execution_context(&repository, &project_path, task_id.as_deref())?;
    let (root, relative) =
        resolve_workspace_preview_file(&context.execution_root, &relative_path)?;
    previews.register(root, &relative)
}
