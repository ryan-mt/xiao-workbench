use serde_json::Value;
use tauri::{AppHandle, State};

use super::runtime::{AgentRuntime, StartResult};
use super::{models, service};

#[tauri::command]
pub fn start_agent_runtime(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
) -> Result<StartResult, String> {
    runtime.start(app)
}

#[tauri::command]
pub fn stop_agent_runtime(runtime: State<'_, AgentRuntime>) -> Result<(), String> {
    runtime.stop()
}

#[tauri::command]
pub async fn agent_request(
    method: String,
    params: Value,
    runtime: State<'_, AgentRuntime>,
) -> Result<Value, String> {
    runtime.request(method, params).await
}

#[tauri::command]
pub fn agent_reply(
    request_id: Value,
    result: Value,
    runtime: State<'_, AgentRuntime>,
) -> Result<(), String> {
    runtime.reply(request_id, result)
}

#[tauri::command]
pub async fn read_agent_account(
    runtime: State<'_, AgentRuntime>,
) -> Result<models::AgentAccountSummary, String> {
    service::read_account(&runtime).await
}

#[tauri::command]
pub async fn read_agent_usage(
    runtime: State<'_, AgentRuntime>,
) -> Result<models::AgentAccountUsage, String> {
    service::read_account_usage(&runtime).await
}

#[tauri::command]
pub async fn list_agent_models(
    runtime: State<'_, AgentRuntime>,
) -> Result<Vec<models::AgentModelSummary>, String> {
    service::list_models(&runtime).await
}

#[tauri::command]
pub async fn start_xiao_session(
    workspace_path: String,
    model: Option<String>,
    history: Vec<models::XiaoHistoryItem>,
    thread_id: Option<String>,
    service_tier: Option<String>,
    approval_policy: Option<String>,
    sandbox: Option<String>,
    runtime: State<'_, AgentRuntime>,
) -> Result<models::AgentSessionStart, String> {
    service::start_xiao_session(
        &runtime,
        workspace_path,
        model,
        history,
        thread_id,
        service_tier,
        approval_policy,
        sandbox,
    )
    .await
}
