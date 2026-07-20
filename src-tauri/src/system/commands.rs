use tauri::State;

use crate::agent::runtime::EnvironmentRuntimeRegistry;
use crate::xiao::repository::XiaoRepository;

use super::models::{CodexUpdateResult, CodexUpdateStatus, SystemInfo};
use super::service::{check_codex_update as check_update, read_system_info, update_codex};

#[tauri::command]
pub async fn get_system_info() -> Result<SystemInfo, String> {
    tauri::async_runtime::spawn_blocking(read_system_info)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn check_codex_update() -> Result<CodexUpdateStatus, String> {
    tauri::async_runtime::spawn_blocking(check_update)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn update_codex_cli(
    runtimes: State<'_, EnvironmentRuntimeRegistry>,
    repository: State<'_, XiaoRepository>,
) -> Result<CodexUpdateResult, String> {
    if repository.has_active_runs()? {
        return Err("Wait for active Xiao runs to finish before updating Codex.".to_owned());
    }
    runtimes.stop_all()?;
    tauri::async_runtime::spawn_blocking(update_codex)
        .await
        .map_err(|error| error.to_string())?
}
