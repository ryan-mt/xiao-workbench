use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderValue, Response, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::companion::models::{
    CommandEnvelope, CommandResult, ExchangePairingRequest, ExchangedSession, NotificationCursor,
    NotificationPage, ReconnectCursor, SessionCredential, SyncBatch, SyncRequest,
};
use crate::runs::models::RunEventPage;

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

    fn conversation(
        &self,
        credential: &SessionCredential,
        run_id: &str,
        after_sequence: Option<i64>,
        limit: Option<usize>,
    ) -> Result<RunEventPage, String>;
}

#[derive(Clone)]
struct RouterState {
    api: Arc<dyn CompanionApi>,
}

pub fn companion_router(api: Arc<dyn CompanionApi>) -> Router {
    Router::new()
        .route("/", get(companion_index))
        .route("/index.html", get(companion_index))
        .route("/companion.css", get(companion_css))
        .route("/companion.js", get(companion_javascript))
        .route("/xiao-mark.png", get(companion_mark))
        .route("/v1/pair", post(pair))
        .route("/v1/sync", post(sync))
        .route("/v1/reconcile", post(reconcile))
        .route("/v1/notifications", post(notifications))
        .route("/v1/commands", post(execute))
        .route("/v1/conversation", post(conversation))
        .with_state(RouterState { api })
}

const COMPANION_INDEX: &str = include_str!("web/index.html");
const COMPANION_CSS: &str = include_str!("web/companion.css");
const COMPANION_JAVASCRIPT: &str = include_str!("web/companion.js");
const COMPANION_MARK: &[u8] = include_bytes!("../../../../public/xiao-mark.png");
const COMPANION_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; \
    connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; \
    frame-ancestors 'none'";

async fn companion_index() -> Response<Body> {
    web_response("text/html; charset=utf-8", COMPANION_INDEX, true)
}

async fn companion_css() -> Response<Body> {
    web_response("text/css; charset=utf-8", COMPANION_CSS, false)
}

async fn companion_javascript() -> Response<Body> {
    web_response(
        "text/javascript; charset=utf-8",
        COMPANION_JAVASCRIPT,
        false,
    )
}

async fn companion_mark() -> Response<Body> {
    let mut response = Response::new(Body::from(COMPANION_MARK));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn web_response(content_type: &'static str, body: &'static str, html: bool) -> Response<Body> {
    let mut response = Response::new(Body::from(body));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if html {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(COMPANION_CSP),
        );
    }
    response
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationRequest {
    credential: SessionCredential,
    run_id: String,
    after_sequence: Option<i64>,
    limit: Option<usize>,
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

async fn conversation(
    State(state): State<RouterState>,
    Json(request): Json<ConversationRequest>,
) -> ApiResult<RunEventPage> {
    state
        .api
        .conversation(
            &request.credential,
            &request.run_id,
            request.after_sequence,
            request.limit,
        )
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use super::{companion_router, CompanionApi};
    use crate::companion::models::{
        CommandEnvelope, CommandResult, ExchangePairingRequest, ExchangedSession,
        NotificationCursor, NotificationPage, ReconnectCursor, SessionCredential, SyncBatch,
        SyncRequest,
    };
    use crate::runs::models::RunEventPage;

    struct RefusingApi;

    impl CompanionApi for RefusingApi {
        fn exchange_pairing(
            &self,
            _request: ExchangePairingRequest,
        ) -> Result<ExchangedSession, String> {
            Err("not used".to_owned())
        }

        fn sync(
            &self,
            _credential: &SessionCredential,
            _request: SyncRequest,
        ) -> Result<SyncBatch, String> {
            Err("not used".to_owned())
        }

        fn confirm_reconciled(
            &self,
            _credential: &SessionCredential,
            _cursor: ReconnectCursor,
        ) -> Result<SyncBatch, String> {
            Err("not used".to_owned())
        }

        fn notifications(
            &self,
            _credential: &SessionCredential,
            _cursor: Option<NotificationCursor>,
            _limit: Option<usize>,
        ) -> Result<NotificationPage, String> {
            Err("not used".to_owned())
        }

        fn execute(
            &self,
            _credential: &SessionCredential,
            _envelope: CommandEnvelope,
        ) -> Result<CommandResult, String> {
            Err("not used".to_owned())
        }

        fn conversation(
            &self,
            _credential: &SessionCredential,
            _run_id: &str,
            _after_sequence: Option<i64>,
            _limit: Option<usize>,
        ) -> Result<RunEventPage, String> {
            Err("not used".to_owned())
        }
    }

    #[tokio::test]
    async fn root_serves_the_mobile_companion_without_reflecting_pairing_fragments() {
        let response = companion_router(Arc::new(RefusingApi))
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["content-type"],
            "text/html; charset=utf-8"
        );
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains("Xiao Companion"));
        assert!(html.contains("aria-label=\"Message Xiao\""));
        assert!(html.contains("id=\"verification-list\""));
        assert!(html.contains("id=\"observatory-list\""));
        assert!(html.contains("/xiao-mark.png"));
        assert!(!html.contains("must-not-reach-the-server"));
    }
}
