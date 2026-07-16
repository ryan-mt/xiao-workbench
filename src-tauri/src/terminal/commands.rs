use tauri::{AppHandle, State};

use super::runtime::{TerminalManager, TerminalStartResult};

#[tauri::command]
pub fn start_terminal(
    app: AppHandle,
    manager: State<'_, TerminalManager>,
    session_id: String,
    workspace_path: String,
    shell: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalStartResult, String> {
    manager.start(app, session_id, workspace_path, shell, cols, rows)
}

#[tauri::command]
pub fn write_terminal(
    manager: State<'_, TerminalManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    manager.write(&session_id, &data)
}

#[tauri::command]
pub fn resize_terminal(
    manager: State<'_, TerminalManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&session_id, cols, rows)
}

#[tauri::command]
pub fn stop_terminal(
    manager: State<'_, TerminalManager>,
    session_id: String,
) -> Result<(), String> {
    manager.stop(&session_id)
}
