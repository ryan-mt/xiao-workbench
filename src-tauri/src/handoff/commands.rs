use tauri::State;

use crate::xiao::repository::XiaoRepository;

use super::models::{
    ExportHandoffRequest, ExportHandoffResult, ImportHandoffRequest, ImportHandoffResult,
};
use super::service::{export_handoff, import_handoff};

#[tauri::command]
pub fn export_xiao_handoff(
    request: ExportHandoffRequest,
    repository: State<'_, XiaoRepository>,
) -> Result<ExportHandoffResult, String> {
    export_handoff(&repository, request)
}

#[tauri::command]
pub fn import_xiao_handoff(
    request: ImportHandoffRequest,
    repository: State<'_, XiaoRepository>,
) -> Result<ImportHandoffResult, String> {
    import_handoff(&repository, request)
}
