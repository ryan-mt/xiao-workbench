use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::{to_bytes, Body};
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderName, Response, StatusCode};
use axum::routing::post;
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use image::codecs::png::PngEncoder;
use image::{ImageEncoder, ImageFormat, ImageReader, Limits};
use reqwest::blocking::Client as BlockingClient;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::xiao::models::{CodexProfile, CodexProfileUpdate};
use crate::xiao::repository::XiaoRepository;

use super::models::{XaiDeviceAuthorization, XaiOAuthPollResult, XaiOAuthStatus};

pub const PROVIDER_MARKER_KEY: &str = "XIAO_MODEL_PROVIDER";

const PROVIDER_ID: &str = "xai";
const KEYRING_SERVICE: &str = "xiao-xai-oauth";
const CREDENTIAL_FILE_NAME: &str = "xai-oauth.credential";
const MODEL_PROFILES_DIR: &str = "model-profiles";
const OIDC_DISCOVERY_URL: &str = "https://auth.x.ai/.well-known/openid-configuration";
const XAI_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const OAUTH_SCOPES: &str = "openid profile email offline_access grok-cli:access api:access";
const OAUTH_REFERRER: &str = "pi";
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const XAI_API_BASE_URL: &str = "https://api.x.ai/v1";
const XAI_RESPONSES_URL: &str = "https://api.x.ai/v1/responses";
const XAI_MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const XAI_BRIDGE_MAX_REQUEST_BYTES: usize = 64 * 1024 * 1024;
const XAI_MAX_DECODED_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
const XAI_MAX_IMAGE_DIMENSION: u32 = 8_192;
const MODEL_ID: &str = "grok-4.5";
const REFRESH_SKEW_MILLIS: i64 = 5 * 60 * 1_000;
const DEFAULT_TOKEN_LIFETIME_SECONDS: u64 = 3_600;
const AUTH_HELPER_FLAG: &str = "--xiao-xai-auth";

pub trait XaiCredentialStore: Send + Sync + 'static {
    fn save(&self, profile_id: &str, value: &str) -> Result<(), String>;
    fn load(&self, profile_id: &str) -> Result<Option<String>, String>;
    fn delete(&self, profile_id: &str) -> Result<(), String>;
}

/// Stores xAI OAuth JSON next to the managed Codex profile.
/// Windows Credential Manager is too small/unreliable for access+refresh JWTs.
pub struct ProfileFileXaiCredentialStore {
    app_data_dir: PathBuf,
}

impl ProfileFileXaiCredentialStore {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self { app_data_dir }
    }

    fn credential_path(&self, profile_id: &str) -> Result<PathBuf, String> {
        let profile_id = profile_id.trim();
        if profile_id.is_empty()
            || profile_id.contains(['/', '\\'])
            || profile_id == "."
            || profile_id == ".."
            || profile_id.contains("..")
        {
            return Err("The xAI profile id is invalid.".to_owned());
        }
        Ok(self
            .app_data_dir
            .join(MODEL_PROFILES_DIR)
            .join(profile_id)
            .join(CREDENTIAL_FILE_NAME))
    }
}

impl XaiCredentialStore for ProfileFileXaiCredentialStore {
    fn save(&self, profile_id: &str, value: &str) -> Result<(), String> {
        let path = self.credential_path(profile_id)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!("Could not create the xAI credential directory: {error}")
            })?;
        }
        let temporary = path.with_extension("credential.tmp");
        std::fs::write(&temporary, value.as_bytes())
            .map_err(|error| format!("Could not write the xAI credential: {error}"))?;
        std::fs::rename(&temporary, &path)
            .map_err(|error| format!("Could not save the xAI credential: {error}"))?;
        // Best-effort cleanup of any legacy keyring copy.
        let _ = KeyringXaiCredentialStore.delete(profile_id);
        Ok(())
    }

    fn load(&self, profile_id: &str) -> Result<Option<String>, String> {
        let path = self.credential_path(profile_id)?;
        match std::fs::read_to_string(&path) {
            Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
            Ok(_) => Err("The saved xAI credential is empty.".to_owned()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                KeyringXaiCredentialStore.load(profile_id)
            }
            Err(error) => Err(format!("Could not load the xAI credential: {error}")),
        }
    }

    fn delete(&self, profile_id: &str) -> Result<(), String> {
        let path = self.credential_path(profile_id)?;
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("Could not remove the xAI credential: {error}"));
            }
        }
        KeyringXaiCredentialStore.delete(profile_id)
    }
}

#[derive(Default)]
struct KeyringXaiCredentialStore;

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
    client: BlockingClient,
    credentials: Arc<dyn XaiCredentialStore>,
    discovery: Mutex<Option<OAuthDiscovery>>,
    pending: Mutex<HashMap<String, PendingDeviceFlow>>,
    responses_base_url: String,
}

impl XaiOAuthService {
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        let responses_base_url = start_responses_bridge()?;
        Self::new_with_responses_base_url(app_data_dir, responses_base_url)
    }

    fn for_auth_helper(app_data_dir: PathBuf) -> Result<Self, String> {
        Self::new_with_responses_base_url(app_data_dir, XAI_API_BASE_URL.to_owned())
    }

    fn new_with_responses_base_url(
        app_data_dir: PathBuf,
        responses_base_url: String,
    ) -> Result<Self, String> {
        let client = BlockingClient::builder()
            .https_only(true)
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|error| format!("Could not initialize xAI OAuth: {error}"))?;
        Ok(Self {
            client,
            credentials: Arc::new(ProfileFileXaiCredentialStore::new(app_data_dir)),
            discovery: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            responses_base_url,
        })
    }

    #[cfg(test)]
    fn with_credentials(credentials: Arc<dyn XaiCredentialStore>) -> Self {
        Self {
            client: BlockingClient::builder().https_only(true).build().unwrap(),
            credentials,
            discovery: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            responses_base_url: XAI_API_BASE_URL.to_owned(),
        }
    }

    pub fn responses_base_url(&self) -> &str {
        &self.responses_base_url
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

pub fn refresh_model_catalog(
    profile: &CodexProfile,
    responses_base_url: &str,
) -> Result<(), String> {
    require_xai_profile(profile)?;
    let codex_home = profile
        .codex_home
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .ok_or("The Grok profile has no managed Codex home.")?;
    let codex_home = Path::new(codex_home);
    std::fs::write(
        codex_home.join("models.json"),
        serde_json::to_vec_pretty(&build_model_catalog())
            .map_err(|error| format!("Could not encode the Grok model catalog: {error}"))?,
    )
    .map_err(|error| format!("Could not refresh the Grok model catalog: {error}"))?;
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not locate the Xiao executable: {error}"))?;
    // Keep auth helper args/path current so Codex can mint bearer tokens.
    std::fs::write(
        codex_home.join("config.toml"),
        build_codex_config(
            &codex_home.join("models.json"),
            &profile.id,
            &executable,
            Some(codex_home),
            responses_base_url,
        )?,
    )
    .map_err(|error| format!("Could not refresh the Grok Codex profile: {error}"))
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
            Some(&codex_home),
            XAI_API_BASE_URL,
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
    attach_parent_console_for_auth_helper();
    let result = (|| {
        let profile_id = arguments
            .next()
            .filter(|profile_id| !profile_id.trim().is_empty())
            .ok_or("The xAI auth helper requires a profile id.")?;
        let app_data_dir = match arguments.next() {
            Some(path) if !path.trim().is_empty() => PathBuf::from(path),
            None => resolve_auth_helper_app_data_dir()?,
            Some(_) => return Err("The xAI auth helper received unexpected arguments.".to_owned()),
        };
        if arguments.next().is_some() {
            return Err("The xAI auth helper received unexpected arguments.".to_owned());
        }
        rustls::crypto::aws_lc_rs::default_provider()
            .install_default()
            .map_err(|_| "Could not initialize TLS for the xAI auth helper.".to_owned())?;
        let token = XaiOAuthService::for_auth_helper(app_data_dir)?.access_token(&profile_id)?;
        print!("{token}");
        let _ = std::io::Write::flush(&mut std::io::stdout());
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

fn resolve_auth_helper_app_data_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("XIAO_WORKBENCH_STATE_DIR") {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("XIAO_WORKBENCH_STATE_DIR must be an absolute path.".to_owned());
        }
        return Ok(path);
    }
    // When Codex launches the helper it inherits CODEX_HOME = managed profile dir.
    if let Some(codex_home) = std::env::var_os("CODEX_HOME") {
        let codex_home = PathBuf::from(codex_home);
        if let Some(app_data_dir) = app_data_dir_from_codex_home(&codex_home) {
            return Ok(app_data_dir);
        }
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return Ok(PathBuf::from(appdata).join("com.xiao.workbench"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return Ok(PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("com.xiao.workbench"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return Ok(PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("com.xiao.workbench"));
        }
    }
    Err("Could not locate Xiao app data for the xAI auth helper.".to_owned())
}

fn app_data_dir_from_codex_home(codex_home: &Path) -> Option<PathBuf> {
    let profile_dir = codex_home;
    let model_profiles = profile_dir.parent()?;
    if model_profiles.file_name()?.to_str()? != MODEL_PROFILES_DIR {
        return None;
    }
    Some(model_profiles.parent()?.to_path_buf())
}

fn attach_parent_console_for_auth_helper() {
    #[cfg(windows)]
    {
        // Release builds use the Windows GUI subsystem; attach so Codex can read stdout.
        const ATTACH_PARENT_PROCESS: u32 = 0xFFFF_FFFF;
        unsafe {
            let _ = windows_sys::Win32::System::Console::AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
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
    codex_home: Option<&Path>,
    responses_base_url: &str,
) -> Result<String, String> {
    let catalog_path = serde_json::to_string(&catalog_path.to_string_lossy())
        .map_err(|error| format!("Could not encode the Grok catalog path: {error}"))?;
    let executable = serde_json::to_string(&executable.to_string_lossy())
        .map_err(|error| format!("Could not encode the Xiao executable path: {error}"))?;
    let profile_id_json = serde_json::to_string(profile_id)
        .map_err(|error| format!("Could not encode the Grok profile id: {error}"))?;
    let responses_base_url = serde_json::to_string(responses_base_url)
        .map_err(|error| format!("Could not encode the xAI Responses bridge URL: {error}"))?;
    let auth_args = match codex_home.and_then(app_data_dir_from_codex_home) {
        Some(app_data_dir) => {
            let app_data_dir = serde_json::to_string(&app_data_dir.to_string_lossy())
                .map_err(|error| format!("Could not encode the Xiao app data path: {error}"))?;
            format!(r#"["{AUTH_HELPER_FLAG}", {profile_id_json}, {app_data_dir}]"#)
        }
        None => format!(r#"["{AUTH_HELPER_FLAG}", {profile_id_json}]"#),
    };
    Ok(format!(
        r#"model = "{MODEL_ID}"
model_provider = "xai"
model_reasoning_effort = "high"
model_reasoning_summary = "auto"
model_catalog_json = {catalog_path}

[features]
remote_compaction_v2 = false

[model_providers.xai]
name = "xAI"
base_url = {responses_base_url}
wire_api = "responses"

[model_providers.xai.auth]
command = {executable}
args = {auth_args}
refresh_interval_ms = 300000
timeout_ms = 20000
"#
    ))
}

#[derive(Clone)]
struct XaiResponsesBridge {
    client: reqwest::Client,
}

fn start_responses_bridge() -> Result<String, String> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("Could not bind the xAI Responses bridge: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not configure the xAI Responses bridge: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Could not read the xAI Responses bridge address: {error}"))?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Could not initialize the xAI Responses bridge: {error}"))?;
    let router = Router::new()
        .route("/v1/responses", post(forward_xai_response))
        .layer(DefaultBodyLimit::max(XAI_BRIDGE_MAX_REQUEST_BYTES))
        .with_state(XaiResponsesBridge { client });
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Could not create the xAI Responses bridge runtime: {error}"))?;
    let listener = {
        let _runtime = runtime.enter();
        tokio::net::TcpListener::from_std(listener).map_err(|error| {
            format!("Could not start the xAI Responses bridge listener: {error}")
        })?
    };
    std::thread::Builder::new()
        .name("xai-responses-bridge".to_owned())
        .spawn(move || {
            runtime.block_on(async move {
                if let Err(error) = axum::serve(listener, router).await {
                    eprintln!("xAI Responses bridge stopped: {error}");
                }
            });
        })
        .map_err(|error| format!("Could not start the xAI Responses bridge: {error}"))?;
    Ok(format!("http://{address}/v1"))
}

async fn forward_xai_response(
    State(bridge): State<XaiResponsesBridge>,
    request: Request,
) -> Result<Response<Body>, (StatusCode, String)> {
    let authorization = request
        .headers()
        .get(header::AUTHORIZATION)
        .cloned()
        .ok_or((
            StatusCode::UNAUTHORIZED,
            "The xAI Responses bridge requires authorization.".to_owned(),
        ))?;
    let body = to_bytes(request.into_body(), XAI_BRIDGE_MAX_REQUEST_BYTES)
        .await
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let request = serde_json::from_slice(&body)
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let request = tokio::task::spawn_blocking(move || sanitize_responses_request(request))
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))??;
    let upstream = bridge
        .client
        .post(XAI_RESPONSES_URL)
        .header(header::AUTHORIZATION, authorization)
        .header(header::ACCEPT, "text/event-stream")
        .json(&request)
        .send()
        .await
        .map_err(|error| (StatusCode::BAD_GATEWAY, error.to_string()))?;
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let stream = upstream.bytes_stream();
    let mapped = futures_util::stream::unfold(
        (stream, XaiSseTransformState::default()),
        |(mut stream, mut transform)| async move {
            use futures_util::StreamExt;
            match stream.next().await {
                Some(Ok(bytes)) => {
                    let mapped = transform_xai_sse_chunk(&mut transform, &bytes);
                    Some((
                        Ok::<_, reqwest::Error>(axum::body::Bytes::from(mapped)),
                        (stream, transform),
                    ))
                }
                Some(Err(error)) => Some((Err(error), (stream, transform))),
                None => {
                    if transform.buffer.is_empty() {
                        None
                    } else {
                        // Flush a trailing unterminated line without transformation.
                        let rest = std::mem::take(&mut transform.buffer);
                        Some((Ok(axum::body::Bytes::from(rest)), (stream, transform)))
                    }
                }
            }
        },
    );
    let mut response = Response::new(Body::from_stream(mapped));
    *response.status_mut() = status;
    for (name, value) in &headers {
        if is_end_to_end_response_header(name) {
            response.headers_mut().append(name.clone(), value.clone());
        }
    }
    Ok(response)
}

fn is_end_to_end_response_header(name: &HeaderName) -> bool {
    !matches!(
        name.as_str(),
        "connection"
            | "content-length"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn sanitize_responses_request(mut request: Value) -> Result<Value, (StatusCode, String)> {
    let input = request
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .ok_or((
            StatusCode::BAD_REQUEST,
            "The xAI Responses request has no input array.".to_owned(),
        ))?;
    input.retain(|item| item.get("type").and_then(Value::as_str) != Some("reasoning"));
    for item in input.iter_mut() {
        project_xai_input_item(item);
    }
    let mut request_size = xai_request_size(&request)?;
    normalize_xai_image_inputs(&mut request, &mut request_size)?;
    project_xai_tool_schemas(&mut request);
    ensure_xai_request_size(&request)?;
    Ok(request)
}

fn normalize_xai_image_inputs(
    request: &mut Value,
    request_size: &mut usize,
) -> Result<(), (StatusCode, String)> {
    match request {
        Value::Array(values) => {
            for value in values {
                normalize_xai_image_inputs(value, request_size)?;
            }
        }
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("input_image") {
                if let Some(image_url) = object.get_mut("image_url") {
                    if let Some(url) = image_url.as_str() {
                        if let Some(normalized) = normalize_xai_image_data_url(url)? {
                            let normalized_size = request_size
                                .saturating_sub(url.len())
                                .saturating_add(normalized.len());
                            if normalized_size > XAI_BRIDGE_MAX_REQUEST_BYTES {
                                return Err((
                                    StatusCode::PAYLOAD_TOO_LARGE,
                                    "The normalized xAI request exceeds 64 MiB.".to_owned(),
                                ));
                            }
                            *request_size = normalized_size;
                            *image_url = Value::String(normalized);
                        }
                    }
                }
            }
            for value in object.values_mut() {
                normalize_xai_image_inputs(value, request_size)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn normalize_xai_image_data_url(url: &str) -> Result<Option<String>, (StatusCode, String)> {
    if !url
        .get(.."data:image/".len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:image/"))
    {
        return Ok(None);
    }
    let (metadata, encoded) = url.split_once(',').ok_or((
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "The xAI image data URL is malformed.".to_owned(),
    ))?;
    let metadata = metadata.to_ascii_lowercase();
    if !metadata.split(';').any(|part| part == "base64") {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "xAI image data URLs must use base64 encoding.".to_owned(),
        ));
    }
    let mime = metadata
        .strip_prefix("data:")
        .and_then(|value| value.split(';').next())
        .unwrap_or_default();
    let decoded = BASE64_STANDARD.decode(encoded).map_err(|_| {
        (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "The xAI image data URL contains invalid base64.".to_owned(),
        )
    })?;
    if decoded.len() > XAI_MAX_IMAGE_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "xAI images must not exceed 20 MiB each.".to_owned(),
        ));
    }
    match mime {
        "image/jpeg" | "image/jpg" | "image/png" => Ok(None),
        "image/webp" => {
            let mut reader = ImageReader::with_format(Cursor::new(&decoded), ImageFormat::WebP);
            let mut limits = Limits::default();
            limits.max_image_width = Some(XAI_MAX_IMAGE_DIMENSION);
            limits.max_image_height = Some(XAI_MAX_IMAGE_DIMENSION);
            limits.max_alloc = Some(XAI_MAX_DECODED_IMAGE_BYTES);
            reader.limits(limits);
            let image = reader.decode().map_err(|_| {
                (
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    "The WebP attachment could not be decoded safely for xAI.".to_owned(),
                )
            })?;
            let mut output = BoundedBuffer::new(XAI_MAX_IMAGE_BYTES);
            PngEncoder::new(&mut output)
                .write_image(
                    image.as_bytes(),
                    image.width(),
                    image.height(),
                    image.color().into(),
                )
                .map_err(|_| {
                    (
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "The converted xAI image exceeds 20 MiB.".to_owned(),
                    )
                })?;
            Ok(Some(format!(
                "data:image/png;base64,{}",
                BASE64_STANDARD.encode(output.into_inner())
            )))
        }
        _ => Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "xAI accepts only JPEG and PNG image inputs.".to_owned(),
        )),
    }
}

fn ensure_xai_request_size(request: &Value) -> Result<(), (StatusCode, String)> {
    xai_request_size(request).map(|_| ())
}

fn xai_request_size(request: &Value) -> Result<usize, (StatusCode, String)> {
    let mut counter = BoundedCounter::new(XAI_BRIDGE_MAX_REQUEST_BYTES);
    serde_json::to_writer(&mut counter, request).map_err(|_| {
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            "The normalized xAI request exceeds 64 MiB.".to_owned(),
        )
    })?;
    Ok(counter.written)
}

struct BoundedCounter {
    written: usize,
    limit: usize,
}

impl BoundedCounter {
    fn new(limit: usize) -> Self {
        Self { written: 0, limit }
    }
}

impl Write for BoundedCounter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if self.written.saturating_add(buffer.len()) > self.limit {
            return Err(std::io::Error::other("request limit exceeded"));
        }
        self.written += buffer.len();
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct BoundedBuffer {
    bytes: Vec<u8>,
    limit: usize,
}

impl BoundedBuffer {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
        }
    }

    fn into_inner(self) -> Vec<u8> {
        self.bytes
    }
}

impl Write for BoundedBuffer {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len().saturating_add(buffer.len()) > self.limit {
            return Err(std::io::Error::other("buffer limit exceeded"));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn project_xai_tool_schemas(request: &mut Value) {
    let Some(tools) = request.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    for tool in tools {
        match tool.get("type").and_then(Value::as_str) {
            Some("function") => project_xai_function_tool(tool),
            // xAI accepts structured function tools; Codex freeform/custom tools (apply_patch)
            // are projected to a single-string function parameter.
            Some("custom") => project_xai_custom_tool_as_function(tool),
            _ => {}
        }
    }
}

fn project_xai_custom_tool_as_function(tool: &mut Value) {
    let Some(object) = tool.as_object_mut() else {
        return;
    };
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("custom_tool")
        .to_owned();
    let description = object
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("Freeform tool input.")
        .to_owned();
    let input_description = if name == "apply_patch" {
        "Raw apply_patch text. Do not wrap the patch in JSON."
    } else {
        "Raw freeform tool input. Do not wrap the value in JSON unless the tool description requires it."
    };
    *tool = json!({
        "type": "function",
        "name": name,
        "description": description,
        "strict": false,
        "parameters": {
            "type": "object",
            "properties": {
                "input": {
                    "type": "string",
                    "description": input_description
                }
            },
            "required": ["input"],
            "additionalProperties": false
        }
    });
}

fn project_xai_function_tool(tool: &mut Value) {
    let Some(object) = tool.as_object_mut() else {
        return;
    };

    // Codex dynamic tools and some client tools use inputSchema; xAI Responses expects parameters.
    if !object.contains_key("parameters") {
        if let Some(schema) = object.remove("inputSchema") {
            object.insert("parameters".to_owned(), schema);
        }
    } else {
        object.remove("inputSchema");
    }

    if let Some(parameters) = object.get_mut("parameters") {
        sanitize_portable_json_schema(parameters);
        coerce_known_integer_schema_types(parameters);
    }
}

fn project_xai_input_item(item: &mut Value) {
    let Some(object) = item.as_object_mut() else {
        return;
    };
    match object.get("type").and_then(Value::as_str) {
        Some("custom_tool_call") => {
            let input = object
                .get("input")
                .cloned()
                .unwrap_or(Value::String(String::new()));
            let arguments = match input {
                Value::String(text) => json!({ "input": text }).to_string(),
                other => json!({ "input": other }).to_string(),
            };
            object.insert("type".to_owned(), Value::String("function_call".to_owned()));
            object.insert("arguments".to_owned(), Value::String(arguments));
            object.remove("input");
        }
        Some("custom_tool_call_output") => {
            let output = object.get("output").cloned().unwrap_or(Value::Null);
            object.insert(
                "type".to_owned(),
                Value::String("function_call_output".to_owned()),
            );
            // Preserve string outputs; wrap structured payloads as JSON text for xAI.
            match output {
                Value::String(_) => {}
                other => {
                    object.insert("output".to_owned(), Value::String(other.to_string()));
                }
            }
        }
        _ => {}
    }
}

fn map_xai_response_event_to_codex(mut event: Value) -> Value {
    let Some(event_type) = event.get("type").and_then(Value::as_str).map(str::to_owned) else {
        return event;
    };

    match event_type.as_str() {
        // Map complete apply_patch function calls back to Codex custom/freeform tool calls.
        // Argument deltas stay as function_call_arguments.* — only the finished item is required
        // for execution (same practical path grokapp uses with structured function tools).
        "response.output_item.added" | "response.output_item.done" => {
            if let Some(item) = event.get_mut("item") {
                map_xai_output_item_to_codex(item);
            }
        }
        "response.completed" | "response.incomplete" | "response.failed" => {
            if let Some(output) = event
                .pointer_mut("/response/output")
                .and_then(Value::as_array_mut)
            {
                for item in output.iter_mut() {
                    map_xai_output_item_to_codex(item);
                }
            }
        }
        _ => {}
    }
    event
}

fn map_xai_output_item_to_codex(item: &mut Value) {
    let Some(object) = item.as_object_mut() else {
        return;
    };
    if object.get("type").and_then(Value::as_str) != Some("function_call") {
        return;
    }
    if object.get("name").and_then(Value::as_str) != Some("apply_patch") {
        return;
    }
    let arguments = object
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let input = extract_apply_patch_input_from_arguments(&arguments);
    object.insert(
        "type".to_owned(),
        Value::String("custom_tool_call".to_owned()),
    );
    object.insert("input".to_owned(), Value::String(input));
    object.remove("arguments");
}

fn extract_apply_patch_input_from_arguments(arguments: &str) -> String {
    let trimmed = arguments.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(trimmed) {
        if let Some(Value::String(input)) = map.get("input") {
            return input.clone();
        }
        if let Some(input) = map.get("input") {
            return input.to_string();
        }
    }
    // If the model emitted raw patch text as the entire arguments payload, keep it.
    if trimmed.contains("*** Begin Patch") {
        return trimmed.to_owned();
    }
    trimmed.to_owned()
}

#[derive(Default)]
struct XaiSseTransformState {
    buffer: Vec<u8>,
    pending_tool_calls: HashMap<String, Value>,
    pending_tool_order: Vec<String>,
}

fn xai_tool_call_key(item: &Value) -> Option<String> {
    item.get("call_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn xai_tool_call(item: &Value) -> bool {
    matches!(
        item.get("type").and_then(Value::as_str),
        Some("function_call" | "custom_tool_call")
    )
}

fn xai_completed_tool_call(item: &Value) -> bool {
    if item
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status != "completed")
    {
        return false;
    }
    if item
        .get("call_id")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
        || item
            .get("name")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return false;
    }
    match item.get("type").and_then(Value::as_str) {
        Some("function_call") => {
            let Some(arguments) = item
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|arguments| serde_json::from_str::<Value>(arguments).ok())
                .and_then(|arguments| arguments.as_object().cloned())
            else {
                return false;
            };
            item.get("name").and_then(Value::as_str) != Some("apply_patch")
                || arguments.get("input").is_some_and(Value::is_string)
        }
        Some("custom_tool_call") => item.get("input").is_some_and(Value::is_string),
        _ => false,
    }
}

fn transform_xai_response_event(state: &mut XaiSseTransformState, event: Value) -> Vec<Value> {
    let event_type = event.get("type").and_then(Value::as_str);
    if event_type == Some("response.output_item.done") {
        let item = event.get("item");
        if item.is_some_and(xai_tool_call) && !item.is_some_and(xai_completed_tool_call) {
            return Vec::new();
        }
        let mapped = map_xai_response_event_to_codex(event);
        let Some(key) = mapped.get("item").and_then(xai_tool_call_key) else {
            return vec![mapped];
        };
        if !state.pending_tool_calls.contains_key(&key) {
            state.pending_tool_order.push(key.clone());
        }
        state.pending_tool_calls.insert(key, mapped);
        return Vec::new();
    }

    if event_type == Some("response.completed") {
        let output = event
            .pointer("/response/output")
            .and_then(Value::as_array)
            .cloned();
        let mapped = map_xai_response_event_to_codex(event);
        let mut events = match output {
            Some(output) => {
                let mut emitted = HashSet::new();
                output
                    .into_iter()
                    .enumerate()
                    .filter_map(|(output_index, mut item)| {
                        if !xai_completed_tool_call(&item) {
                            return None;
                        }
                        let key = xai_tool_call_key(&item)?;
                        if !emitted.insert(key) {
                            return None;
                        }
                        map_xai_output_item_to_codex(&mut item);
                        Some(json!({
                            "type": "response.output_item.done",
                            "output_index": output_index,
                            "item": item,
                        }))
                    })
                    .collect::<Vec<_>>()
            }
            None => state
                .pending_tool_order
                .iter()
                .filter_map(|key| state.pending_tool_calls.get(key).cloned())
                .collect(),
        };
        events.push(mapped);
        state.pending_tool_calls.clear();
        state.pending_tool_order.clear();
        return events;
    }

    if matches!(event_type, Some("response.incomplete" | "response.failed")) {
        state.pending_tool_calls.clear();
        state.pending_tool_order.clear();
    }
    vec![map_xai_response_event_to_codex(event)]
}

fn xai_sse_frame_end(buffer: &[u8]) -> Option<(usize, usize)> {
    for index in 0..buffer.len() {
        if buffer[index..].starts_with(b"\r\n\r\n") {
            return Some((index, 4));
        }
        if buffer[index..].starts_with(b"\n\n") || buffer[index..].starts_with(b"\r\r") {
            return Some((index, 2));
        }
    }
    None
}

fn transform_xai_sse_frame(state: &mut XaiSseTransformState, frame: &[u8]) -> Vec<u8> {
    let Ok(frame_text) = std::str::from_utf8(frame) else {
        return frame.to_vec();
    };
    let normalized = frame_text.replace("\r\n", "\n").replace('\r', "\n");
    let data = normalized
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>();
    if data.is_empty() {
        return frame.to_vec();
    }
    let payload = data.join("\n");
    if payload.is_empty() || payload == "[DONE]" {
        return frame.to_vec();
    }
    let Ok(event) = serde_json::from_str::<Value>(&payload) else {
        return frame.to_vec();
    };
    let mapped_events = transform_xai_response_event(state, event);
    let mut output = Vec::new();
    for mapped in mapped_events {
        let Ok(serialized) = serde_json::to_vec(&mapped) else {
            return frame.to_vec();
        };
        output.extend_from_slice(b"data: ");
        output.extend_from_slice(&serialized);
        output.extend_from_slice(b"\n\n");
    }
    output
}

fn transform_xai_sse_chunk(state: &mut XaiSseTransformState, chunk: &[u8]) -> Vec<u8> {
    state.buffer.extend_from_slice(chunk);
    let mut output = Vec::new();
    while let Some((frame_end, delimiter_len)) = xai_sse_frame_end(&state.buffer) {
        let frame = state
            .buffer
            .drain(..frame_end + delimiter_len)
            .collect::<Vec<_>>();
        output.extend(transform_xai_sse_frame(state, &frame));
    }
    output
}

fn sanitize_portable_json_schema(value: &mut Value) {
    match value {
        Value::Object(object) => {
            // Keep anyOf/oneOf: common portable unions in function schemas.
            // Strip only conditional/ref constructs that break xAI tool validation.
            for key in [
                "allOf",
                "if",
                "then",
                "else",
                "$ref",
                "$defs",
                "definitions",
            ] {
                object.remove(key);
            }
            // Keep enum/const only on simple leaf enums that xAI already tolerates.
            // Nested conditionals are stripped above; bare const is uncommon and non-portable.
            if object.get("const").is_some() && !object.contains_key("enum") {
                if let Some(constant) = object.remove("const") {
                    object.insert("enum".to_owned(), Value::Array(vec![constant]));
                }
            }
            for child in object.values_mut() {
                sanitize_portable_json_schema(child);
            }
        }
        Value::Array(values) => {
            for child in values {
                sanitize_portable_json_schema(child);
            }
        }
        _ => {}
    }
}

fn coerce_known_integer_schema_types(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        match value {
            Value::Array(values) => {
                for child in values {
                    coerce_known_integer_schema_types(child);
                }
            }
            _ => {}
        }
        return;
    };

    if let Some(properties) = object.get_mut("properties").and_then(Value::as_object_mut) {
        for (name, schema) in properties.iter_mut() {
            if matches!(name.as_str(), "timeout_ms" | "line" | "character" | "limit") {
                if let Some(type_value) = schema.get_mut("type") {
                    if type_value.as_str() == Some("number") {
                        *type_value = Value::String("integer".to_owned());
                    }
                }
            }
            coerce_known_integer_schema_types(schema);
        }
    }

    for (key, child) in object.iter_mut() {
        if key == "properties" {
            continue;
        }
        coerce_known_integer_schema_types(child);
    }
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
            "base_instructions": "You are a careful coding agent working in Xiao. Follow the system and developer instructions and complete the user's task.\n\n# Shared tools\n\nUse only tools provided in the current request. Do not invent tools that are not listed. Client-side tools use JSON function arguments unless a tool is explicitly freeform.\n\nCore tools you should expect and prefer when available:\n- apply_patch: preferred tool for creating or editing local files. This is a FREEFORM tool — send the patch text directly, do not wrap it in JSON.\n- shell_command: run shell commands, search the workspace, and perform bulk/mechanical edits when apply_patch is a poor fit. Prefer rg for search. On Windows PowerShell, prefer single-quoted paths/regexes; backslash does not escape quotes.\n- view_image: inspect a local image path the user attached or that already exists on disk.\n- update_plan: publish and continuously update multi-step task plans.\n- request_user_input: ask a short multiple-choice question only when a decision truly blocks progress.\n- get_goal / update_goal: when a Xiao goal is active, read it first and update completion status only when truly done.\n- xiao_lsp_definition, xiao_lsp_references, xiao_lsp_workspace_symbols, xiao_lsp_diagnostics: read-only semantic code intelligence for TypeScript/JavaScript/Rust.\n- xiao_runtime_diagnostics: inspect the active Xiao run snapshot, sandbox policy, and recent events.\n- xiao_preview_targets / xiao_preview_automate: inspect and perform bounded clicks/focus/fill on Task Preview targets. For action=fill, include value.\n\nParallel tool calls are supported when independent. Never invent tools outside the provided tool list. Prefer apply_patch over shell rewrites for ordinary source edits.\n\nWeb search, multi-agent orchestration, plugins, and apps may be unavailable in this profile. Stay inside the tools actually provided for the turn.",
            "supports_reasoning_summary_parameter": true,
            "default_reasoning_summary": "auto",
            "support_verbosity": false,
            "default_verbosity": null,
            "apply_patch_tool_type": "freeform",
            "truncation_policy": { "mode": "tokens", "limit": 10000 },
            "supports_parallel_tool_calls": true,
            "context_window": 500000,
            "max_context_window": 500000,
            "effective_context_window_percent": 95,
            "auto_compact_token_limit": null,
            "experimental_supported_tools": [],
            "input_modalities": ["text", "image"],
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
    use std::time::Duration;

    use super::{
        app_data_dir_from_codex_home, build_codex_config, build_model_catalog,
        create_codex_profile, credential_status, map_xai_response_event_to_codex,
        normalize_xai_image_inputs, refresh_model_catalog, sanitize_responses_request,
        start_responses_bridge, transform_xai_sse_chunk, validate_discovery, BlockingClient,
        OAuthDiscovery, ProfileFileXaiCredentialStore, StatusCode, StoredXaiCredential,
        TokenResponse, XaiCredentialStore, XaiOAuthService, XaiSseTransformState,
        DEFAULT_TOKEN_LIFETIME_SECONDS, OAUTH_REFERRER, OAUTH_SCOPES, XAI_API_BASE_URL,
        XAI_BRIDGE_MAX_REQUEST_BYTES, XAI_CLIENT_ID,
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
        assert_eq!(
            model["input_modalities"],
            serde_json::json!(["text", "image"])
        );
        assert_eq!(model["apply_patch_tool_type"], "freeform");
        let instructions = model["base_instructions"].as_str().unwrap();
        assert!(instructions.contains("Shared tools"));
        assert!(instructions.contains("apply_patch"));
        assert!(instructions.contains("FREEFORM"));
        assert!(instructions.contains("shell_command"));
        assert!(instructions.contains("view_image"));
        assert!(instructions.contains("update_plan"));
        assert!(instructions.contains("request_user_input"));
        assert!(instructions.contains("get_goal"));
        assert!(instructions.contains("update_goal"));
        assert!(instructions.contains("xiao_lsp_definition"));
        assert!(instructions.contains("xiao_runtime_diagnostics"));
        assert!(instructions.contains("xiao_preview_automate"));
        assert!(instructions.contains("Parallel tool calls are supported"));
        assert!(instructions.contains("Prefer apply_patch over shell rewrites"));
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
            Path::new(r"C:\Xiao\model-profiles\grok-profile\models.json"),
            "grok-profile",
            Path::new(r"C:\Program Files\Xiao\xiao.exe"),
            Some(Path::new(r"C:\Xiao\model-profiles\grok-profile")),
            "http://127.0.0.1:43181/v1",
        )
        .unwrap();
        assert!(config.contains("wire_api = \"responses\""));
        assert!(config.contains("base_url = \"http://127.0.0.1:43181/v1\""));
        assert!(config.contains("remote_compaction_v2 = false"));
        assert!(!config.contains("model_auto_compact_token_limit"));
        assert!(config.contains("[model_providers.xai.auth]"));
        assert!(config.contains("--xiao-xai-auth"));
        assert!(config.contains(r#"C:\\Xiao"#));
        assert!(!config.contains("env_key"));
        assert!(!config.contains("access_token"));
        assert!(!config.contains("refresh_token"));
        assert_eq!(
            app_data_dir_from_codex_home(Path::new(r"C:\Xiao\model-profiles\grok-profile"))
                .as_deref(),
            Some(Path::new(r"C:\Xiao"))
        );
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
            refresh_model_catalog(&profile, XAI_API_BASE_URL).unwrap();
            let catalog: serde_json::Value =
                serde_json::from_slice(&std::fs::read(catalog_path).unwrap()).unwrap();
            assert_eq!(catalog["models"][0]["apply_patch_tool_type"], "freeform");
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
    fn xai_responses_bridge_drops_unreplayable_reasoning_items() {
        let sanitized = sanitize_responses_request(serde_json::json!({
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{
                        "type": "input_image",
                        "image_url": "data:image/png;base64,iVBORw0KGgo="
                    }]
                },
                { "type": "reasoning", "encrypted_content": "opaque" },
                { "type": "function_call", "call_id": "call-1" },
                { "type": "function_call_output", "call_id": "call-1" }
            ]
        }))
        .unwrap();

        assert_eq!(
            sanitized["input"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["message", "function_call", "function_call_output"]
        );
        assert_eq!(
            sanitized["input"][0]["content"][0]["image_url"],
            "data:image/png;base64,iVBORw0KGgo="
        );
    }

    #[test]
    fn xai_responses_bridge_projects_shared_function_tools_to_portable_schemas() {
        let sanitized = sanitize_responses_request(serde_json::json!({
            "input": [{ "type": "message", "role": "user" }],
            "tools": [
                {
                    "type": "function",
                    "name": "shell_command",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "timeout_ms": { "type": "number" },
                            "delay_seconds": { "type": "number" }
                        }
                    }
                },
                {
                    "type": "function",
                    "name": "xiao_lsp_definition",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "line": { "type": "number" },
                            "character": { "type": "number" }
                        },
                        "allOf": [{
                            "if": { "properties": { "line": { "const": 1 } } },
                            "then": { "required": ["character"] }
                        }]
                    }
                },
                {
                    "type": "function",
                    "name": "xiao_preview_automate",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "action": { "type": "string" },
                            "value": {
                                "anyOf": [
                                    { "type": "string" },
                                    { "type": "null" }
                                ]
                            }
                        },
                        "required": ["action"]
                    }
                }
            ]
        }))
        .unwrap();

        assert_eq!(
            sanitized["tools"][0]["parameters"]["properties"]["timeout_ms"]["type"],
            "integer"
        );
        assert_eq!(
            sanitized["tools"][0]["parameters"]["properties"]["delay_seconds"]["type"],
            "number"
        );
        assert!(sanitized["tools"][1].get("inputSchema").is_none());
        assert_eq!(
            sanitized["tools"][1]["parameters"]["properties"]["line"]["type"],
            "integer"
        );
        assert_eq!(
            sanitized["tools"][1]["parameters"]["properties"]["character"]["type"],
            "integer"
        );
        assert!(sanitized["tools"][1]["parameters"].get("allOf").is_none());
        assert!(sanitized["tools"][2].get("inputSchema").is_none());
        assert_eq!(
            sanitized["tools"][2]["parameters"]["required"],
            serde_json::json!(["action"])
        );
        assert_eq!(
            sanitized["tools"][2]["parameters"]["properties"]["value"]["anyOf"],
            serde_json::json!([{ "type": "string" }, { "type": "null" }])
        );
        assert_eq!(
            sanitize_responses_request(sanitized.clone()).unwrap(),
            sanitized
        );
    }

    #[test]
    fn xai_responses_bridge_projects_freeform_apply_patch_to_function_tools() {
        let sanitized = sanitize_responses_request(serde_json::json!({
            "input": [
                {
                    "type": "custom_tool_call",
                    "call_id": "call-patch",
                    "name": "apply_patch",
                    "input": "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch"
                },
                {
                    "type": "custom_tool_call_output",
                    "call_id": "call-patch",
                    "output": "Success"
                }
            ],
            "tools": [
                {
                    "type": "custom",
                    "name": "apply_patch",
                    "description": "The apply_patch tool can be used to edit files.",
                    "format": {
                        "type": "grammar",
                        "syntax": "lark",
                        "definition": "start: begin_patch"
                    }
                }
            ]
        }))
        .unwrap();

        assert_eq!(sanitized["tools"][0]["type"], "function");
        assert_eq!(sanitized["tools"][0]["name"], "apply_patch");
        assert_eq!(
            sanitized["tools"][0]["parameters"]["required"],
            serde_json::json!(["input"])
        );
        assert_eq!(sanitized["input"][0]["type"], "function_call");
        assert_eq!(sanitized["input"][0]["name"], "apply_patch");
        assert!(sanitized["input"][0]["arguments"]
            .as_str()
            .unwrap()
            .contains("*** Begin Patch"));
        assert_eq!(sanitized["input"][1]["type"], "function_call_output");
        assert_eq!(sanitized["input"][1]["output"], "Success");

        let mapped = map_xai_response_event_to_codex(serde_json::json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call-2",
                "name": "apply_patch",
                "arguments": "{\"input\":\"*** Begin Patch\\n*** Add File: b.txt\\n+yo\\n*** End Patch\"}"
            }
        }));
        assert_eq!(mapped["item"]["type"], "custom_tool_call");
        assert_eq!(
            mapped["item"]["input"],
            "*** Begin Patch\n*** Add File: b.txt\n+yo\n*** End Patch"
        );
    }

    #[test]
    fn xai_responses_bridge_emits_each_completed_tool_once() {
        let item = serde_json::json!({
            "id": "item-patch",
            "type": "function_call",
            "call_id": "call-patch",
            "name": "apply_patch",
            "arguments": "{\"input\":\"*** Begin Patch\\n*** End Patch\"}"
        });
        let done = serde_json::json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": item
        });
        let completed = serde_json::json!({
            "type": "response.completed",
            "response": {
                "id": "response-1",
                "output": [item]
            }
        });
        let mut state = XaiSseTransformState::default();

        let duplicate_done = format!("data: {done}\n\ndata: {done}\n\n");
        let buffered = transform_xai_sse_chunk(&mut state, duplicate_done.as_bytes());
        assert!(buffered.iter().all(|byte| byte.is_ascii_whitespace()));

        let completion = format!("data: {completed}\n\n");
        let mapped =
            String::from_utf8(transform_xai_sse_chunk(&mut state, completion.as_bytes())).unwrap();
        let event_types = mapped
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|payload| serde_json::from_str::<serde_json::Value>(payload).ok())
            .filter_map(|event| event["type"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();

        assert_eq!(
            event_types,
            ["response.output_item.done", "response.completed"]
        );
    }

    #[test]
    fn xai_responses_bridge_recovers_a_missing_tool_done_before_completion() {
        let event = serde_json::json!({
            "type": "response.completed",
            "response": {
                "id": "response-1",
                "output": [{
                    "id": "item-patch",
                    "type": "function_call",
                    "call_id": "call-patch",
                    "name": "apply_patch",
                    "arguments": "{\"input\":\"*** Begin Patch\\n*** End Patch\"}"
                }]
            }
        });
        let mut state = XaiSseTransformState::default();

        let chunk = format!("data: {event}\n\n");
        let mapped =
            String::from_utf8(transform_xai_sse_chunk(&mut state, chunk.as_bytes())).unwrap();
        let frames = mapped
            .split("\n\n")
            .filter(|frame| !frame.is_empty())
            .collect::<Vec<_>>();
        let events = mapped
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|payload| serde_json::from_str::<serde_json::Value>(payload).ok())
            .collect::<Vec<_>>();

        assert_eq!(frames.len(), 2);
        assert!(frames.iter().all(|frame| frame.lines().count() == 1));
        assert_eq!(
            events
                .iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["response.output_item.done", "response.completed"]
        );
        assert_eq!(events[0]["item"]["type"], "custom_tool_call");
        assert_eq!(events[0]["item"]["call_id"], "call-patch");
    }

    #[test]
    fn xai_responses_bridge_reconciles_parallel_tools_by_call_id() {
        let shell = serde_json::json!({
            "id": "item-shell",
            "type": "function_call",
            "call_id": "call-shell",
            "name": "shell_command",
            "arguments": "{\"command\":\"npm test\"}"
        });
        let patch = serde_json::json!({
            "id": "item-patch",
            "type": "function_call",
            "call_id": "call-patch",
            "name": "apply_patch",
            "arguments": "{\"input\":\"*** Begin Patch\\n*** End Patch\"}"
        });
        let done = serde_json::json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": shell
        });
        let completed = serde_json::json!({
            "type": "response.completed",
            "response": {
                "id": "response-1",
                "output": [shell, patch]
            }
        });
        let chunk = format!("data: {done}\n\ndata: {completed}\n\n");
        let mut state = XaiSseTransformState::default();

        let mapped =
            String::from_utf8(transform_xai_sse_chunk(&mut state, chunk.as_bytes())).unwrap();
        let events = mapped
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|payload| serde_json::from_str::<serde_json::Value>(payload).ok())
            .collect::<Vec<_>>();

        assert_eq!(
            events
                .iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "response.output_item.done",
                "response.output_item.done",
                "response.completed"
            ]
        );
        assert_eq!(events[0]["item"]["call_id"], "call-shell");
        assert_eq!(events[0]["item"]["type"], "function_call");
        assert_eq!(events[1]["item"]["call_id"], "call-patch");
        assert_eq!(events[1]["item"]["type"], "custom_tool_call");
    }

    #[test]
    fn xai_responses_bridge_rejects_malformed_apply_patch_arguments() {
        let item = serde_json::json!({
            "id": "item-patch",
            "type": "function_call",
            "call_id": "call-patch",
            "name": "apply_patch",
            "arguments": "not-json"
        });
        let done = serde_json::json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": item
        });
        let completed = serde_json::json!({
            "type": "response.completed",
            "response": { "id": "response-1", "output": [item] }
        });
        let chunk = format!("data: {done}\n\ndata: {completed}\n\n");
        let mut state = XaiSseTransformState::default();

        let mapped =
            String::from_utf8(transform_xai_sse_chunk(&mut state, chunk.as_bytes())).unwrap();
        let event_types = mapped
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|payload| serde_json::from_str::<serde_json::Value>(payload).ok())
            .filter_map(|event| event["type"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();

        assert_eq!(event_types, ["response.completed"]);
    }

    #[test]
    fn xai_responses_bridge_parses_multiline_and_cr_only_sse_frames() {
        let item = serde_json::json!({
            "id": "item-shell",
            "type": "function_call",
            "call_id": "call-shell",
            "name": "shell_command",
            "arguments": "{\"command\":\"npm test\"}"
        });
        let completed = serde_json::json!({
            "type": "response.completed",
            "response": { "id": "response-1", "output": [item] }
        });
        let multiline_done = concat!(
            "data: {\"type\":\"response.output_item.done\",\n",
            "data: \"output_index\":0,\"item\":{\"id\":\"item-shell\",",
            "\"type\":\"function_call\",\"call_id\":\"call-shell\",",
            "\"name\":\"shell_command\",",
            "\"arguments\":\"{\\\"command\\\":\\\"npm test\\\"}\"}}\r\n\r\n"
        );
        let chunk = format!("{multiline_done}data: {completed}\r\r");
        let mut state = XaiSseTransformState::default();

        let mapped =
            String::from_utf8(transform_xai_sse_chunk(&mut state, chunk.as_bytes())).unwrap();
        let event_types = mapped
            .split("\n\n")
            .filter_map(|frame| frame.strip_prefix("data: "))
            .filter_map(|payload| serde_json::from_str::<serde_json::Value>(payload).ok())
            .filter_map(|event| event["type"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();

        assert_eq!(
            event_types,
            ["response.output_item.done", "response.completed"]
        );
    }

    #[test]
    fn xai_responses_bridge_preserves_utf8_split_across_network_chunks() {
        let event = serde_json::json!({
            "type": "response.output_text.delta",
            "item_id": "message-1",
            "delta": "Chao Xiao: tiếng Việt"
        });
        let chunk = format!("data: {event}\n\n").into_bytes();
        let split = chunk
            .windows("ế".len())
            .position(|window| window == "ế".as_bytes())
            .unwrap()
            + 1;
        let mut state = XaiSseTransformState::default();

        let first = transform_xai_sse_chunk(&mut state, &chunk[..split]);
        let second = transform_xai_sse_chunk(&mut state, &chunk[split..]);
        let mapped = String::from_utf8([first, second].concat()).unwrap();
        let payload = mapped
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap();
        let mapped_event: serde_json::Value = serde_json::from_str(payload).unwrap();

        assert_eq!(mapped_event["delta"], "Chao Xiao: tiếng Việt");
    }

    #[test]
    fn xai_responses_bridge_does_not_execute_partial_tools_after_failure() {
        let item = serde_json::json!({
            "id": "item-shell",
            "type": "function_call",
            "call_id": "call-shell",
            "name": "shell_command",
            "arguments": "{\"command\":\"npm test\"}"
        });
        let done = serde_json::json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": item
        });
        let failed = serde_json::json!({
            "type": "response.failed",
            "response": {
                "id": "response-1",
                "output": [item]
            }
        });
        let chunk = format!("data: {done}\n\ndata: {failed}\n\n");
        let mut state = XaiSseTransformState::default();

        let mapped =
            String::from_utf8(transform_xai_sse_chunk(&mut state, chunk.as_bytes())).unwrap();
        let event_types = mapped
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|payload| serde_json::from_str::<serde_json::Value>(payload).ok())
            .filter_map(|event| event["type"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();

        assert_eq!(event_types, ["response.failed"]);
    }

    #[test]
    fn xai_responses_bridge_converts_webp_images_to_png() {
        let sanitized = sanitize_responses_request(serde_json::json!({
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{
                        "type": "input_image",
                        "image_url": "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
                    }]
                },
                {
                    "type": "function_call_output",
                    "call_id": "call-image",
                    "output": [{
                        "type": "input_image",
                        "image_url": "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
                    }]
                }
            ]
        }))
        .unwrap();

        assert!(sanitized["input"][0]["content"][0]["image_url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,iVBOR"));
        assert!(sanitized["input"][1]["output"][0]["image_url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,iVBOR"));
    }

    #[test]
    fn xai_responses_bridge_rejects_conversion_before_exceeding_aggregate_budget() {
        let mut request = serde_json::json!({
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_image",
                    "image_url": "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
                }]
            }]
        });
        let mut request_size = XAI_BRIDGE_MAX_REQUEST_BYTES - 1;

        let error = normalize_xai_image_inputs(&mut request, &mut request_size).unwrap_err();

        assert_eq!(error.0, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(request["input"][0]["content"][0]["image_url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/webp;base64,"));
    }

    #[test]
    fn xai_responses_bridge_rejects_unsupported_image_data_urls() {
        let error = sanitize_responses_request(serde_json::json!({
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_image",
                    "image_url": "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
                }]
            }]
        }))
        .unwrap_err();

        assert_eq!(error.0, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert!(error.1.contains("JPEG and PNG"));
    }

    #[test]
    fn xai_responses_bridge_handles_missing_or_malformed_tool_sections() {
        let request = serde_json::json!({
            "input": [{ "type": "message", "role": "user" }],
            "tools": "invalid"
        });
        assert_eq!(
            sanitize_responses_request(request.clone()).unwrap(),
            request
        );
        assert_eq!(
            sanitize_responses_request(serde_json::json!({ "tools": [] }))
                .unwrap_err()
                .0,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn xai_responses_bridge_is_listening_before_its_url_is_returned() {
        let base_url = start_responses_bridge().unwrap();
        let response = BlockingClient::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap()
            .post(format!("{base_url}/responses"))
            .body("{}")
            .send()
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
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

    #[test]
    fn profile_file_store_round_trips_large_oauth_json() {
        let directory =
            std::env::temp_dir().join(format!("xiao-xai-cred-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(directory.join("model-profiles").join("grok-large")).unwrap();
        let store = ProfileFileXaiCredentialStore::new(directory.clone());
        let value = serde_json::json!({
            "access_token": "a".repeat(2_400),
            "refresh_token": "r".repeat(2_400),
            "token_type": "Bearer",
            "scope": "openid profile email offline_access grok-cli:access api:access",
            "expires_at": 1_700_000_000_000i64,
        })
        .to_string();
        assert!(value.len() > 2_560);
        store.save("grok-large", &value).unwrap();
        assert_eq!(
            store.load("grok-large").unwrap().as_deref(),
            Some(value.as_str())
        );
        store.delete("grok-large").unwrap();
        assert_eq!(store.load("grok-large").unwrap(), None);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
