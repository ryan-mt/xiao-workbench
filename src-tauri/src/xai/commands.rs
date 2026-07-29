use tauri::{AppHandle, Manager, State};

use crate::xiao::models::CodexProfile;
use crate::xiao::repository::XiaoRepository;

use super::models::{XaiDeviceAuthorization, XaiOAuthPollResult, XaiOAuthStatus};
use super::service::{
    create_codex_profile, is_xai_profile, mark_profile_authenticated, mark_profile_unauthenticated,
    XaiOAuthService,
};

#[tauri::command]
pub fn create_xai_codex_profile(
    client_id: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<CodexProfile, String> {
    create_codex_profile(&repository, client_id)
}

#[tauri::command]
pub async fn begin_xai_device_oauth(
    app: AppHandle,
    profile_id: String,
) -> Result<XaiDeviceAuthorization, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = app.state::<XiaoRepository>();
        let profile = repository.codex_profile(&profile_id)?;
        app.state::<XaiOAuthService>().begin(&profile)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn poll_xai_device_oauth(
    app: AppHandle,
    flow_id: String,
) -> Result<XaiOAuthPollResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = app.state::<XaiOAuthService>().poll(&flow_id)?;
        if result.state == "authorized" {
            if let Some(status) = result.status.as_ref() {
                mark_profile_authenticated(&app.state::<XiaoRepository>(), &status.profile_id)?;
            }
        }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn cancel_xai_device_oauth(
    flow_id: String,
    oauth: State<'_, XaiOAuthService>,
) -> Result<(), String> {
    oauth.cancel(&flow_id)
}

#[tauri::command]
pub async fn revoke_xai_oauth(
    app: AppHandle,
    profile_id: String,
) -> Result<XaiOAuthStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let profile = app.state::<XiaoRepository>().codex_profile(&profile_id)?;
        if !is_xai_profile(&profile) {
            return Err("The selected Codex profile is not an xAI profile.".to_owned());
        }
        let status = app.state::<XaiOAuthService>().revoke(&profile_id)?;
        mark_profile_unauthenticated(&app.state::<XiaoRepository>(), &profile_id)?;
        Ok(status)
    })
    .await
    .map_err(|error| error.to_string())?
}
