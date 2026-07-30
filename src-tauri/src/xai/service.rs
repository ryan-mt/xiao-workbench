use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::xiao::models::{CodexProfile, CodexProfileUpdate};
use crate::xiao::repository::XiaoRepository;

use super::models::{XaiDeviceAuthorization, XaiOAuthPollResult, XaiOAuthStatus};

pub const PROVIDER_MARKER_KEY: &str = "XIAO_MODEL_PROVIDER";

const PROVIDER_ID: &str = "xai";
const KEYRING_SERVICE: &str = "xiao-xai-oauth";
const OIDC_DISCOVERY_URL: &str = "https://auth.x.ai/.well-known/openid-configuration";
const XAI_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const OAUTH_SCOPES: &str = "openid profile email offline_access grok-cli:access api:access";
const OAUTH_REFERRER: &str = "pi";
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const MODEL_ID: &str = "grok-4.5";
const REFRESH_SKEW_MILLIS: i64 = 5 * 60 * 1_000;
const DEFAULT_TOKEN_LIFETIME_SECONDS: u64 = 3_600;
const AUTH_HELPER_FLAG: &str = "--xiao-xai-auth";

pub trait XaiCredentialStore: Send + Sync + 'static {
    fn save(&self, profile_id: &str, value: &str) -> Result<(), String>;
    fn load(&self, profile_id: &str) -> Result<Option<String>, String>;
    fn delete(&self, profile_id: &str) -> Result<(), String>;
}

#[derive(Default)]
pub struct KeyringXaiCredentialStore;

impl XaiCredentialStore for KeyringXaiCredentialStore {
    fn save(&self, profile_id: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(KEYRING_SERVICE, profile_id)
            .map_err(|error| format!("Could not open the xAI credential store: {error}"))?
            .set_password(value)
            .map_err(|error| format!("Could not save the xAI credential: {error}"))
    }

    fn load(&self, profile_id: &str) -> Result<Option<String>, String> {
        match keyring::Entry::new(KEYRING_SERVICE, profile_id)
            .map_err(|error| format!("Could not open the xAI credential store: {error}"))?
            .get_password()
        {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("Could not load the xAI credential: {error}")),
        }
    }

    fn delete(&self, profile_id: &str) -> Result<(), String> {
        match keyring::Entry::new(KEYRING_SERVICE, profile_id)
            .map_err(|error| format!("Could not open the xAI credential store: {error}"))?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("Could not remove the xAI credential: {error}")),
        }
    }
}

pub struct XaiOAuthService {
    client: Client,
    credentials: Arc<dyn XaiCredentialStore>,
    discovery: Mutex<Option<OAuthDiscovery>>,
    pending: Mutex<HashMap<String, PendingDeviceFlow>>,
}

impl XaiOAuthService {
    pub fn new() -> Result<Self, String> {
        let client = Client::builder()
            .https_only(true)
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|error| format!("Could not initialize xAI OAuth: {error}"))?;
        Ok(Self {
            client,
            credentials: Arc::new(KeyringXaiCredentialStore),
            discovery: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
        })
    }

    #[cfg(test)]
    fn with_credentials(credentials: Arc<dyn XaiCredentialStore>) -> Self {
        Self {
            client: Client::builder().https_only(true).build().unwrap(),
            credentials,
            discovery: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn begin(&self, profile: &CodexProfile) -> Result<XaiDeviceAuthorization, String> {
        require_xai_profile(profile)?;
        let discovery = self.discovery()?;
        let response = self
            .client
            .post(&discovery.device_authorization_endpoint)
            .form(&[
                ("client_id", XAI_CLIENT_ID),
                ("scope", OAUTH_SCOPES),
                ("referrer", OAUTH_REFERRER),
            ])
            .send()
            .map_err(|error| format!("Could not start xAI device sign-in: {error}"))?;
        if !response.status().is_success() {
            return Err(oauth_response_error(
                response,
                "xAI refused the device sign-in request",
            ));
        }
        let authorization = response
            .json::<DeviceAuthorizationResponse>()
            .map_err(|error| format!("xAI returned an invalid device sign-in response: {error}"))?;
        validate_device_authorization(&authorization)?;

        let now = now_millis()?;
        let interval_seconds = authorization
            .interval
            .filter(|interval| *interval > 0)
            .unwrap_or(5)
            .min(60);
        let expires_at = now.saturating_add(
            i64::try_from(authorization.expires_in)
                .unwrap_or(i64::MAX)
                .saturating_mul(1_000),
        );
        let flow_id = Uuid::now_v7().to_string();
        let pending = PendingDeviceFlow {
            profile_id: profile.id.clone(),
            device_code: authorization.device_code,
            expires_at,
            interval_seconds,
            next_poll_at: now.saturating_add(
                i64::try_from(interval_seconds)
                    .unwrap_or(60)
                    .saturating_mul(1_000),
            ),
        };
        self.pending
            .lock()
            .map_err(|error| error.to_string())?
            .insert(flow_id.clone(), pending);

        Ok(XaiDeviceAuthorization {
            flow_id,
            profile_id: profile.id.clone(),
            user_code: authorization.user_code,
            verification_uri: authorization.verification_uri,
            verification_uri_complete: authorization.verification_uri_complete,
            expires_at,
            interval_seconds,
        })
    }

    pub fn poll(&self, flow_id: &str) -> Result<XaiOAuthPollResult, String> {
        let now = now_millis()?;
        let pending = {
            let mut flows = self.pending.lock().map_err(|error| error.to_string())?;
            let flow = flows
                .get(flow_id)
                .cloned()
                .ok_or("The xAI device sign-in is no longer active.")?;
            if now >= flow.expires_at {
                flows.remove(flow_id);
                return Ok(poll_result("expired", None, None));
            }
            if now < flow.next_poll_at {
                let wait = u64::try_from((flow.next_poll_at - now + 999) / 1_000).unwrap_or(1);
                return Ok(poll_result("pending", Some(wait.max(1)), None));
            }
            if let Some(flow) = flows.get_mut(flow_id) {
                flow.next_poll_at = now.saturating_add(
                    i64::try_from(flow.interval_seconds)
                        .unwrap_or(60)
                        .saturating_mul(1_000),
                );
            }
            flow
        };

        let discovery = self.discovery()?;
        match self.exchange_token(
            &discovery.token_endpoint,
            &[
                ("client_id", XAI_CLIENT_ID),
                ("device_code", pending.device_code.as_str()),
                ("grant_type", DEVICE_GRANT_TYPE),
            ],
        )? {
            TokenExchange::Granted(token) => {
                let credential = StoredXaiCredential::from_token(token, None, now)?;
                self.save_credential(&pending.profile_id, &credential)?;
                self.pending
                    .lock()
                    .map_err(|error| error.to_string())?
                    .remove(flow_id);
                let status = credential_status(&pending.profile_id, &credential, now);
                Ok(poll_result("authorized", None, Some(status)))
            }
            TokenExchange::Pending => {
                Ok(poll_result("pending", Some(pending.interval_seconds), None))
            }
            TokenExchange::SlowDown(server_interval) => {
                let next_interval = server_interval
                    .filter(|interval| *interval > 0)
                    .unwrap_or_else(|| pending.interval_seconds.saturating_add(5))
                    .min(60);
                if let Some(flow) = self
                    .pending
                    .lock()
                    .map_err(|error| error.to_string())?
                    .get_mut(flow_id)
                {
                    flow.interval_seconds = next_interval;
                    flow.next_poll_at = now.saturating_add(
                        i64::try_from(next_interval)
                            .unwrap_or(60)
                            .saturating_mul(1_000),
                    );
                }
                Ok(poll_result("pending", Some(next_interval), None))
            }
            TokenExchange::Denied => {
                self.cancel(flow_id)?;
                Ok(poll_result("denied", None, None))
            }
            TokenExchange::Expired => {
                self.cancel(flow_id)?;
                Ok(poll_result("expired", None, None))
            }
        }
    }

    pub fn cancel(&self, flow_id: &str) -> Result<(), String> {
        self.pending
            .lock()
            .map_err(|error| error.to_string())?
            .remove(flow_id);
        Ok(())
    }

    #[cfg(test)]
    pub fn status(&self, profile_id: &str) -> Result<XaiOAuthStatus, String> {
        let now = now_millis()?;
        match self.load_credential(profile_id)? {
            Some(credential) => Ok(credential_status(profile_id, &credential, now)),
            None => Ok(unauthenticated_status(profile_id)),
        }
    }

    pub fn access_token(&self, profile_id: &str) -> Result<String, String> {
        let now = now_millis()?;
        let credential = self
            .load_credential(profile_id)?
            .ok_or("Connect this Grok profile to xAI before starting its runtime.")?;
        if credential
            .expires_at
            .is_none_or(|expires_at| expires_at > now.saturating_add(REFRESH_SKEW_MILLIS))
        {
            return Ok(credential.access_token);
        }
        self.refresh(profile_id, credential, now)
    }

    pub fn revoke(&self, profile_id: &str) -> Result<XaiOAuthStatus, String> {
        let Some(credential) = self.load_credential(profile_id)? else {
            return Ok(unauthenticated_status(profile_id));
        };
        let discovery = self.discovery()?;
        let (token, hint) = credential
            .refresh_token
            .as_deref()
            .map(|token| (token, "refresh_token"))
            .unwrap_or((&credential.access_token, "access_token"));
        let response = self
            .client
            .post(&discovery.revocation_endpoint)
            .form(&[
                ("client_id", XAI_CLIENT_ID),
                ("token", token),
                ("token_type_hint", hint),
            ])
            .send()
            .map_err(|error| format!("Could not revoke the xAI sign-in: {error}"))?;
        if !response.status().is_success() {
            return Err(oauth_response_error(
                response,
                "xAI refused the token revocation request",
            ));
        }
        self.credentials.delete(profile_id)?;
        Ok(unauthenticated_status(profile_id))
    }

    pub fn forget(&self, profile_id: &str) -> Result<(), String> {
        self.credentials.delete(profile_id)
    }

    fn refresh(
        &self,
        profile_id: &str,
        credential: StoredXaiCredential,
        now: i64,
    ) -> Result<String, String> {
        let refresh_token = credential.refresh_token.as_deref().ok_or(
            "The xAI access token expired and no refresh token is available. Connect the Grok profile again.",
        )?;
        let discovery = self.discovery()?;
        let token = match self.exchange_token(
            &discovery.token_endpoint,
            &[
                ("client_id", XAI_CLIENT_ID),
                ("refresh_token", refresh_token),
                ("grant_type", "refresh_token"),
            ],
        )? {
            TokenExchange::Granted(token) => token,
            TokenExchange::Denied | TokenExchange::Expired => {
                return Err(
                    "xAI rejected the saved refresh token. Connect the Grok profile again."
                        .to_owned(),
                )
            }
            TokenExchange::Pending | TokenExchange::SlowDown(_) => {
                return Err("xAI returned an invalid refresh response.".to_owned())
            }
        };
        let refreshed = StoredXaiCredential::from_token(token, credential.refresh_token, now)?;
        let access_token = refreshed.access_token.clone();
        self.save_credential(profile_id, &refreshed)?;
        Ok(access_token)
    }

    fn exchange_token(
        &self,
        endpoint: &str,
        form: &[(&str, &str)],
    ) -> Result<TokenExchange, String> {
        let response = self
            .client
            .post(endpoint)
            .form(form)
            .send()
            .map_err(|error| format!("Could not reach xAI OAuth: {error}"))?;
        if response.status().is_success() {
            let token = response
                .json::<TokenResponse>()
                .map_err(|error| format!("xAI returned an invalid token response: {error}"))?;
            if token.access_token.trim().is_empty() {
                return Err("xAI returned an empty access token.".to_owned());
            }
            return Ok(TokenExchange::Granted(token));
        }
        let error = response
            .json::<OAuthErrorResponse>()
            .map_err(|_| "xAI OAuth returned an unreadable error response.".to_owned())?;
        match error.error.as_str() {
            "authorization_pending" => Ok(TokenExchange::Pending),
            "slow_down" => Ok(TokenExchange::SlowDown(error.interval)),
            "access_denied" | "invalid_grant" => Ok(TokenExchange::Denied),
            "expired_token" => Ok(TokenExchange::Expired),
            _ => Err(format_oauth_error(
                "xAI OAuth rejected the token request",
                &error,
            )),
        }
    }

    fn discovery(&self) -> Result<OAuthDiscovery, String> {
        if let Some(discovery) = self
            .discovery
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
        {
            return Ok(discovery);
        }
        let discovery = self
            .client
            .get(OIDC_DISCOVERY_URL)
            .send()
            .map_err(|error| format!("Could not read xAI OAuth discovery: {error}"))?
            .error_for_status()
            .map_err(|error| format!("xAI OAuth discovery failed: {error}"))?
            .json::<OAuthDiscovery>()
            .map_err(|error| format!("xAI OAuth discovery is invalid: {error}"))?;
        validate_discovery(&discovery)?;
        *self.discovery.lock().map_err(|error| error.to_string())? = Some(discovery.clone());
        Ok(discovery)
    }

    fn load_credential(&self, profile_id: &str) -> Result<Option<StoredXaiCredential>, String> {
        self.credentials
            .load(profile_id)?
            .map(|value| {
                serde_json::from_str(&value)
                    .map_err(|error| format!("The saved xAI credential is invalid: {error}"))
            })
            .transpose()
    }

    fn save_credential(
        &self,
        profile_id: &str,
        credential: &StoredXaiCredential,
    ) -> Result<(), String> {
        let encoded = serde_json::to_string(credential)
            .map_err(|error| format!("Could not encode the xAI credential: {error}"))?;
        self.credentials.save(profile_id, &encoded)
    }
}

pub fn is_xai_profile(profile: &CodexProfile) -> bool {
    profile
        .environment
        .get(PROVIDER_MARKER_KEY)
        .and_then(Value::as_str)
        == Some(PROVIDER_ID)
}

pub fn refresh_model_catalog(profile: &CodexProfile) -> Result<(), String> {
    require_xai_profile(profile)?;
    let codex_home = profile
        .codex_home
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .ok_or("The Grok profile has no managed Codex home.")?;
    std::fs::write(
        Path::new(codex_home).join("models.json"),
        serde_json::to_vec_pretty(&build_model_catalog())
            .map_err(|error| format!("Could not encode the Grok model catalog: {error}"))?,
    )
    .map_err(|error| format!("Could not refresh the Grok model catalog: {error}"))
}

pub fn create_codex_profile(repository: &XiaoRepository) -> Result<CodexProfile, String> {
    let profile_id = format!("grok-{}", Uuid::now_v7());
    let codex_home = repository
        .app_data_dir()
        .join("model-profiles")
        .join(&profile_id);
    std::fs::create_dir_all(&codex_home)
        .map_err(|error| format!("Could not create the Grok profile directory: {error}"))?;
    let catalog_path = codex_home.join("models.json");
    let catalog = build_model_catalog();
    std::fs::write(
        &catalog_path,
        serde_json::to_vec_pretty(&catalog)
            .map_err(|error| format!("Could not encode the Grok model catalog: {error}"))?,
    )
    .map_err(|error| format!("Could not write the Grok model catalog: {error}"))?;
    std::fs::write(
        codex_home.join("config.toml"),
        build_codex_config(
            &catalog_path,
            &profile_id,
            &std::env::current_exe()
                .map_err(|error| format!("Could not locate the Xiao executable: {error}"))?,
        )?,
    )
    .map_err(|error| format!("Could not write the Grok Codex profile: {error}"))?;

    repository.save_codex_profile(CodexProfileUpdate {
        id: profile_id,
        display_name: "Grok 4.5 (xAI)".to_owned(),
        codex_home: Some(codex_home.to_string_lossy().into_owned()),
        authentication_home: None,
        environment: json!({
            (PROVIDER_MARKER_KEY): PROVIDER_ID,
        }),
        availability: "unauthenticated".to_owned(),
        authenticated_identity: None,
        models: json!([model_summary()]),
        capabilities: json!({
            "providerId": PROVIDER_ID,
            "reasoningLevels": ["low", "medium", "high"],
            "serviceTiers": [],
        }),
        usage: None,
        rate_limits: None,
        diagnostic: Some("Connect this profile to xAI with device sign-in.".to_owned()),
        expected_version: None,
    })
}

pub fn run_auth_helper_if_requested() -> Option<i32> {
    let mut arguments = std::env::args();
    let _executable = arguments.next();
    if arguments.next().as_deref() != Some(AUTH_HELPER_FLAG) {
        return None;
    }
    let result = (|| {
        let profile_id = arguments
            .next()
            .filter(|profile_id| !profile_id.trim().is_empty())
            .ok_or("The xAI auth helper requires a profile id.")?;
        if arguments.next().is_some() {
            return Err("The xAI auth helper received unexpected arguments.".to_owned());
        }
        rustls::crypto::aws_lc_rs::default_provider()
            .install_default()
            .map_err(|_| "Could not initialize TLS for the xAI auth helper.".to_owned())?;
        let token = XaiOAuthService::new()?.access_token(&profile_id)?;
        print!("{token}");
        Ok(())
    })();
    Some(match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Xiao xAI authentication failed: {error}");
            1
        }
    })
}

pub fn mark_profile_authenticated(
    repository: &XiaoRepository,
    profile_id: &str,
) -> Result<CodexProfile, String> {
    let profile = repository.codex_profile(profile_id)?;
    require_xai_profile(&profile)?;
    repository.save_codex_profile(profile_update(
        profile,
        "available",
        Some(json!({ "provider": PROVIDER_ID })),
        None,
    ))
}

pub fn mark_profile_unauthenticated(
    repository: &XiaoRepository,
    profile_id: &str,
) -> Result<CodexProfile, String> {
    let profile = repository.codex_profile(profile_id)?;
    require_xai_profile(&profile)?;
    repository.save_codex_profile(profile_update(
        profile,
        "unauthenticated",
        None,
        Some("Connect this profile to xAI with device sign-in.".to_owned()),
    ))
}

fn profile_update(
    profile: CodexProfile,
    availability: &str,
    authenticated_identity: Option<Value>,
    diagnostic: Option<String>,
) -> CodexProfileUpdate {
    CodexProfileUpdate {
        id: profile.id,
        display_name: profile.display_name,
        codex_home: profile.codex_home,
        authentication_home: profile.authentication_home,
        environment: profile.environment,
        availability: availability.to_owned(),
        authenticated_identity,
        models: profile.models,
        capabilities: profile.capabilities,
        usage: profile.usage,
        rate_limits: profile.rate_limits,
        diagnostic,
        expected_version: Some(profile.version),
    }
}

fn require_xai_profile(profile: &CodexProfile) -> Result<(), String> {
    if is_xai_profile(profile) {
        Ok(())
    } else {
        Err("The selected Codex profile is not an xAI profile.".to_owned())
    }
}

fn build_codex_config(
    catalog_path: &Path,
    profile_id: &str,
    executable: &Path,
) -> Result<String, String> {
    let catalog_path = serde_json::to_string(&catalog_path.to_string_lossy())
        .map_err(|error| format!("Could not encode the Grok catalog path: {error}"))?;
    let executable = serde_json::to_string(&executable.to_string_lossy())
        .map_err(|error| format!("Could not encode the Xiao executable path: {error}"))?;
    let profile_id = serde_json::to_string(profile_id)
        .map_err(|error| format!("Could not encode the Grok profile id: {error}"))?;
    Ok(format!(
        r#"model = "{MODEL_ID}"
model_provider = "xai"
model_reasoning_effort = "high"
model_reasoning_summary = "auto"
model_catalog_json = {catalog_path}

[model_providers.xai]
name = "xAI"
base_url = "https://api.x.ai/v1"
wire_api = "responses"

[model_providers.xai.auth]
command = {executable}
args = ["{AUTH_HELPER_FLAG}", {profile_id}]
refresh_interval_ms = 300000
timeout_ms = 20000
"#
    ))
}

fn build_model_catalog() -> Value {
    json!({
        "models": [{
            "slug": MODEL_ID,
            "display_name": "Grok 4.5",
            "description": "xAI reasoning model for coding and agentic tasks.",
            "default_reasoning_level": "high",
            "supported_reasoning_levels": [
                { "effort": "low", "description": "Faster reasoning for simple tasks and tool calls." },
                { "effort": "medium", "description": "Balanced reasoning for analysis and longer tasks." },
                { "effort": "high", "description": "Deep reasoning for difficult, multi-step work." }
            ],
            "shell_type": "shell_command",
            "visibility": "list",
            "supported_in_api": true,
            "priority": 1,
            "availability_nux": null,
            "upgrade": null,
            "base_instructions": "You are a careful coding agent working in Xiao. Follow the system and developer instructions and complete the user's task. Use only tools provided in the current request. Client-side tools use JSON function arguments. Use shell_command for command execution and file edits; never emit or request custom or freeform tool calls.",
            "supports_reasoning_summary_parameter": true,
            "default_reasoning_summary": "auto",
            "support_verbosity": false,
            "default_verbosity": null,
            "apply_patch_tool_type": null,
            "truncation_policy": { "mode": "tokens", "limit": 10000 },
            "supports_parallel_tool_calls": true,
            "context_window": 500000,
            "max_context_window": 500000,
            "effective_context_window_percent": 95,
            "experimental_supported_tools": [],
            "input_modalities": ["text"],
            "supports_search_tool": false,
            "use_responses_lite": false,
            "tool_mode": "direct"
        }]
    })
}

fn model_summary() -> Value {
    json!({
        "id": MODEL_ID,
        "model": MODEL_ID,
        "displayName": "Grok 4.5",
        "description": "xAI reasoning model for coding and agentic tasks.",
        "isDefault": true,
        "defaultReasoningEffort": "high",
        "supportedReasoningEfforts": [
            { "reasoningEffort": "low", "description": "Faster reasoning for simple tasks and tool calls." },
            { "reasoningEffort": "medium", "description": "Balanced reasoning for analysis and longer tasks." },
            { "reasoningEffort": "high", "description": "Deep reasoning for difficult, multi-step work." }
        ],
        "serviceTiers": [],
        "contextWindow": 500000
    })
}

fn validate_discovery(discovery: &OAuthDiscovery) -> Result<(), String> {
    if discovery.issuer != "https://auth.x.ai" {
        return Err("xAI OAuth discovery returned an unexpected issuer.".to_owned());
    }
    for endpoint in [
        &discovery.device_authorization_endpoint,
        &discovery.token_endpoint,
        &discovery.revocation_endpoint,
    ] {
        let url = reqwest::Url::parse(endpoint)
            .map_err(|_| "xAI OAuth discovery returned an invalid endpoint.".to_owned())?;
        if url.scheme() != "https" || url.host_str() != Some("auth.x.ai") {
            return Err("xAI OAuth discovery returned an untrusted endpoint.".to_owned());
        }
    }
    Ok(())
}

fn validate_device_authorization(response: &DeviceAuthorizationResponse) -> Result<(), String> {
    if response.device_code.trim().is_empty()
        || response.user_code.trim().is_empty()
        || response.expires_in == 0
    {
        return Err("xAI returned an incomplete device sign-in response.".to_owned());
    }
    for candidate in
        std::iter::once(&response.verification_uri).chain(response.verification_uri_complete.iter())
    {
        let url = reqwest::Url::parse(candidate)
            .map_err(|_| "xAI returned an invalid verification URL.".to_owned())?;
        let host = url.host_str().unwrap_or_default();
        if url.scheme() != "https" || !(host == "x.ai" || host.ends_with(".x.ai")) {
            return Err("xAI returned an untrusted verification URL.".to_owned());
        }
    }
    Ok(())
}

fn credential_status(
    profile_id: &str,
    credential: &StoredXaiCredential,
    now: i64,
) -> XaiOAuthStatus {
    let expired_without_refresh = credential
        .expires_at
        .is_some_and(|expires_at| expires_at <= now)
        && credential.refresh_token.is_none();
    XaiOAuthStatus {
        profile_id: profile_id.to_owned(),
        state: if expired_without_refresh {
            "expired"
        } else {
            "authenticated"
        }
        .to_owned(),
        expires_at: credential.expires_at,
        refreshable: credential.refresh_token.is_some(),
    }
}

fn unauthenticated_status(profile_id: &str) -> XaiOAuthStatus {
    XaiOAuthStatus {
        profile_id: profile_id.to_owned(),
        state: "unauthenticated".to_owned(),
        expires_at: None,
        refreshable: false,
    }
}

fn poll_result(
    state: &str,
    retry_after_seconds: Option<u64>,
    status: Option<XaiOAuthStatus>,
) -> XaiOAuthPollResult {
    XaiOAuthPollResult {
        state: state.to_owned(),
        retry_after_seconds,
        status,
    }
}

fn oauth_response_error(response: reqwest::blocking::Response, prefix: &str) -> String {
    response
        .json::<OAuthErrorResponse>()
        .map(|error| format_oauth_error(prefix, &error))
        .unwrap_or_else(|_| prefix.to_owned())
}

fn format_oauth_error(prefix: &str, error: &OAuthErrorResponse) -> String {
    let description = error
        .error_description
        .as_deref()
        .map(str::trim)
        .filter(|description| !description.is_empty());
    match description {
        Some(description) => format!("{prefix}: {description}"),
        None => format!("{prefix}: {}", error.error),
    }
}

fn now_millis() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(millis)
        .map_err(|_| "The system clock is outside Xiao's supported range.".to_owned())
}

#[derive(Clone, Deserialize)]
struct OAuthDiscovery {
    issuer: String,
    device_authorization_endpoint: String,
    token_endpoint: String,
    revocation_endpoint: String,
}

#[derive(Deserialize)]
struct DeviceAuthorizationResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: Option<String>,
    expires_in: u64,
    #[serde(default)]
    interval: Option<u64>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Deserialize)]
struct OAuthErrorResponse {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
    #[serde(default)]
    interval: Option<u64>,
}

enum TokenExchange {
    Granted(TokenResponse),
    Pending,
    SlowDown(Option<u64>),
    Denied,
    Expired,
}

#[derive(Clone)]
struct PendingDeviceFlow {
    profile_id: String,
    device_code: String,
    expires_at: i64,
    interval_seconds: u64,
    next_poll_at: i64,
}

#[derive(Deserialize, Serialize)]
struct StoredXaiCredential {
    access_token: String,
    refresh_token: Option<String>,
    token_type: String,
    scope: Option<String>,
    expires_at: Option<i64>,
}

impl StoredXaiCredential {
    fn from_token(
        token: TokenResponse,
        previous_refresh_token: Option<String>,
        now: i64,
    ) -> Result<Self, String> {
        if token.access_token.trim().is_empty() {
            return Err("xAI returned an empty access token.".to_owned());
        }
        let expires_in = token.expires_in.unwrap_or(DEFAULT_TOKEN_LIFETIME_SECONDS);
        let expires_at = Some(
            now.saturating_add(
                i64::try_from(expires_in)
                    .unwrap_or(i64::MAX)
                    .saturating_mul(1_000),
            ),
        );
        Ok(Self {
            access_token: token.access_token,
            refresh_token: token.refresh_token.or(previous_refresh_token),
            token_type: token.token_type.unwrap_or_else(|| "Bearer".to_owned()),
            scope: token.scope,
            expires_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    use super::{
        build_codex_config, build_model_catalog, create_codex_profile, credential_status,
        refresh_model_catalog, validate_discovery, OAuthDiscovery, StoredXaiCredential,
        TokenResponse, XaiCredentialStore, XaiOAuthService, DEFAULT_TOKEN_LIFETIME_SECONDS,
        OAUTH_REFERRER, OAUTH_SCOPES, XAI_CLIENT_ID,
    };
    use crate::xiao::repository::XiaoRepository;

    #[derive(Default)]
    struct MemoryCredentialStore {
        values: Mutex<HashMap<String, String>>,
    }

    impl XaiCredentialStore for MemoryCredentialStore {
        fn save(&self, profile_id: &str, value: &str) -> Result<(), String> {
            self.values
                .lock()
                .unwrap()
                .insert(profile_id.to_owned(), value.to_owned());
            Ok(())
        }

        fn load(&self, profile_id: &str) -> Result<Option<String>, String> {
            Ok(self.values.lock().unwrap().get(profile_id).cloned())
        }

        fn delete(&self, profile_id: &str) -> Result<(), String> {
            self.values.lock().unwrap().remove(profile_id);
            Ok(())
        }
    }

    fn discovery(token_endpoint: &str) -> OAuthDiscovery {
        OAuthDiscovery {
            issuer: "https://auth.x.ai".to_owned(),
            device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code".to_owned(),
            token_endpoint: token_endpoint.to_owned(),
            revocation_endpoint: "https://auth.x.ai/oauth2/revoke".to_owned(),
        }
    }

    #[test]
    fn discovery_is_pinned_to_the_xai_https_origin() {
        validate_discovery(&discovery("https://auth.x.ai/oauth2/token")).unwrap();
        assert!(validate_discovery(&discovery("https://example.com/token")).is_err());
        assert!(validate_discovery(&discovery("http://auth.x.ai/oauth2/token")).is_err());
    }

    #[test]
    fn grok_catalog_advertises_responses_and_all_supported_thinking_levels() {
        let catalog = build_model_catalog();
        let model = &catalog["models"][0];
        assert_eq!(model["slug"], "grok-4.5");
        assert_eq!(model["default_reasoning_level"], "high");
        assert!(model["apply_patch_tool_type"].is_null());
        assert!(model["base_instructions"]
            .as_str()
            .unwrap()
            .contains("shell_command"));
        assert_eq!(
            model["supported_reasoning_levels"]
                .as_array()
                .unwrap()
                .iter()
                .map(|effort| effort["effort"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["low", "medium", "high"]
        );
        let config = build_codex_config(
            Path::new(r"C:\Xiao Grok\models.json"),
            "grok-profile",
            Path::new(r"C:\Program Files\Xiao\xiao.exe"),
        )
        .unwrap();
        assert!(config.contains("wire_api = \"responses\""));
        assert!(config.contains("[model_providers.xai.auth]"));
        assert!(config.contains("--xiao-xai-auth"));
        assert!(!config.contains("env_key"));
        assert!(!config.contains("access_token"));
        assert!(!config.contains("refresh_token"));
    }

    #[test]
    fn expired_access_remains_authenticated_only_when_refreshable() {
        let mut credential = StoredXaiCredential {
            access_token: "access".to_owned(),
            refresh_token: None,
            token_type: "Bearer".to_owned(),
            scope: None,
            expires_at: Some(99),
        };
        assert_eq!(credential_status("grok", &credential, 100).state, "expired");
        credential.refresh_token = Some("refresh".to_owned());
        assert_eq!(
            credential_status("grok", &credential, 100).state,
            "authenticated"
        );
    }

    #[test]
    fn forgetting_a_missing_credential_is_idempotent() {
        let service = XaiOAuthService::with_credentials(Arc::new(MemoryCredentialStore::default()));
        service.forget("missing").unwrap();
        assert_eq!(service.status("missing").unwrap().state, "unauthenticated");
    }

    #[test]
    fn managed_grok_profile_does_not_require_user_oauth_configuration() {
        let directory =
            std::env::temp_dir().join(format!("xiao-grok-profile-{}", uuid::Uuid::now_v7()));
        {
            let repository = XiaoRepository::open(&directory).unwrap();
            let profile = create_codex_profile(&repository).unwrap();
            assert_eq!(profile.environment["XIAO_MODEL_PROVIDER"], "xai");
            assert!(profile.environment.get("XAI_OAUTH_CLIENT_ID").is_none());
            assert!(profile.environment.get("XAI_API_KEY").is_none());
            let catalog_path =
                Path::new(profile.codex_home.as_deref().unwrap()).join("models.json");
            std::fs::write(&catalog_path, r#"{"models":[]}"#).unwrap();
            refresh_model_catalog(&profile).unwrap();
            let catalog: serde_json::Value =
                serde_json::from_slice(&std::fs::read(catalog_path).unwrap()).unwrap();
            assert!(catalog["models"][0]["apply_patch_tool_type"].is_null());
            let config = std::fs::read_to_string(
                Path::new(profile.codex_home.as_deref().unwrap()).join("config.toml"),
            )
            .unwrap();
            assert!(config.contains("base_url = \"https://api.x.ai/v1\""));
            assert!(!config.contains(XAI_CLIENT_ID));
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn xai_device_login_uses_the_bundled_subscription_client() {
        assert_eq!(XAI_CLIENT_ID, "b1a00492-073a-47ea-816f-4c329264a828");
        assert_eq!(
            OAUTH_SCOPES,
            "openid profile email offline_access grok-cli:access api:access"
        );
        assert_eq!(OAUTH_REFERRER, "pi");
    }

    #[test]
    fn missing_token_lifetime_defaults_to_one_hour() {
        let credential = StoredXaiCredential::from_token(
            TokenResponse {
                access_token: "access".to_owned(),
                refresh_token: Some("refresh".to_owned()),
                expires_in: None,
                token_type: None,
                scope: None,
            },
            None,
            1_000,
        )
        .unwrap();
        assert_eq!(
            credential.expires_at,
            Some(1_000 + DEFAULT_TOKEN_LIFETIME_SECONDS as i64 * 1_000)
        );
    }
}
