use tauri::AppHandle;

use super::models::{XiaoProjectSummary, XiaoWorkspaceDocument};
use super::service;

#[tauri::command]
pub fn load_xiao_workspace(
    app: AppHandle,
    workspace_path: String,
) -> Result<Option<XiaoWorkspaceDocument>, String> {
    service::load_workspace(&app, &workspace_path)
}

#[tauri::command]
pub fn save_xiao_workspace(app: AppHandle, document: XiaoWorkspaceDocument) -> Result<(), String> {
    service::save_workspace(&app, document)
}

#[tauri::command]
pub fn list_xiao_projects(app: AppHandle) -> Result<Vec<XiaoProjectSummary>, String> {
    service::list_projects(&app)
}

#[tauri::command]
pub fn open_xiao_project(path: String) -> Result<(), String> {
    service::open_project(&path)
}
