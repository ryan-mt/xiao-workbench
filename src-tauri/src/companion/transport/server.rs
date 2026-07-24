use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use tokio::task::JoinHandle;

use super::TransportIdentity;

pub struct CompanionHttpsServer {
    bind_address: SocketAddr,
    handle: axum_server::Handle,
    task: JoinHandle<Result<(), String>>,
}

impl CompanionHttpsServer {
    pub async fn start(
        bind_address: SocketAddr,
        identity: &TransportIdentity,
        router: Router,
    ) -> Result<Self, String> {
        if bind_address.ip().is_unspecified() {
            return Err(
                "Companion HTTPS must bind to an explicitly selected host interface.".to_owned(),
            );
        }
        if bind_address.port() == 0 {
            return Err("Companion HTTPS requires an explicit persisted port.".to_owned());
        }
        std::net::TcpListener::bind(bind_address)
            .map_err(|error| format!("Could not bind the Companion HTTPS endpoint: {error}"))?;
        let tls = RustlsConfig::from_pem(
            identity.certificate_pem.as_bytes().to_vec(),
            identity.private_key_pem.as_bytes().to_vec(),
        )
        .await
        .map_err(|error| format!("Could not load the Companion TLS identity: {error}"))?;
        let handle = axum_server::Handle::new();
        let server_handle = handle.clone();
        let task = tokio::spawn(async move {
            axum_server::bind_rustls(bind_address, tls)
                .handle(server_handle)
                .serve(router.into_make_service())
                .await
                .map_err(|error| format!("Companion HTTPS server stopped unexpectedly: {error}"))
        });
        Ok(Self {
            bind_address,
            handle,
            task,
        })
    }

    pub fn local_address(&self) -> Option<SocketAddr> {
        Some(self.bind_address)
    }

    pub async fn stop(self) -> Result<(), String> {
        self.handle.graceful_shutdown(Some(Duration::from_secs(5)));
        self.task
            .await
            .map_err(|error| format!("Could not join the Companion HTTPS server: {error}"))?
    }
}
