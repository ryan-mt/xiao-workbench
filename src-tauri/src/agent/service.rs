use serde_json::{json, Value};

use super::models::{
    AgentAccountSummary, AgentAccountUsage, AgentDailyUsageBucket, AgentModelSummary,
    ModelListResponse, PersistentAgentSession, ThreadStartResponse, XiaoHistoryItem,
};
use super::runtime::AgentRuntime;
use crate::xiao::models::{XiaoThreadBinding, XiaoThreadPersistence};

const MODEL_PAGE_SIZE: u64 = 100;

pub async fn read_account(runtime: &AgentRuntime) -> Result<AgentAccountSummary, String> {
    let result = runtime
        .request("account/read".to_owned(), json!({ "refreshToken": false }))
        .await?;
    let account = result.get("account").filter(|account| !account.is_null());

    Ok(AgentAccountSummary {
        authenticated: account.is_some(),
        auth_mode: account
            .and_then(|account| account.get("type"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        email: account
            .and_then(|account| account.get("email"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        plan_type: account
            .and_then(|account| account.get("planType"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        requires_openai_auth: result
            .get("requiresOpenaiAuth")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    })
}

pub async fn read_account_usage(runtime: &AgentRuntime) -> Result<AgentAccountUsage, String> {
    let result = runtime
        .request("account/usage/read".to_owned(), Value::Null)
        .await?;
    let summary = result
        .get("summary")
        .ok_or("account/usage/read did not include a summary.")?;
    let daily_usage_buckets = result
        .get("dailyUsageBuckets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|bucket| {
            Some(AgentDailyUsageBucket {
                start_date: bucket.get("startDate")?.as_str()?.to_owned(),
                tokens: read_u64(bucket.get("tokens")?)?,
            })
        })
        .collect();

    Ok(AgentAccountUsage {
        lifetime_tokens: summary.get("lifetimeTokens").and_then(read_u64),
        peak_daily_tokens: summary.get("peakDailyTokens").and_then(read_u64),
        longest_running_turn_sec: summary.get("longestRunningTurnSec").and_then(read_u64),
        current_streak_days: summary.get("currentStreakDays").and_then(read_u64),
        longest_streak_days: summary.get("longestStreakDays").and_then(read_u64),
        daily_usage_buckets,
    })
}

fn read_u64(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str()?.parse().ok())
}

pub async fn list_models(runtime: &AgentRuntime) -> Result<Vec<AgentModelSummary>, String> {
    let mut cursor: Option<String> = None;
    let mut models = Vec::new();

    loop {
        let result = runtime
            .request(
                "model/list".to_owned(),
                json!({
                    "cursor": cursor,
                    "limit": MODEL_PAGE_SIZE,
                    "includeHidden": false,
                }),
            )
            .await?;
        let response: ModelListResponse = serde_json::from_value(result)
            .map_err(|error| format!("Invalid model/list response: {error}"))?;
        models.extend(
            response
                .data
                .into_iter()
                .filter(|model| !model.hidden)
                .map(|model| AgentModelSummary {
                    id: model.id,
                    model: model.model,
                    display_name: model.display_name,
                    description: model.description,
                    is_default: model.is_default,
                    default_reasoning_effort: model.default_reasoning_effort,
                    supported_reasoning_efforts: model.supported_reasoning_efforts,
                    service_tiers: model.service_tiers,
                    context_window: model.context_window,
                }),
        );

        match response.next_cursor {
            Some(next_cursor) if Some(&next_cursor) != cursor.as_ref() => {
                cursor = Some(next_cursor)
            }
            Some(_) => return Err("model/list returned the same cursor twice.".to_owned()),
            None => break,
        }
    }

    Ok(models)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn prepare_persistent_xiao_session(
    runtime: &AgentRuntime,
    workspace_path: &str,
    project_path: &str,
    task_id: &str,
    model: Option<&str>,
    history: Vec<XiaoHistoryItem>,
    binding: Option<&XiaoThreadBinding>,
    service_tier: Option<&str>,
    approval_policy: &str,
    sandbox: &str,
    enable_lsp_tools: bool,
) -> Result<PersistentAgentSession, String> {
    if workspace_path.trim().is_empty() {
        return Err("A workspace path is required to prepare a Xiao session.".to_owned());
    }

    if let Some(binding) = resumable_persistent_binding(binding)? {
        if runtime.is_thread_bound(&binding.thread_id, project_path, task_id, workspace_path)? {
            return Ok(PersistentAgentSession {
                thread_id: binding.thread_id.clone(),
                model: model.map(str::to_owned),
                materialized: true,
            });
        }
        let result = runtime
            .request(
                "thread/resume".to_owned(),
                json!({
                    "threadId": binding.thread_id,
                    "cwd": workspace_path,
                    "runtimeWorkspaceRoots": [workspace_path],
                    "approvalPolicy": approval_policy,
                    "sandbox": sandbox,
                    "excludeTurns": false,
                }),
            )
            .await?;
        let response: ThreadStartResponse = serde_json::from_value(result)
            .map_err(|error| format!("Invalid thread/resume response: {error}"))?;
        validate_persistent_thread(&response, &binding.thread_id)?;
        runtime.bind_thread_to_task(&response.thread.id, project_path, task_id, workspace_path)?;
        return Ok(PersistentAgentSession {
            thread_id: response.thread.id,
            model: response.model.or_else(|| model.map(str::to_owned)),
            materialized: true,
        });
    }

    let result = runtime
        .request(
            "thread/start".to_owned(),
            persistent_thread_start_request(
                workspace_path,
                model,
                service_tier,
                approval_policy,
                sandbox,
                enable_lsp_tools,
            ),
        )
        .await?;
    let response: ThreadStartResponse = serde_json::from_value(result)
        .map_err(|error| format!("Invalid thread/start response: {error}"))?;
    validate_persistent_thread(&response, &response.thread.id)?;
    let history_items = history_items_for_injection(history)?;
    let materialized = !history_items.is_empty();
    if materialized {
        runtime
            .request(
                "thread/inject_items".to_owned(),
                json!({
                    "threadId": response.thread.id,
                    "items": history_items,
                }),
            )
            .await?;
    }
    runtime.bind_thread_to_task(&response.thread.id, project_path, task_id, workspace_path)?;
    Ok(PersistentAgentSession {
        thread_id: response.thread.id,
        model: response.model.or_else(|| model.map(str::to_owned)),
        materialized,
    })
}

fn resumable_persistent_binding(
    binding: Option<&XiaoThreadBinding>,
) -> Result<Option<&XiaoThreadBinding>, String> {
    let Some(binding) = binding else {
        return Ok(None);
    };
    if binding.persistence != XiaoThreadPersistence::Persistent || !binding.materialized {
        return Ok(None);
    }
    if binding.thread_source.as_deref() != Some("xiao-workbench") {
        return Err("The stored Codex thread is not owned by Xiao Workbench.".to_owned());
    }
    Ok(Some(binding))
}

fn validate_persistent_thread(
    response: &ThreadStartResponse,
    expected_thread_id: &str,
) -> Result<(), String> {
    if response.thread.id != expected_thread_id
        || response.thread.ephemeral != Some(false)
        || response.thread.thread_source.as_deref() != Some("xiao-workbench")
    {
        return Err(
            "Codex returned a thread that does not match Xiao's persistent ownership binding."
                .to_owned(),
        );
    }
    Ok(())
}

fn persistent_thread_start_request(
    workspace_path: &str,
    model: Option<&str>,
    service_tier: Option<&str>,
    approval_policy: &str,
    sandbox: &str,
    enable_lsp_tools: bool,
) -> Value {
    let mut params = json!({
        "cwd": workspace_path,
        "runtimeWorkspaceRoots": [workspace_path],
        "model": model,
        "serviceTier": service_tier,
        "approvalPolicy": approval_policy,
        "sandbox": sandbox,
        "ephemeral": false,
        "serviceName": "Xiao Workbench",
        "threadSource": "xiao-workbench",
    });
    if enable_lsp_tools {
        params["dynamicTools"] = crate::lsp::dynamic_tool_specs();
    }
    params
}

fn history_items_for_injection(history: Vec<XiaoHistoryItem>) -> Result<Vec<Value>, String> {
    history
        .into_iter()
        .filter(|item| !item.text.trim().is_empty())
        .map(history_item_to_response_item)
        .collect()
}

fn history_item_to_response_item(item: XiaoHistoryItem) -> Result<Value, String> {
    let text = item.text.trim().to_owned();
    match item.role.as_str() {
        "user" => Ok(json!({
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": text }],
        })),
        "assistant" => Ok(json!({
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": text }],
        })),
        role => Err(format!("Unsupported Xiao history role `{role}`.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistent_sessions_are_source_tagged_and_non_ephemeral() {
        let params = persistent_thread_start_request(
            "C:/workspace",
            Some("gpt-test"),
            Some("priority"),
            "on-request",
            "workspace-write",
            true,
        );

        assert_eq!(params["ephemeral"], false);
        assert_eq!(params["threadSource"], "xiao-workbench");
        assert_eq!(params["serviceName"], "Xiao Workbench");
        assert_eq!(params["runtimeWorkspaceRoots"], json!(["C:/workspace"]));
        assert_eq!(params["serviceTier"], "priority");
        assert_eq!(params["dynamicTools"][0]["name"], "xiao_lsp");
    }

    #[test]
    fn materialized_persistent_binding_requires_xiao_ownership() {
        let wrong_source = XiaoThreadBinding {
            thread_id: "owned".to_owned(),
            persistence: XiaoThreadPersistence::Persistent,
            materialized: true,
            thread_source: Some("another-client".to_owned()),
            cli_version: None,
        };
        assert!(resumable_persistent_binding(Some(&wrong_source)).is_err());

        let provisional = XiaoThreadBinding {
            materialized: false,
            ..wrong_source
        };
        assert!(resumable_persistent_binding(Some(&provisional))
            .unwrap()
            .is_none());
    }

    #[test]
    fn persistent_thread_validation_rejects_wrong_source_or_id() {
        let valid = ThreadStartResponse {
            thread: super::super::models::ThreadRecord {
                id: "owned".to_owned(),
                ephemeral: Some(false),
                thread_source: Some("xiao-workbench".to_owned()),
            },
            model: Some("gpt-test".to_owned()),
        };
        assert!(validate_persistent_thread(&valid, "owned").is_ok());
        assert!(validate_persistent_thread(&valid, "other").is_err());

        let wrong_source = ThreadStartResponse {
            thread: super::super::models::ThreadRecord {
                id: "owned".to_owned(),
                ephemeral: Some(false),
                thread_source: Some("another-client".to_owned()),
            },
            model: None,
        };
        assert!(validate_persistent_thread(&wrong_source, "owned").is_err());
    }

    #[test]
    fn persistent_sessions_restore_xiao_history() {
        let items = history_items_for_injection(vec![
            XiaoHistoryItem {
                role: "user".to_owned(),
                text: "Previous question".to_owned(),
            },
            XiaoHistoryItem {
                role: "assistant".to_owned(),
                text: "Previous answer".to_owned(),
            },
            XiaoHistoryItem {
                role: "assistant".to_owned(),
                text: "   ".to_owned(),
            },
        ])
        .unwrap();

        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["role"], "user");
        assert_eq!(items[1]["role"], "assistant");
    }

    #[test]
    fn history_items_use_responses_api_message_shape() {
        let item = history_item_to_response_item(XiaoHistoryItem {
            role: "assistant".to_owned(),
            text: "  Done  ".to_owned(),
        })
        .unwrap();

        assert_eq!(item["type"], "message");
        assert_eq!(item["role"], "assistant");
        assert_eq!(item["content"][0]["type"], "output_text");
        assert_eq!(item["content"][0]["text"], "Done");
    }
}
