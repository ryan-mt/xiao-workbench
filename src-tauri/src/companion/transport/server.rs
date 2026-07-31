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
        let listener = std::net::TcpListener::bind(bind_address)
            .map_err(|error| format!("Could not bind the Companion HTTPS endpoint: {error}"))?;
        let tls = RustlsConfig::from_pem(
            identity.certificate_pem.as_bytes().to_vec(),
            identity.private_key_pem.as_bytes().to_vec(),
        )
        .await
        .map_err(|error| format!("Could not load the Companion TLS identity: {error}"))?;
        Self::start_bound(bind_address, listener, tls, router).await
    }

    async fn start_bound(
        bind_address: SocketAddr,
        listener: std::net::TcpListener,
        tls: RustlsConfig,
        router: Router,
    ) -> Result<Self, String> {
        let handle = axum_server::Handle::new();
        let server_handle = handle.clone();
        let mut task = tokio::spawn(async move {
            axum_server::from_tcp_rustls(listener, tls)
                .handle(server_handle)
                .serve(router.into_make_service())
                .await
                .map_err(|error| format!("Companion HTTPS server stopped unexpectedly: {error}"))
        });
        let listening = tokio::select! {
            biased;
            result = &mut task => {
                handle.shutdown();
                return Err(match result {
                    Ok(Ok(())) =>
                        "Companion HTTPS server stopped before reporting readiness.".to_owned(),
                    Ok(Err(error)) => error,
                    Err(error) =>
                        format!("Could not join the Companion HTTPS server during startup: {error}"),
                });
            }
            result = tokio::time::timeout(Duration::from_secs(5), handle.listening()) => {
                match result {
                    Ok(Some(address)) => address,
                    Ok(None) => {
                        abort_failed_start(&handle, &mut task).await;
                        return Err(
                            "Companion HTTPS server failed before reporting readiness.".to_owned()
                        );
                    }
                    Err(_) => {
                        abort_failed_start(&handle, &mut task).await;
                        return Err(
                            "Companion HTTPS server did not report readiness within 5 seconds."
                                .to_owned()
                        );
                    }
                }
            }
        };
        if listening != bind_address {
            abort_failed_start(&handle, &mut task).await;
            return Err(format!(
                "Companion HTTPS server reported {listening} instead of {bind_address}."
            ));
        }
        Ok(Self {
            bind_address: listening,
            handle,
            task,
        })
    }

    pub fn local_address(&self) -> Option<SocketAddr> {
        Some(self.bind_address)
    }

    pub fn is_running(&self) -> bool {
        !self.task.is_finished()
    }

    pub async fn stop(self) -> Result<(), String> {
        self.handle.graceful_shutdown(Some(Duration::from_secs(5)));
        self.task
            .await
            .map_err(|error| format!("Could not join the Companion HTTPS server: {error}"))?
    }
}

async fn abort_failed_start(
    handle: &axum_server::Handle,
    task: &mut JoinHandle<Result<(), String>>,
) {
    handle.shutdown();
    task.abort();
    let _ = task.await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, TcpListener};
    use std::sync::Arc;

    use axum::routing::get;
    use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};

    use crate::companion::transport::{certificate_fingerprint, CompanionHostRuntime};

    fn test_identity(bind_address: SocketAddr) -> TransportIdentity {
        TransportIdentity::generate(format!("https://{bind_address}"), "localhost".to_owned())
            .expect("transport identity")
    }

    async fn start_test_server() -> (
        TransportIdentity,
        CertificateDer<'static>,
        CompanionHttpsServer,
    ) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("loopback listener");
        let bind_address = listener.local_addr().expect("loopback address");
        let certified = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()])
            .expect("transport identity");
        let certificate_der = certified.cert.der().clone();
        let certificate_pem = certified.cert.pem();
        let identity = TransportIdentity {
            endpoint: format!("https://{bind_address}"),
            server_name: "localhost".to_owned(),
            certificate_fingerprint: certificate_fingerprint(&certificate_pem),
            certificate_pem,
            private_key_pem: certified.signing_key.serialize_pem(),
        };
        let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("TLS protocol versions")
        .with_no_client_auth()
        .with_single_cert(
            vec![certificate_der.clone()],
            PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der()).into(),
        )
        .expect("TLS server config");
        config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        let server = CompanionHttpsServer::start_bound(
            bind_address,
            listener,
            RustlsConfig::from_config(Arc::new(config)),
            Router::new().route("/", get(|| async { "ready" })),
        )
        .await
        .expect("HTTPS server");
        (identity, certificate_der, server)
    }

    #[tokio::test]
    async fn occupied_loopback_address_is_rejected() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("occupied listener");
        let bind_address = listener.local_addr().expect("occupied address");
        let identity = test_identity(bind_address);

        let error = CompanionHttpsServer::start(bind_address, &identity, Router::new())
            .await
            .err()
            .expect("occupied address must fail");

        assert!(error.contains("Could not bind the Companion HTTPS endpoint"));
    }

    #[tokio::test]
    async fn successful_start_returns_after_https_is_live_and_running() {
        let (identity, certificate_der, server) = start_test_server().await;
        let bind_address = server.local_address().expect("server address");

        assert!(server.is_running());
        let mut roots = rustls::RootCertStore::empty();
        roots.add(certificate_der).expect("server certificate");
        let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("TLS protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
        config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        let client = reqwest::Client::builder()
            .https_only(true)
            .use_preconfigured_tls(config)
            .resolve(&identity.server_name, bind_address)
            .no_proxy()
            .build()
            .expect("HTTPS client");
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            client
                .get(format!(
                    "https://{}:{}/",
                    identity.server_name,
                    bind_address.port()
                ))
                .send(),
        )
        .await
        .expect("HTTPS request timed out")
        .expect("HTTPS response");

        assert!(response.status().is_success());
        assert_eq!(response.text().await.expect("response body"), "ready");
        server.stop().await.expect("server stop");
    }

    #[tokio::test]
    async fn graceful_stop_completes_cleanly() {
        let (_, _, server) = start_test_server().await;

        server.stop().await.expect("graceful stop");
    }

    #[tokio::test]
    async fn host_identity_fails_closed_after_server_task_is_aborted() {
        let (identity, _, server) = start_test_server().await;
        let runtime = CompanionHostRuntime::available(identity, server);
        runtime.server.as_ref().expect("host server").task.abort();
        tokio::time::timeout(Duration::from_secs(1), async {
            while runtime.server.as_ref().expect("host server").is_running() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("aborted server task did not finish");

        let error = runtime
            .identity()
            .err()
            .expect("finished host server must hide its identity");
        assert_eq!(
            error,
            "Companion hosting is unavailable: the primary host transport stopped."
        );
        assert!(!error.contains("PRIVATE KEY"));
    }
}
