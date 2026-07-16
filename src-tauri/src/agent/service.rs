use serde_json::{json, Value};

use super::models::{
    AgentAccountSummary, AgentAccountUsage, AgentDailyUsageBucket, AgentModelSummary,
    AgentSessionStart, ModelListResponse, ThreadStartResponse, XiaoHistoryItem,
};
use super::runtime::AgentRuntime;

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

pub async fn start_xiao_session(
    runtime: &AgentRuntime,
    workspace_path: String,
    model: Option<String>,
    history: Vec<XiaoHistoryItem>,
    thread_id: Option<String>,
    approval_policy: Option<String>,
    sandbox: Option<String>,
) -> Result<AgentSessionStart, String> {
    if workspace_path.trim().is_empty() {
        return Err("A workspace path is required to start a Xiao session.".to_owned());
    }

    let (method, params) = isolated_thread_start_request(
        &workspace_path,
        model.as_deref(),
        thread_id.as_deref(),
        approval_policy.as_deref(),
        sandbox.as_deref(),
    );
    let result = runtime.request(method.to_owned(), params).await?;
    let response: ThreadStartResponse = serde_json::from_value(result)
        .map_err(|error| format!("Invalid {method} response: {error}"))?;

    let history_items = history_items_for_injection(history)?;
    if !history_items.is_empty() {
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

    Ok(AgentSessionStart {
        thread_id: response.thread.id,
        model: response.model,
    })
}

fn isolated_thread_start_request(
    workspace_path: &str,
    model: Option<&str>,
    _persisted_thread_id: Option<&str>,
    approval_policy: Option<&str>,
    sandbox: Option<&str>,
) -> (&'static str, Value) {
    (
        "thread/start",
        json!({
            "cwd": workspace_path,
            "model": model,
            "approvalPolicy": approval_policy,
            "sandbox": sandbox,
            "ephemeral": true,
            "serviceName": "Xiao Workbench",
        }),
    )
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
    fn isolated_sessions_ignore_persisted_thread_ids() {
        let (method, params) = isolated_thread_start_request(
            "C:/workspace",
            Some("gpt-test"),
            Some("persisted-thread"),
            Some("on-request"),
            Some("workspace-write"),
        );

        assert_eq!(method, "thread/start");
        assert_eq!(params["ephemeral"], true);
        assert_eq!(params["serviceName"], "Xiao Workbench");
        assert!(params.get("threadId").is_none());
    }

    #[test]
    fn isolated_sessions_restore_xiao_history() {
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
