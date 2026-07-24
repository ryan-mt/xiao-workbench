pub mod client;
pub mod router;
pub mod server;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};

use super::models::PairingCredential;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingBundle {
    pub endpoint: String,
    pub server_name: String,
    pub certificate_pem: String,
    pub certificate_fingerprint: String,
    pub pairing_id: String,
    pub owner_credential: String,
    pub expires_at: i64,
}

impl PairingBundle {
    pub fn new(
        identity: &TransportIdentity,
        credential: PairingCredential,
    ) -> Result<Self, String> {
        Ok(Self {
            endpoint: identity.endpoint.clone(),
            server_name: identity.server_name.clone(),
            certificate_pem: identity.certificate_pem.clone(),
            certificate_fingerprint: identity.certificate_fingerprint.clone(),
            pairing_id: credential.pairing_id,
            owner_credential: credential.owner_credential,
            expires_at: credential
                .expires_at
                .checked_mul(1_000)
                .ok_or("The Companion pairing expiry is outside the supported range.")?,
        })
    }

    pub fn to_pairing_code(&self) -> Result<String, String> {
        serde_json::to_string(self)
            .map_err(|error| format!("Could not encode the Companion pairing bundle: {error}"))
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPairingBundle {
    pub endpoint: String,
    pub server_name: String,
    pub certificate_pem: String,
    pub certificate_fingerprint: String,
    pub pairing_id: String,
    pub owner_credential: String,
    pub expires_at: i64,
}

impl ImportedPairingBundle {
    pub fn from_pairing_code(value: &str) -> Result<Self, String> {
        serde_json::from_str(value)
            .map_err(|error| format!("The Companion pairing code is invalid: {error}"))
    }

    pub fn verify_pin(&self) -> Result<(), String> {
        validate_https_endpoint(&self.endpoint)?;
        validate_server_name(&self.server_name)?;
        let actual = certificate_fingerprint(&self.certificate_pem);
        if !constant_time_eq(actual.as_bytes(), self.certificate_fingerprint.as_bytes()) {
            return Err(
                "The Companion certificate fingerprint does not match the pairing bundle."
                    .to_owned(),
            );
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct TransportIdentity {
    pub endpoint: String,
    pub server_name: String,
    pub certificate_pem: String,
    pub certificate_fingerprint: String,
    pub private_key_pem: String,
}

pub struct CompanionHostRuntime {
    identity: Option<TransportIdentity>,
    _server: Option<server::CompanionHttpsServer>,
    unavailable_reason: Option<String>,
}

impl CompanionHostRuntime {
    pub fn available(identity: TransportIdentity, server: server::CompanionHttpsServer) -> Self {
        Self {
            identity: Some(identity),
            _server: Some(server),
            unavailable_reason: None,
        }
    }

    pub fn unavailable(reason: String) -> Self {
        Self {
            identity: None,
            _server: None,
            unavailable_reason: Some(reason),
        }
    }

    pub fn identity(&self) -> Result<&TransportIdentity, String> {
        self.identity.as_ref().ok_or_else(|| {
            format!(
                "Companion hosting is unavailable: {}",
                self.unavailable_reason
                    .as_deref()
                    .unwrap_or("the primary host transport did not start")
            )
        })
    }
}

pub fn discover_lan_bind_address(port: u16) -> Result<SocketAddr, String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| format!("Could not inspect the primary host network: {error}"))?;
    socket
        .connect((Ipv4Addr::new(192, 0, 2, 1), 9))
        .map_err(|error| format!("Could not select a primary host network interface: {error}"))?;
    let address = socket
        .local_addr()
        .map_err(|error| format!("Could not read the primary host network address: {error}"))?;
    match address.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => {
            Ok(SocketAddr::new(IpAddr::V4(ip), port))
        }
        _ => Err("No non-loopback IPv4 interface is available for Companion hosting.".to_owned()),
    }
}

impl TransportIdentity {
    pub fn generate(endpoint: String, server_name: String) -> Result<Self, String> {
        validate_https_endpoint(&endpoint)?;
        validate_server_name(&server_name)?;
        let certified = rcgen::generate_simple_self_signed(vec![server_name.clone()])
            .map_err(|error| format!("Could not generate the Companion TLS identity: {error}"))?;
        let certificate_pem = certified.cert.pem();
        Ok(Self {
            endpoint,
            server_name,
            certificate_fingerprint: certificate_fingerprint(&certificate_pem),
            certificate_pem,
            private_key_pem: certified.signing_key.serialize_pem(),
        })
    }

    pub fn load_or_create(
        app_data_dir: &Path,
        endpoint: String,
        server_name: String,
    ) -> Result<Self, String> {
        validate_https_endpoint(&endpoint)?;
        validate_server_name(&server_name)?;
        let directory = app_data_dir.join("companion-tls");
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Could not create the Companion TLS directory: {error}"))?;
        restrict_directory(&directory)?;
        let certificate_path = directory.join("certificate.pem");
        let private_key_path = directory.join("private-key.pem");
        let server_name_path = directory.join("server-name");
        let existing = (
            certificate_path.exists(),
            private_key_path.exists(),
            server_name_path.exists(),
        );
        if existing == (true, true, true) {
            let stored_server_name = fs::read_to_string(&server_name_path).map_err(|error| {
                format!("Could not read the Companion TLS server name: {error}")
            })?;
            if stored_server_name != server_name {
                return Err(
                    "The persisted Companion certificate belongs to a different TLS server name."
                        .to_owned(),
                );
            }
            let certificate_pem = fs::read_to_string(&certificate_path)
                .map_err(|error| format!("Could not read the Companion certificate: {error}"))?;
            let private_key_pem = fs::read_to_string(&private_key_path)
                .map_err(|error| format!("Could not read the Companion private key: {error}"))?;
            return Ok(Self {
                endpoint,
                server_name,
                certificate_fingerprint: certificate_fingerprint(&certificate_pem),
                certificate_pem,
                private_key_pem,
            });
        }
        if existing != (false, false, false) {
            return Err(
                "The persisted Companion TLS identity is incomplete; manual recovery is required."
                    .to_owned(),
            );
        }
        let identity = Self::generate(endpoint, server_name.clone())?;
        atomic_private_write(&certificate_path, identity.certificate_pem.as_bytes())?;
        atomic_private_write(&private_key_path, identity.private_key_pem.as_bytes())?;
        atomic_private_write(&server_name_path, server_name.as_bytes())?;
        Ok(identity)
    }
}

pub fn certificate_fingerprint(certificate_pem: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(certificate_pem.as_bytes());
    format!("sha256:{}", hex_string(&hasher.finalize()))
}

fn validate_https_endpoint(endpoint: &str) -> Result<(), String> {
    if !endpoint.starts_with("https://") || endpoint.contains('@') {
        return Err(
            "The Companion endpoint must be an HTTPS origin without user information.".to_owned(),
        );
    }
    Ok(())
}

fn validate_server_name(server_name: &str) -> Result<(), String> {
    if server_name.trim().is_empty()
        || server_name.contains('/')
        || server_name.contains(':')
        || server_name.contains('@')
    {
        return Err("The Companion TLS server name is invalid.".to_owned());
    }
    Ok(())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0
}

fn hex_string(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn atomic_private_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let temporary = temporary_path(path);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("Could not create a Companion TLS staging file: {error}"))?;
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not persist a Companion TLS staging file: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not install the Companion TLS identity: {error}"))
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut temporary = path.as_os_str().to_os_string();
    temporary.push(format!(".{}.tmp", uuid::Uuid::now_v7()));
    PathBuf::from(temporary)
}

fn restrict_directory(_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(_path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not restrict the Companion TLS directory: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_pairing_bundle_requires_the_exact_pinned_certificate() {
        let identity = TransportIdentity::generate(
            "https://192.0.2.10:4318".to_owned(),
            "xiao-companion.local".to_owned(),
        )
        .expect("identity");
        let mut imported = ImportedPairingBundle {
            endpoint: identity.endpoint.clone(),
            server_name: identity.server_name.clone(),
            certificate_pem: identity.certificate_pem.clone(),
            certificate_fingerprint: identity.certificate_fingerprint.clone(),
            pairing_id: "pairing-1".to_owned(),
            owner_credential: "owner-once".to_owned(),
            expires_at: 1_900_000_000_000,
        };
        imported.verify_pin().expect("matching pin");

        imported.certificate_fingerprint = format!("sha256:{}", "00".repeat(32));
        assert!(imported.verify_pin().is_err());
    }

    #[test]
    fn pairing_bundle_uses_millisecond_expiry_without_exposing_the_private_key() {
        let identity = TransportIdentity::generate(
            "https://192.0.2.10:4318".to_owned(),
            "xiao-companion.local".to_owned(),
        )
        .expect("identity");
        let bundle = PairingBundle::new(
            &identity,
            PairingCredential {
                pairing_id: "pairing-1".to_owned(),
                owner_credential: "owner-once".to_owned(),
                expires_at: 1_900_000_000,
            },
        )
        .expect("bundle");
        let encoded = bundle.to_pairing_code().expect("pairing code");

        assert_eq!(bundle.expires_at, 1_900_000_000_000);
        assert!(!encoded.contains("PRIVATE KEY"));
        assert!(encoded.contains(&identity.certificate_fingerprint));
    }
}
