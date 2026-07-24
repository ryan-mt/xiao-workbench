use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::companion::models::{
    CommandEnvelope, CommandResult, ExchangePairingRequest, ExchangedSession, NotificationCursor,
    NotificationPage, ReconnectCursor, SessionCredential, SyncBatch, SyncRequest,
};

pub trait CompanionApi: Send + Sync + 'static {
    fn exchange_pairing(&self, request: ExchangePairingRequest)
        -> Result<ExchangedSession, String>;

    fn sync(
        &self,
        credential: &SessionCredential,
        request: SyncRequest,
    ) -> Result<SyncBatch, String>;

    fn confirm_reconciled(
        &self,
        credential: &SessionCredential,
        cursor: ReconnectCursor,
    ) -> Result<SyncBatch, String>;

    fn notifications(
        &self,
        credential: &SessionCredential,
        cursor: Option<NotificationCursor>,
        limit: Option<usize>,
    ) -> Result<NotificationPage, String>;

    fn execute(
        &self,
        credential: &SessionCredential,
        envelope: CommandEnvelope,
    ) -> Result<CommandResult, String>;
}

#[derive(Clone)]
struct RouterState {
    api: Arc<dyn CompanionApi>,
}

pub fn companion_router(api: Arc<dyn CompanionApi>) -> Router {
    Router::new()
        .route("/v1/pair", post(pair))
        .route("/v1/sync", post(sync))
        .route("/v1/reconcile", post(reconcile))
        .route("/v1/notifications", post(notifications))
        .route("/v1/commands", post(execute))
        .with_state(RouterState { api })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticatedSyncRequest {
    credential: SessionCredential,
    sync: SyncRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReconcileRequest {
    credential: SessionCredential,
    cursor: ReconnectCursor,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotificationRequest {
    credential: SessionCredential,
    cursor: Option<NotificationCursor>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteRequest {
    credential: SessionCredential,
    envelope: CommandEnvelope,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiError {
    code: &'static str,
    message: String,
}

type ApiResult<T> = Result<Json<T>, (StatusCode, Json<ApiError>)>;

async fn pair(
    State(state): State<RouterState>,
    Json(request): Json<ExchangePairingRequest>,
) -> ApiResult<ExchangedSession> {
    state
        .api
        .exchange_pairing(request)
        .map(Json)
        .map_err(api_error)
}

async fn sync(
    State(state): State<RouterState>,
    Json(request): Json<AuthenticatedSyncRequest>,
) -> ApiResult<SyncBatch> {
    state
        .api
        .sync(&request.credential, request.sync)
        .map(Json)
        .map_err(api_error)
}

async fn reconcile(
    State(state): State<RouterState>,
    Json(request): Json<ReconcileRequest>,
) -> ApiResult<SyncBatch> {
    state
        .api
        .confirm_reconciled(&request.credential, request.cursor)
        .map(Json)
        .map_err(api_error)
}

async fn notifications(
    State(state): State<RouterState>,
    Json(request): Json<NotificationRequest>,
) -> ApiResult<NotificationPage> {
    state
        .api
        .notifications(&request.credential, request.cursor, request.limit)
        .map(Json)
        .map_err(api_error)
}

async fn execute(
    State(state): State<RouterState>,
    Json(request): Json<ExecuteRequest>,
) -> ApiResult<CommandResult> {
    state
        .api
        .execute(&request.credential, request.envelope)
        .map(Json)
        .map_err(api_error)
}

fn api_error(message: String) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiError {
            code: "companion_request_refused",
            message,
        }),
    )
}
