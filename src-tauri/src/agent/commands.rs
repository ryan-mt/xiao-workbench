use serde_json::Value;
use tauri::{AppHandle, State};

use crate::execution::service::resolve_execution_context;
use crate::xiao::repository::XiaoRepository;

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
    mut params: Value,
    project_path: Option<String>,
    task_id: Option<String>,
    runtime: State<'_, AgentRuntime>,
    repository: State<'_, XiaoRepository>,
) -> Result<Value, String> {
    if method_uses_execution_root(&method) {
        if matches!(method.as_str(), "turn/start" | "command/exec") && task_id.is_none() {
            return Err(format!(
                "Agent method `{method}` requires a persisted Xiao task."
            ));
        }
        let project_path = project_path
            .as_deref()
            .ok_or("This agent request requires a Xiao project context.")?;
        let context = resolve_execution_context(&repository, project_path, task_id.as_deref())?;
        if method == "command/exec" {
            validate_direct_command(&params)?;
        }
        if method == "turn/start" {
            let thread_id = params
                .get("threadId")
                .and_then(Value::as_str)
                .ok_or("turn/start requires a thread id.")?;
            let task_id = task_id
                .as_deref()
                .ok_or("turn/start requires a persisted Xiao task.")?;
            runtime.require_thread_task(
                thread_id,
                &context.project_path,
                task_id,
                &context.execution_root,
            )?;
        }
        strip_execution_path_fields(&mut params);
        apply_execution_root(&method, &mut params, &context.execution_root)?;
    } else if contains_execution_path_fields(&params) {
        return Err(format!(
            "Agent method `{method}` cannot accept frontend-provided execution paths."
        ));
    }
    runtime.request(method, params).await
}

fn method_uses_execution_root(method: &str) -> bool {
    matches!(
        method,
        "turn/start"
            | "command/exec"
            | "fuzzyFileSearch"
            | "skills/list"
            | "plugin/list"
            | "mcpServerStatus/list"
    )
}

fn contains_execution_path_fields(params: &Value) -> bool {
    match params {
        Value::Object(object) => object.iter().any(|(key, value)| {
            matches!(key.as_str(), "cwd" | "cwds" | "roots" | "writableRoots")
                || contains_execution_path_fields(value)
        }),
        Value::Array(values) => values.iter().any(contains_execution_path_fields),
        _ => false,
    }
}

fn validate_direct_command(params: &Value) -> Result<(), String> {
    let object = params
        .as_object()
        .ok_or("command/exec parameters must be an object.")?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "command" | "cwd" | "timeoutMs"))
    {
        return Err("Direct command execution contains unsupported parameters.".to_owned());
    }
    if object
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .is_none_or(|timeout| timeout == 0 || timeout > 120_000)
    {
        return Err(
            "Direct command execution requires a timeout of at most 120 seconds.".to_owned(),
        );
    }
    let command = object
        .get("command")
        .and_then(Value::as_array)
        .ok_or("command/exec requires a command array.")?;
    let command = command
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()
        .ok_or("command/exec command arguments must be strings.")?;
    if command != ["gh", "pr", "create", "--draft", "--fill"] {
        return Err(
            "Direct command execution is limited to Xiao's confirmed draft-PR action.".to_owned(),
        );
    }
    Ok(())
}

fn strip_execution_path_fields(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.retain(|key, _| {
                !matches!(key.as_str(), "cwd" | "cwds" | "roots" | "writableRoots")
            });
            object.values_mut().for_each(strip_execution_path_fields);
        }
        Value::Array(values) => values.iter_mut().for_each(strip_execution_path_fields),
        _ => {}
    }
}

fn apply_execution_root(
    method: &str,
    params: &mut Value,
    execution_root: &str,
) -> Result<(), String> {
    let object = params
        .as_object_mut()
        .ok_or("Agent request parameters must be an object.")?;
    match method {
        "turn/start" => {
            let policy = object
                .get_mut("sandboxPolicy")
                .and_then(Value::as_object_mut)
                .ok_or("turn/start requires an explicit sandbox policy.")?;
            match policy.get("type").and_then(Value::as_str) {
                Some("workspaceWrite") => {
                    policy.insert(
                        "writableRoots".to_owned(),
                        Value::Array(vec![Value::String(execution_root.to_owned())]),
                    );
                }
                Some("readOnly" | "dangerFullAccess") => {
                    policy.remove("writableRoots");
                }
                _ => return Err("turn/start contains an unsupported sandbox policy.".to_owned()),
            }
        }
        "command/exec" => {
            object.insert("cwd".to_owned(), Value::String(execution_root.to_owned()));
        }
        "fuzzyFileSearch" => {
            object.insert(
                "roots".to_owned(),
                Value::Array(vec![Value::String(execution_root.to_owned())]),
            );
        }
        "skills/list" | "plugin/list" | "mcpServerStatus/list" => {
            object.insert(
                "cwds".to_owned(),
                Value::Array(vec![Value::String(execution_root.to_owned())]),
            );
        }
        _ => {
            return Err(format!(
                "Agent method `{method}` has no execution-root policy."
            ))
        }
    }
    Ok(())
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
    project_path: String,
    task_id: String,
    model: Option<String>,
    history: Vec<models::XiaoHistoryItem>,
    thread_id: Option<String>,
    service_tier: Option<String>,
    approval_policy: Option<String>,
    sandbox: Option<String>,
    runtime: State<'_, AgentRuntime>,
    repository: State<'_, XiaoRepository>,
) -> Result<models::AgentSessionStart, String> {
    let context = resolve_execution_context(&repository, &project_path, Some(&task_id))?;
    let session = service::start_xiao_session(
        &runtime,
        context.execution_root.clone(),
        model,
        history,
        thread_id,
        service_tier,
        approval_policy,
        sandbox,
    )
    .await?;
    runtime.bind_thread_to_task(
        &session.thread_id,
        &context.project_path,
        &task_id,
        &context.execution_root,
    )?;
    Ok(session)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        apply_execution_root, contains_execution_path_fields, strip_execution_path_fields,
        validate_direct_command,
    };

    #[test]
    fn native_root_overrides_frontend_cwd_and_search_roots() {
        let mut command = json!({ "command": ["git", "status"], "cwd": "C:/escape" });
        apply_execution_root("command/exec", &mut command, "C:/owned/root").unwrap();
        assert_eq!(command["cwd"], "C:/owned/root");

        let mut search = json!({ "query": "x", "roots": ["C:/escape"] });
        apply_execution_root("fuzzyFileSearch", &mut search, "C:/owned/root").unwrap();
        assert_eq!(search["roots"], json!(["C:/owned/root"]));
    }

    #[test]
    fn direct_commands_are_limited_to_the_confirmed_draft_pr_action() {
        validate_direct_command(&json!({
            "command": ["gh", "pr", "create", "--draft", "--fill"],
            "cwd": "C:/renderer-value",
            "timeoutMs": 120_000
        }))
        .unwrap();
        assert!(validate_direct_command(&json!({
            "command": ["cmd", "/c", "echo unsafe"],
            "timeoutMs": 120_000
        }))
        .is_err());
        assert!(validate_direct_command(&json!({
            "command": ["gh", "pr", "create", "--draft", "--fill"],
            "timeoutMs": 120_000,
            "env": { "PATH": "C:/escape" }
        }))
        .is_err());
    }

    #[test]
    fn native_root_strips_nested_renderer_paths() {
        let mut params = json!({
            "cwd": "C:/escape",
            "nested": { "roots": ["C:/escape"], "keep": true }
        });
        strip_execution_path_fields(&mut params);
        apply_execution_root("command/exec", &mut params, "C:/owned/root").unwrap();
        assert_eq!(params["cwd"], "C:/owned/root");
        assert_eq!(params["nested"], json!({ "keep": true }));
    }

    #[test]
    fn native_root_overrides_workspace_write_and_removes_irrelevant_roots() {
        let mut workspace_write = json!({
            "sandboxPolicy": { "type": "workspaceWrite", "writableRoots": ["C:/escape"] }
        });
        apply_execution_root("turn/start", &mut workspace_write, "C:/owned/root").unwrap();
        assert_eq!(
            workspace_write["sandboxPolicy"]["writableRoots"],
            json!(["C:/owned/root"])
        );

        let mut read_only = json!({
            "sandboxPolicy": { "type": "readOnly", "writableRoots": ["C:/escape"] }
        });
        apply_execution_root("turn/start", &mut read_only, "C:/owned/root").unwrap();
        assert!(read_only["sandboxPolicy"].get("writableRoots").is_none());
    }

    #[test]
    fn unscoped_agent_methods_cannot_smuggle_execution_paths() {
        assert!(contains_execution_path_fields(
            &json!({ "cwd": "C:/escape" })
        ));
        assert!(contains_execution_path_fields(&json!({
            "sandboxPolicy": { "writableRoots": ["C:/escape"] }
        })));
        assert!(contains_execution_path_fields(&json!({
            "nested": { "cwd": "C:/escape" }
        })));
        assert!(!contains_execution_path_fields(
            &json!({ "threadId": "thread" })
        ));
    }
}
