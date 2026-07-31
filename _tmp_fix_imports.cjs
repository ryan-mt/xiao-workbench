const fs = require("fs");
const path = "src-tauri/src/xai/service.rs";
let src = fs.readFileSync(path, "utf8");
if (!src.startsWith("use std::collections::HashMap;")) {
  src = "use std::collections::HashMap;\n" + src;
}
const oldImport = `    use super::{
        app_data_dir_from_codex_home, build_codex_config, build_model_catalog,
        create_codex_profile, credential_status, normalize_xai_image_inputs, refresh_model_catalog,
        sanitize_responses_request, start_responses_bridge, validate_discovery, BlockingClient,
        OAuthDiscovery, ProfileFileXaiCredentialStore, StatusCode, StoredXaiCredential,
        TokenResponse, XaiCredentialStore, XaiOAuthService, DEFAULT_TOKEN_LIFETIME_SECONDS,
        OAUTH_REFERRER, OAUTH_SCOPES, XAI_API_BASE_URL, XAI_BRIDGE_MAX_REQUEST_BYTES,
        XAI_CLIENT_ID,
    };`;
const newImport = `    use super::{
        app_data_dir_from_codex_home, build_codex_config, build_model_catalog,
        create_codex_profile, credential_status, map_xai_response_event_to_codex,
        normalize_xai_image_inputs, refresh_model_catalog, sanitize_responses_request,
        start_responses_bridge, validate_discovery, BlockingClient, OAuthDiscovery,
        ProfileFileXaiCredentialStore, StatusCode, StoredXaiCredential, TokenResponse,
        XaiCredentialStore, XaiOAuthService, DEFAULT_TOKEN_LIFETIME_SECONDS, OAUTH_REFERRER,
        OAUTH_SCOPES, XAI_API_BASE_URL, XAI_BRIDGE_MAX_REQUEST_BYTES, XAI_CLIENT_ID,
    };`;
if (!src.includes(oldImport)) { console.error("import block missing"); process.exit(1); }
src = src.replace(oldImport, newImport);
fs.writeFileSync(path, src);
console.log("fixed imports");
