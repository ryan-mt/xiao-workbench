use super::models::FileNode;
use super::models::WorkspaceSnapshot;
use super::service::{list_workspace_directory, read_workspace_text_file, snapshot_workspace};

#[tauri::command]
pub fn get_workspace_snapshot(path: Option<String>) -> Result<WorkspaceSnapshot, String> {
    snapshot_workspace(path.as_deref())
}

#[tauri::command]
pub fn read_workspace_file(
    workspace_path: String,
    relative_path: String,
) -> Result<String, String> {
    read_workspace_text_file(&workspace_path, &relative_path)
}

#[tauri::command]
pub fn list_workspace_files(
    workspace_path: String,
    relative_path: String,
) -> Result<Vec<FileNode>, String> {
    list_workspace_directory(&workspace_path, &relative_path)
}
