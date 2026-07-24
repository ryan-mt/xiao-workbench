use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::verification::models::AcceptanceContractVersionSummary;

pub const XIAO_SCHEMA_VERSION: u32 = 1;
pub const XIAO_DATABASE_SCHEMA_VERSION: i64 = 9;

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStage {
    #[default]
    Draft,
    InProgress,
    ReadyForReview,
    Published,
    Completed,
}

impl TaskStage {
    pub fn as_database(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::InProgress => "in_progress",
            Self::ReadyForReview => "ready_for_review",
            Self::Published => "published",
            Self::Completed => "completed",
        }
    }

    pub fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "draft" => Ok(Self::Draft),
            "in_progress" => Ok(Self::InProgress),
            "ready_for_review" => Ok(Self::ReadyForReview),
            "published" => Ok(Self::Published),
            "completed" => Ok(Self::Completed),
            _ => Err(format!("Unsupported Xiao Task stage `{value}`.")),
        }
    }

    pub fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Draft, Self::InProgress)
                | (Self::InProgress, Self::ReadyForReview)
                | (
                    Self::ReadyForReview,
                    Self::InProgress | Self::Published | Self::Completed
                )
                | (Self::Published, Self::InProgress | Self::Completed)
                | (Self::Completed, Self::InProgress)
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStageTransitionRequest {
    pub workspace_path: String,
    pub task_id: String,
    pub expected_version: i64,
    pub to_stage: TaskStage,
    pub actor: String,
    pub reason: String,
    pub source_run_id: Option<String>,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStageTransition {
    pub id: String,
    pub task_id: String,
    pub from_stage: Option<TaskStage>,
    pub to_stage: TaskStage,
    pub expected_version: Option<i64>,
    pub resulting_version: i64,
    pub actor: String,
    pub reason: String,
    pub source_run_id: Option<String>,
    pub idempotency_key: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionKind {
    Decision,
    Failure,
    Verification,
    Review,
    Publication,
    Routine,
    Unread,
}

impl AttentionKind {
    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "decision" => Ok(Self::Decision),
            "failure" => Ok(Self::Failure),
            "verification" => Ok(Self::Verification),
            "review" => Ok(Self::Review),
            "publication" => Ok(Self::Publication),
            "routine" => Ok(Self::Routine),
            "unread" => Ok(Self::Unread),
            _ => Err(format!("Unsupported Attention kind `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionSurface {
    Timeline,
    Verification,
    Changes,
    Schedule,
    Observatory,
}

impl AttentionSurface {
    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "timeline" => Ok(Self::Timeline),
            "verification" => Ok(Self::Verification),
            "changes" => Ok(Self::Changes),
            "schedule" => Ok(Self::Schedule),
            "observatory" => Ok(Self::Observatory),
            _ => Err(format!("Unsupported Attention surface `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub id: String,
    pub project_path: String,
    pub project_name: String,
    pub task_id: String,
    pub task_title: String,
    pub task_stage: TaskStage,
    pub task_stage_version: i64,
    pub run_id: Option<String>,
    pub kind: AttentionKind,
    pub priority: i64,
    pub title: String,
    pub safe_summary: String,
    pub source_occurrence_key: String,
    pub surface: AttentionSurface,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
    pub acknowledged_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionHydrationStatus {
    Live,
    Partial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionSnapshot {
    pub items: Vec<AttentionItem>,
    pub status: AttentionHydrationStatus,
    pub generated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicationKind {
    Branch,
    PullRequest,
}

impl PublicationKind {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::Branch => "branch",
            Self::PullRequest => "pull_request",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "branch" => Ok(Self::Branch),
            "pull_request" => Ok(Self::PullRequest),
            _ => Err(format!("Unsupported publication kind `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicationStatus {
    Active,
    Superseded,
    Merged,
    Closed,
    Unavailable,
}

impl PublicationStatus {
    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "active" => Ok(Self::Active),
            "superseded" => Ok(Self::Superseded),
            "merged" => Ok(Self::Merged),
            "closed" => Ok(Self::Closed),
            "unavailable" => Ok(Self::Unavailable),
            _ => Err(format!("Unsupported publication status `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationRecord {
    pub id: String,
    pub project_path: String,
    pub task_id: String,
    pub source_run_id: String,
    pub kind: PublicationKind,
    pub status: PublicationStatus,
    pub branch: String,
    pub remote: Option<String>,
    pub url: Option<String>,
    pub pull_request_number: Option<i64>,
    pub check_state: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaoWorkspaceDocument {
    pub schema_version: u32,
    pub workspace_path: String,
    pub active_task_id: Option<String>,
    pub show_archived: bool,
    pub tasks: Vec<XiaoTaskDocument>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaoWorkspaceUpdate {
    pub schema_version: u32,
    pub workspace_path: String,
    pub active_task_id: Option<String>,
    pub show_archived: bool,
    pub task_ids: Vec<String>,
    pub tasks: Vec<XiaoTaskDocument>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaoTaskDocument {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub stage: TaskStage,
    #[serde(default)]
    pub stage_version: i64,
    #[serde(default)]
    pub codex_profile_id: Option<String>,
    #[serde(default = "default_object")]
    pub workbench_state: Value,
    #[serde(default)]
    pub draft_text: String,
    #[serde(default)]
    pub follow_ups: Vec<Value>,
    pub archived: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub unread: bool,
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub thread_binding: Option<XiaoThreadBinding>,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_approval_policy")]
    pub approval_policy: String,
    #[serde(default = "default_sandbox_mode")]
    pub sandbox_mode: String,
    #[serde(default)]
    pub goal: Option<Value>,
    #[serde(default)]
    pub acceptance_contract: Option<AcceptanceContractVersionSummary>,
    #[serde(default)]
    pub timeline: Vec<Value>,
    #[serde(default = "default_true")]
    pub timeline_loaded: bool,
    #[serde(default = "default_true")]
    pub timeline_complete: bool,
    #[serde(default)]
    pub timeline_start: usize,
    #[serde(default)]
    pub timeline_entry_count: usize,
    #[serde(default)]
    pub plan: Option<Value>,
    #[serde(default)]
    pub execution_environment_id: Option<String>,
    #[serde(default)]
    pub workspace_mode: XiaoWorkspaceMode,
    #[serde(default)]
    pub managed_worktree_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum XiaoWorkspaceMode {
    #[default]
    Local,
    ManagedWorktree,
}

impl XiaoWorkspaceMode {
    pub fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "local" => Ok(Self::Local),
            "managed-worktree" => Ok(Self::ManagedWorktree),
            _ => Err(format!("Unsupported Xiao workspace mode `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaoThreadBinding {
    pub thread_id: String,
    pub persistence: XiaoThreadPersistence,
    pub materialized: bool,
    pub thread_source: Option<String>,
    pub cli_version: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum XiaoThreadPersistence {
    Ephemeral,
    Persistent,
    LegacyUntrusted,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaoTimelinePage {
    pub entries: Vec<Value>,
    pub start: usize,
    pub total: usize,
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaoHistorySearchResult {
    pub project_path: String,
    pub project_name: String,
    pub task_id: String,
    pub task_title: String,
    pub task_archived: bool,
    pub entry_id: String,
    pub role: String,
    pub match_kind: String,
    pub snippet: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroupUpdate {
    pub id: String,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroup {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPresentationUpdate {
    pub path: String,
    pub display_name: Option<String>,
    pub pinned: bool,
    pub hidden: bool,
    pub project_group_id: Option<String>,
    pub project_group_position: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProfileUpdate {
    pub id: String,
    pub display_name: String,
    pub codex_home: Option<String>,
    pub authentication_home: Option<String>,
    pub environment: Value,
    pub availability: String,
    pub authenticated_identity: Option<Value>,
    pub models: Value,
    pub capabilities: Value,
    pub usage: Option<Value>,
    pub rate_limits: Option<Value>,
    pub diagnostic: Option<String>,
    pub expected_version: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProfile {
    pub id: String,
    pub display_name: String,
    pub codex_home: Option<String>,
    pub authentication_home: Option<String>,
    pub environment: Value,
    pub availability: String,
    pub authenticated_identity: Option<Value>,
    pub models: Value,
    pub capabilities: Value,
    pub usage: Option<Value>,
    pub rate_limits: Option<Value>,
    pub diagnostic: Option<String>,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCodexProfileBinding {
    pub task_id: String,
    pub codex_profile_id: Option<String>,
    pub stage_version: i64,
}

fn default_true() -> bool {
    true
}

fn default_object() -> Value {
    Value::Object(serde_json::Map::new())
}

fn default_mode() -> String {
    "default".to_owned()
}

fn default_approval_policy() -> String {
    "on-request".to_owned()
}

fn default_sandbox_mode() -> String {
    "workspace-write".to_owned()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaoProjectSummary {
    pub path: String,
    pub name: String,
    pub updated_at: i64,
    pub pinned: bool,
    pub hidden: bool,
    pub project_group_id: Option<String>,
    pub project_group_position: i64,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct XiaoLegacyStore {
    pub schema_version: u32,
    pub workspaces: Vec<XiaoWorkspaceDocument>,
}

#[cfg(test)]
mod tests {
    use super::TaskStage;

    #[test]
    fn task_stage_transitions_require_deliberate_outcome_changes() {
        let allowed = [
            (TaskStage::Draft, TaskStage::InProgress),
            (TaskStage::InProgress, TaskStage::ReadyForReview),
            (TaskStage::ReadyForReview, TaskStage::InProgress),
            (TaskStage::ReadyForReview, TaskStage::Published),
            (TaskStage::ReadyForReview, TaskStage::Completed),
            (TaskStage::Published, TaskStage::InProgress),
            (TaskStage::Published, TaskStage::Completed),
            (TaskStage::Completed, TaskStage::InProgress),
        ];
        for (from, to) in allowed {
            assert!(from.can_transition_to(to), "{from:?} -> {to:?}");
        }

        let rejected = [
            (TaskStage::Draft, TaskStage::ReadyForReview),
            (TaskStage::Draft, TaskStage::Published),
            (TaskStage::Draft, TaskStage::Completed),
            (TaskStage::InProgress, TaskStage::Published),
            (TaskStage::InProgress, TaskStage::Completed),
            (TaskStage::Completed, TaskStage::Published),
        ];
        for (from, to) in rejected {
            assert!(!from.can_transition_to(to), "{from:?} -> {to:?}");
        }
    }
}
