use tauri::State;

use crate::agent::runtime::EnvironmentRuntimeRegistry;
use crate::runs::service::RunService;
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
    runs: State<'_, RunService>,
) -> Result<CodexUpdateResult, String> {
    let reservation = runtimes.reserve_update(|| repository.has_active_runs())?;
    let result = match runtimes.stop_all() {
        Ok(()) => match tauri::async_runtime::spawn_blocking(update_codex).await {
            Ok(result) => result,
            Err(error) => Err(error.to_string()),
        },
        Err(error) => Err(error),
    };
    drop(reservation);
    runs.wake();
    result
}
