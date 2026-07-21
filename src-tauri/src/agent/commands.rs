use serde_json::Value;
use tauri::{AppHandle, State};

use crate::execution::service::resolve_execution_context;
use crate::lsp::LspManager;
use crate::xiao::repository::XiaoRepository;

use super::runtime::{EnvironmentRuntimeRegistry, StartResult};
use super::{models, service};

#[tauri::command]
pub fn start_agent_runtime(
    app: AppHandle,
    project_path: String,
    task_id: Option<String>,
    runtimes: State<'_, EnvironmentRuntimeRegistry>,
    repository: State<'_, XiaoRepository>,
) -> Result<StartResult, String> {
    let context = resolve_execution_context(&repository, &project_path, task_id.as_deref())?;
    runtimes.start(app, &context.environment.id)
}

#[tauri::command]
pub fn stop_agent_runtime(
    project_path: String,
    task_id: Option<String>,
    runtimes: State<'_, EnvironmentRuntimeRegistry>,
    lsp: State<'_, LspManager>,
    repository: State<'_, XiaoRepository>,
) -> Result<(), String> {
    let context = resolve_execution_context(&repository, &project_path, task_id.as_deref())?;
    runtimes.stop(&context.environment.id)?;
    lsp.stop_environment(&context.environment.id)
}

#[tauri::command]
pub async fn agent_request(
    method: String,
    mut params: Value,
    project_path: Option<String>,
    task_id: Option<String>,
    runtimes: State<'_, EnvironmentRuntimeRegistry>,
    repository: State<'_, XiaoRepository>,
) -> Result<Value, String> {
    validate_renderer_agent_request(&method, &params)?;
    let project_path = project_path
        .as_deref()
        .ok_or("This agent request requires a Xiao project context.")?;
    let task_id = task_id
        .as_deref()
        .ok_or("This agent request requires a persisted Xiao task.")?;
    let context = resolve_execution_context(&repository, project_path, Some(task_id))?;
    if method_uses_execution_root(&method) {
        if method == "command/exec" {
            validate_direct_command(&params)?;
        }
        strip_execution_path_fields(&mut params);
        apply_execution_root(&method, &mut params, &context.execution_root)?;
    }
    if let Some(thread_id) = params.get("threadId").and_then(Value::as_str) {
        runtimes.require_thread_task(
            &context.environment.id,
            thread_id,
            &context.project_path,
            task_id,
            &context.execution_root,
        )?;
    }
    runtimes
        .request(&context.environment.id, method, params)
        .await
}

fn validate_renderer_agent_request(method: &str, params: &Value) -> Result<(), String> {
    if native_run_method(method) {
        return Err(format!(
            "Agent method `{method}` is owned by the native Xiao RunService."
        ));
    }
    if !renderer_agent_method(method) {
        return Err(format!(
            "Agent method `{method}` is not available to the Xiao renderer."
        ));
    }
    if !method_uses_execution_root(method) && contains_execution_path_fields(params) {
        return Err(format!(
            "Agent method `{method}` cannot accept frontend-provided execution paths."
        ));
    }
    Ok(())
}

fn renderer_agent_method(method: &str) -> bool {
    matches!(
        method,
        "app/list"
            | "command/exec"
            | "fuzzyFileSearch"
            | "mcpServerStatus/list"
            | "plugin/install"
            | "plugin/list"
            | "plugin/uninstall"
            | "skills/config/write"
            | "skills/list"
            | "thread/compact/start"
            | "thread/goal/clear"
            | "thread/goal/set"
            | "thread/rollback"
            | "thread/settings/update"
    )
}

fn native_run_method(method: &str) -> bool {
    method.starts_with("turn/")
        || matches!(
            method,
            "thread/start"
                | "thread/resume"
                | "thread/inject_items"
                | "thread/delete"
                | "thread/fork"
                | "thread/archive"
                | "thread/unarchive"
        )
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
pub async fn read_agent_account(
    project_path: String,
    task_id: Option<String>,
    runtimes: State<'_, EnvironmentRuntimeRegistry>,
    repository: State<'_, XiaoRepository>,
) -> Result<models::AgentAccountSummary, String> {
    let context = resolve_execution_context(&repository, &project_path, task_id.as_deref())?;
    let runtime = runtimes.runtime(&context.environment.id)?;
    service::read_account(&runtime).await
}

#[tauri::command]
pub async fn read_agent_usage(
    project_path: String,
    task_id: Option<String>,
    runtimes: State<'_, EnvironmentRuntimeRegistry>,
    repository: State<'_, XiaoRepository>,
) -> Result<models::AgentAccountUsage, String> {
    let context = resolve_execution_context(&repository, &project_path, task_id.as_deref())?;
    let runtime = runtimes.runtime(&context.environment.id)?;
    service::read_account_usage(&runtime).await
}

#[tauri::command]
pub async fn list_agent_models(
    project_path: String,
    task_id: Option<String>,
    runtimes: State<'_, EnvironmentRuntimeRegistry>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<models::AgentModelSummary>, String> {
    let context = resolve_execution_context(&repository, &project_path, task_id.as_deref())?;
    let runtime = runtimes.runtime(&context.environment.id)?;
    service::list_models(&runtime).await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        apply_execution_root, contains_execution_path_fields, native_run_method,
        renderer_agent_method, strip_execution_path_fields, validate_direct_command,
        validate_renderer_agent_request,
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
    fn renderer_cannot_invoke_native_run_or_thread_lifecycle_methods() {
        for method in [
            "turn/start",
            "turn/steer",
            "turn/interrupt",
            "thread/start",
            "thread/resume",
            "thread/inject_items",
            "thread/delete",
        ] {
            assert!(native_run_method(method), "{method} should be native-owned");
        }
        assert!(!native_run_method("thread/settings/update"));
        assert!(!native_run_method("thread/compact/start"));
    }

    #[test]
    fn renderer_agent_method_allowlist_covers_current_frontend_calls() {
        for method in [
            "app/list",
            "command/exec",
            "fuzzyFileSearch",
            "mcpServerStatus/list",
            "plugin/install",
            "plugin/list",
            "plugin/uninstall",
            "skills/config/write",
            "skills/list",
            "thread/compact/start",
            "thread/goal/clear",
            "thread/goal/set",
            "thread/rollback",
            "thread/settings/update",
        ] {
            assert!(renderer_agent_method(method), "{method} should be allowed");
            assert!(
                validate_renderer_agent_request(method, &json!({})).is_ok(),
                "{method} should pass renderer validation"
            );
        }
    }

    #[test]
    fn renderer_cannot_bypass_execution_root_with_filesystem_or_process_methods() {
        for (method, params) in [
            ("fs/readFile", json!({ "path": "C:/escape/secret.txt" })),
            ("fs/writeFile", json!({ "path": "C:/escape/output.txt" })),
            ("fs/remove", json!({ "path": "C:/escape" })),
            (
                "fs/copy",
                json!({
                    "sourcePath": "C:/escape/source.txt",
                    "destinationPath": "C:/escape/destination.txt"
                }),
            ),
            (
                "process/spawn",
                json!({ "command": ["cmd", "/c", "whoami"], "cwd": "C:/escape" }),
            ),
        ] {
            let error = validate_renderer_agent_request(method, &params).unwrap_err();
            assert!(
                error.contains("not available to the Xiao renderer"),
                "unexpected rejection for {method}: {error}"
            );
        }
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
