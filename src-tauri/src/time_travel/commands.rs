use tauri::State;

use crate::execution::service::resolve_execution_context;
use crate::xiao::repository::XiaoRepository;

use super::models::{RestoreTurnsRequest, RestoreTurnsResult, TurnCheckpointSummary};

#[tauri::command]
pub fn list_xiao_turn_checkpoints(
    project_path: String,
    task_id: String,
    limit: Option<usize>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<TurnCheckpointSummary>, String> {
    let context = resolve_execution_context(&repository, &project_path, Some(&task_id))?;
    repository.list_turn_checkpoints(&project_path, &task_id, &context.execution_root, limit)
}

#[tauri::command]
pub fn restore_xiao_turns(
    request: RestoreTurnsRequest,
    repository: State<'_, XiaoRepository>,
) -> Result<RestoreTurnsResult, String> {
    let context =
        resolve_execution_context(&repository, &request.project_path, Some(&request.task_id))?;
    repository.restore_turn_checkpoints(
        &request.project_path,
        &request.task_id,
        &request.target_checkpoint_id,
        &context.execution_root,
    )
}
