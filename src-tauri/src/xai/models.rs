use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XaiDeviceAuthorization {
    pub flow_id: String,
    pub profile_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_at: i64,
    pub interval_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XaiOAuthStatus {
    pub profile_id: String,
    pub state: String,
    pub expires_at: Option<i64>,
    pub refreshable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XaiOAuthPollResult {
    pub state: String,
    pub retry_after_seconds: Option<u64>,
    pub status: Option<XaiOAuthStatus>,
}
