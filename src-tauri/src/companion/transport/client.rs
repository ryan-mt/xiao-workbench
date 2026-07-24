use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use reqwest::blocking::Client;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::companion::models::{
    CommandEnvelope, CommandResult, CompanionGrant, ExchangePairingRequest, ExchangedSession,
    NotificationCursor, NotificationPage, ReconnectCursor, SessionCredential, SyncBatch,
    SyncRequest,
};

use super::ImportedPairingBundle;

const KEYRING_SERVICE: &str = "xiao-companion";

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSessionReference {
    pub reference_id: String,
    pub session_id: String,
    pub device_id: String,
    pub generation: i64,
    pub endpoint: String,
    pub certificate_fingerprint: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredClientSession {
    reference: CompanionSessionReference,
    credential: SessionCredential,
    server_name: String,
    certificate_pem: String,
}

pub trait CredentialStore: Send + Sync + 'static {
    fn save(&self, reference_id: &str, value: &str) -> Result<(), String>;
    fn load(&self, reference_id: &str) -> Result<String, String>;
    fn delete(&self, reference_id: &str) -> Result<(), String>;
}

#[derive(Default)]
pub struct KeyringCredentialStore;

impl CredentialStore for KeyringCredentialStore {
    fn save(&self, reference_id: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(KEYRING_SERVICE, reference_id)
            .map_err(|error| format!("Could not open the Companion credential store: {error}"))?
            .set_password(value)
            .map_err(|error| format!("Could not save the Companion credential: {error}"))
    }

    fn load(&self, reference_id: &str) -> Result<String, String> {
        keyring::Entry::new(KEYRING_SERVICE, reference_id)
            .map_err(|error| format!("Could not open the Companion credential store: {error}"))?
            .get_password()
            .map_err(|error| format!("Could not load the Companion credential: {error}"))
    }

    fn delete(&self, reference_id: &str) -> Result<(), String> {
        keyring::Entry::new(KEYRING_SERVICE, reference_id)
            .map_err(|error| format!("Could not open the Companion credential store: {error}"))?
            .delete_credential()
            .map_err(|error| format!("Could not remove the Companion credential: {error}"))
    }
}

pub struct CompanionPinnedClient {
    credentials: Arc<dyn CredentialStore>,
}

impl CompanionPinnedClient {
    pub fn new(credentials: Arc<dyn CredentialStore>) -> Self {
        Self { credentials }
    }

    pub fn pair(
        &self,
        pairing_code: &str,
        device_id: String,
        device_name: String,
        grants: Vec<CompanionGrant>,
        now_millis: i64,
    ) -> Result<CompanionSessionReference, String> {
        let bundle = ImportedPairingBundle::from_pairing_code(pairing_code)?;
        bundle.verify_pin()?;
        if now_millis > bundle.expires_at {
            return Err("The Companion pairing bundle has expired.".to_owned());
        }
        let client = pinned_client(&bundle)?;
        let exchange: ExchangedSession = post_json(
            &client,
            &request_origin(&bundle.endpoint, &bundle.server_name)?,
            "/v1/pair",
            &ExchangePairingRequest {
                owner_credential: bundle.owner_credential,
                device_id,
                device_name,
                grants,
                now: now_millis / 1_000,
            },
        )?;
        let reference = CompanionSessionReference {
            reference_id: exchange.credential.session_id.clone(),
            session_id: exchange.credential.session_id.clone(),
            device_id: exchange.credential.device_id.clone(),
            generation: exchange.credential.generation,
            endpoint: bundle.endpoint,
            certificate_fingerprint: bundle.certificate_fingerprint,
        };
        let stored = StoredClientSession {
            reference: reference.clone(),
            credential: exchange.credential,
            server_name: bundle.server_name,
            certificate_pem: bundle.certificate_pem,
        };
        self.credentials.save(
            &reference.reference_id,
            &serde_json::to_string(&stored)
                .map_err(|error| format!("Could not encode the Companion credential: {error}"))?,
        )?;
        Ok(reference)
    }

    pub fn sync(&self, reference_id: &str, request: SyncRequest) -> Result<SyncBatch, String> {
        let stored = self.load(reference_id)?;
        self.post_authenticated(
            &stored,
            "/v1/sync",
            &AuthenticatedSync {
                credential: &stored.credential,
                sync: request,
            },
        )
    }

    pub fn reconcile(
        &self,
        reference_id: &str,
        cursor: ReconnectCursor,
    ) -> Result<SyncBatch, String> {
        let stored = self.load(reference_id)?;
        self.post_authenticated(
            &stored,
            "/v1/reconcile",
            &Reconcile {
                credential: &stored.credential,
                cursor,
            },
        )
    }

    pub fn notifications(
        &self,
        reference_id: &str,
        cursor: Option<NotificationCursor>,
        limit: Option<usize>,
    ) -> Result<NotificationPage, String> {
        let stored = self.load(reference_id)?;
        self.post_authenticated(
            &stored,
            "/v1/notifications",
            &Notifications {
                credential: &stored.credential,
                cursor,
                limit,
            },
        )
    }

    pub fn execute(
        &self,
        reference_id: &str,
        envelope: CommandEnvelope,
    ) -> Result<CommandResult, String> {
        let stored = self.load(reference_id)?;
        if envelope.session_id != stored.credential.session_id
            || envelope.device_id != stored.credential.device_id
            || envelope.session_generation != stored.credential.generation
        {
            return Err("The Companion command does not match the stored session.".to_owned());
        }
        self.post_authenticated(
            &stored,
            "/v1/commands",
            &Execute {
                credential: &stored.credential,
                envelope,
            },
        )
    }

    pub fn install_rotation(
        &self,
        reference_id: &str,
        rotation_code: &str,
    ) -> Result<CompanionSessionReference, String> {
        let stored = self.load(reference_id)?;
        let credential: SessionCredential = serde_json::from_str(rotation_code.trim())
            .map_err(|_| "The Companion rotation code is malformed.".to_owned())?;
        validate_rotation(&stored.credential, &credential)?;
        let mut candidate = stored;
        candidate.reference.generation = credential.generation;
        candidate.credential = credential;
        let _: SyncBatch = self.post_authenticated(
            &candidate,
            "/v1/sync",
            &AuthenticatedSync {
                credential: &candidate.credential,
                sync: SyncRequest {
                    cursor: None,
                    limit: Some(1),
                },
            },
        )?;
        self.credentials.save(
            reference_id,
            &serde_json::to_string(&candidate)
                .map_err(|error| format!("Could not encode the rotated credential: {error}"))?,
        )?;
        Ok(candidate.reference)
    }

    pub fn forget(&self, reference_id: &str) -> Result<(), String> {
        self.credentials.delete(reference_id)
    }

    fn load(&self, reference_id: &str) -> Result<StoredClientSession, String> {
        serde_json::from_str(&self.credentials.load(reference_id)?)
            .map_err(|error| format!("The stored Companion credential is invalid: {error}"))
    }

    fn post_authenticated<T: Serialize, R: DeserializeOwned>(
        &self,
        stored: &StoredClientSession,
        path: &str,
        request: &T,
    ) -> Result<R, String> {
        let bundle = ImportedPairingBundle {
            endpoint: stored.reference.endpoint.clone(),
            server_name: stored.server_name.clone(),
            certificate_pem: stored.certificate_pem.clone(),
            certificate_fingerprint: stored.reference.certificate_fingerprint.clone(),
            pairing_id: String::new(),
            owner_credential: String::new(),
            expires_at: i64::MAX,
        };
        bundle.verify_pin()?;
        let client = pinned_client(&bundle)?;
        post_json(
            &client,
            &request_origin(&bundle.endpoint, &bundle.server_name)?,
            path,
            request,
        )
    }
}

fn validate_rotation(
    current: &SessionCredential,
    candidate: &SessionCredential,
) -> Result<(), String> {
    if candidate.session_id != current.session_id || candidate.device_id != current.device_id {
        return Err("The rotation code belongs to a different Companion session.".to_owned());
    }
    if candidate.generation != current.generation + 1 {
        return Err(
            "The rotation code is not the next generation for this Companion session.".to_owned(),
        );
    }
    if candidate.secret.trim().is_empty() {
        return Err("The Companion rotation code has no credential secret.".to_owned());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticatedSync<'a> {
    credential: &'a SessionCredential,
    sync: SyncRequest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reconcile<'a> {
    credential: &'a SessionCredential,
    cursor: ReconnectCursor,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Notifications<'a> {
    credential: &'a SessionCredential,
    cursor: Option<NotificationCursor>,
    limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Execute<'a> {
    credential: &'a SessionCredential,
    envelope: CommandEnvelope,
}

fn pinned_client(bundle: &ImportedPairingBundle) -> Result<Client, String> {
    let certificate = reqwest::Certificate::from_pem(bundle.certificate_pem.as_bytes())
        .map_err(|error| format!("The Companion certificate is invalid: {error}"))?;
    let socket = endpoint_socket(&bundle.endpoint)?;
    Client::builder()
        .https_only(true)
        .tls_built_in_root_certs(false)
        .add_root_certificate(certificate)
        .resolve(&bundle.server_name, socket)
        .build()
        .map_err(|error| format!("Could not create the pinned Companion client: {error}"))
}

fn endpoint_socket(endpoint: &str) -> Result<SocketAddr, String> {
    let url = reqwest::Url::parse(endpoint)
        .map_err(|error| format!("The Companion endpoint is invalid: {error}"))?;
    let ip: IpAddr = url
        .host_str()
        .ok_or("The Companion endpoint has no host.")?
        .parse()
        .map_err(|_| "The Companion endpoint must contain the paired host IP address.")?;
    let port = url
        .port_or_known_default()
        .ok_or("The Companion endpoint has no port.")?;
    Ok(SocketAddr::new(ip, port))
}

fn request_origin(endpoint: &str, server_name: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(endpoint)
        .map_err(|error| format!("The Companion endpoint is invalid: {error}"))?;
    let port = url
        .port_or_known_default()
        .ok_or("The Companion endpoint has no port.")?;
    Ok(format!("https://{server_name}:{port}"))
}

fn post_json<T: Serialize, R: DeserializeOwned>(
    client: &Client,
    origin: &str,
    path: &str,
    request: &T,
) -> Result<R, String> {
    let response = client
        .post(format!("{origin}{path}"))
        .json(request)
        .send()
        .map_err(|error| format!("Could not reach the paired Xiao host: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The paired Xiao host refused the Companion request with status {}.",
            response.status()
        ));
    }
    response
        .json()
        .map_err(|error| format!("Could not decode the Xiao host response: {error}"))
}

#[cfg(test)]
mod tests {
    use super::validate_rotation;
    use crate::companion::models::SessionCredential;

    fn credential(session_id: &str, device_id: &str, generation: i64) -> SessionCredential {
        SessionCredential {
            session_id: session_id.to_owned(),
            device_id: device_id.to_owned(),
            generation,
            secret: "secret".to_owned(),
        }
    }

    #[test]
    fn rotation_requires_the_exact_session_and_next_generation() {
        let current = credential("session-1", "device-1", 3);
        validate_rotation(&current, &credential("session-1", "device-1", 4)).unwrap();
        assert!(validate_rotation(&current, &credential("session-2", "device-1", 4)).is_err());
        assert!(validate_rotation(&current, &credential("session-1", "device-2", 4)).is_err());
        assert!(validate_rotation(&current, &credential("session-1", "device-1", 5)).is_err());
    }
}
