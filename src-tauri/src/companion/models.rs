use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompanionGrant {
    ReadProjects,
    ReadTasks,
    ReadRuns,
    ReadAttention,
    ReadSafeTimeline,
    ReadVerification,
    ReadObservatory,
    ResolvePendingInput,
    StopRun,
    RetryRun,
    SendFollowUp,
    AcknowledgeAttention,
    AcceptOutcome,
}

impl CompanionGrant {
    pub(crate) fn allows_projection(self, kind: ProjectionKind) -> bool {
        matches!(
            (self, kind),
            (Self::ReadProjects, ProjectionKind::Project)
                | (Self::ReadTasks, ProjectionKind::Task)
                | (Self::ReadTasks, ProjectionKind::TaskStage)
                | (Self::ReadRuns, ProjectionKind::Run)
                | (Self::ResolvePendingInput, ProjectionKind::PendingInput)
                | (Self::ReadAttention, ProjectionKind::Attention)
                | (Self::ReadSafeTimeline, ProjectionKind::SafeTimeline)
                | (Self::ReadVerification, ProjectionKind::Verification)
                | (Self::ReadObservatory, ProjectionKind::Observatory)
        )
    }

    pub(crate) fn allows_command(self, capability: CommandCapability) -> bool {
        matches!(
            (self, capability),
            (
                Self::ResolvePendingInput,
                CommandCapability::ResolveApproval
                    | CommandCapability::ResolveQuestion
                    | CommandCapability::ResolveMcpElicitation
            ) | (Self::StopRun, CommandCapability::StopRun)
                | (Self::RetryRun, CommandCapability::RetryRun)
                | (Self::SendFollowUp, CommandCapability::SendFollowUp)
                | (
                    Self::AcknowledgeAttention,
                    CommandCapability::AcknowledgeAttention
                )
                | (Self::AcceptOutcome, CommandCapability::AcceptOutcome)
        )
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionKind {
    Project,
    Task,
    TaskStage,
    Run,
    PendingInput,
    Attention,
    SafeTimeline,
    Verification,
    Observatory,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandCapability {
    ResolveApproval,
    ResolveQuestion,
    ResolveMcpElicitation,
    StopRun,
    RetryRun,
    SendFollowUp,
    AcknowledgeAttention,
    AcceptOutcome,
    OpenTerminal,
    BrowseFiles,
    ChangeHostSettings,
    ChangeUnrestrictedPolicy,
    ManageWorktrees,
    PublishSourceControl,
    ImportHandoff,
    RestoreCheckpoint,
    RegisterExecutionEnvironment,
    ExecuteArbitraryCommand,
}

impl CommandCapability {
    pub fn is_forbidden(self) -> bool {
        matches!(
            self,
            Self::OpenTerminal
                | Self::BrowseFiles
                | Self::ChangeHostSettings
                | Self::ChangeUnrestrictedPolicy
                | Self::ManageWorktrees
                | Self::PublishSourceControl
                | Self::ImportHandoff
                | Self::RestoreCheckpoint
                | Self::RegisterExecutionEnvironment
                | Self::ExecuteArbitraryCommand
        )
    }

    pub(crate) fn expected_target(self) -> Option<TargetKind> {
        match self {
            Self::ResolveApproval | Self::ResolveQuestion | Self::ResolveMcpElicitation => {
                Some(TargetKind::PendingInput)
            }
            Self::StopRun | Self::RetryRun | Self::SendFollowUp => Some(TargetKind::Run),
            Self::AcknowledgeAttention => Some(TargetKind::Attention),
            Self::AcceptOutcome => Some(TargetKind::Task),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    Project,
    Task,
    Run,
    Attention,
    PendingInput,
    Host,
    Terminal,
    Filesystem,
    Worktree,
    Publication,
    Handoff,
    Checkpoint,
    ExecutionEnvironment,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetScope {
    pub kind: TargetKind,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuePairingRequest {
    pub ttl_seconds: i64,
    pub now: i64,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCredential {
    pub pairing_id: String,
    pub owner_credential: String,
    pub expires_at: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangePairingRequest {
    pub owner_credential: String,
    pub device_id: String,
    pub device_name: String,
    pub grants: Vec<CompanionGrant>,
    pub now: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCredential {
    pub session_id: String,
    pub device_id: String,
    pub generation: i64,
    pub secret: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSession {
    pub session_id: String,
    pub device_id: String,
    pub device_name: String,
    pub grants: Vec<CompanionGrant>,
    pub generation: i64,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub rotated_at: Option<i64>,
    pub revoked_at: Option<i64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangedSession {
    pub credential: SessionCredential,
    pub session: CompanionSession,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendProjectionUpdate {
    pub event_id: String,
    pub generation: i64,
    pub kind: ProjectionKind,
    pub entity_id: String,
    pub entity_version: i64,
    pub occurred_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionUpdate {
    pub sequence: i64,
    pub event_id: String,
    pub generation: i64,
    pub kind: ProjectionKind,
    pub entity_id: String,
    pub entity_version: i64,
    pub payload: Value,
    pub occurred_at: i64,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncPhase {
    Stale,
    Reconciling,
    Live,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconnectCursor {
    pub generation: i64,
    pub sequence: i64,
    #[serde(default)]
    pub snapshot: Option<SnapshotPageCursor>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPageCursor {
    pub base_sequence: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBatch {
    pub phase: SyncPhase,
    pub generation: i64,
    pub from_sequence: i64,
    pub cursor: i64,
    pub latest_sequence: i64,
    pub is_snapshot: bool,
    pub has_more: bool,
    pub next_snapshot: Option<SnapshotPageCursor>,
    pub updates: Vec<ProjectionUpdate>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub cursor: Option<ReconnectCursor>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEnvelope {
    pub session_id: String,
    pub session_generation: i64,
    pub device_id: String,
    pub command_id: String,
    pub idempotency_key: String,
    pub expected_version: i64,
    pub target: TargetScope,
    pub audit_timestamp: i64,
    pub capability: CommandCapability,
    pub payload: Value,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCommandAck {
    pub acknowledgement_id: String,
    pub resulting_version: i64,
    pub acknowledged_at: i64,
    pub detail: Option<Value>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandState {
    PendingHostAcknowledgement,
    Succeeded,
    Refused,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub command_id: String,
    pub state: CommandState,
    pub acknowledgement: Option<HostCommandAck>,
    pub refusal_code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionAuditRecord {
    pub id: String,
    pub command_id: Option<String>,
    pub session_id: Option<String>,
    pub device_id: String,
    pub capability: CommandCapability,
    pub target: TargetScope,
    pub decision: String,
    pub reason: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationCursor {
    pub created_at: i64,
    pub attention_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionNotification {
    pub attention_id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub deep_link: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPage {
    pub notifications: Vec<CompanionNotification>,
    pub next_cursor: Option<NotificationCursor>,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokedDevice {
    pub device_id: String,
    pub revoked_sessions: Vec<CompanionSession>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionAuthorization {
    pub current_version: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostCommandRefusal {
    pub code: String,
    pub message: String,
    pub definitive: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionOutboxIntent {
    pub command_id: String,
    pub envelope: CommandEnvelope,
    pub status: String,
    pub attempt_count: i64,
    pub created_at: i64,
}
