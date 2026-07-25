use selkies_upload_sidecar::{Config, build_state, router};
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("selkies_upload_sidecar=info")),
        )
        .init();
    let config = Config::from_env().unwrap_or_else(|error| {
        eprintln!("invalid upload sidecar configuration: {error}");
        std::process::exit(2);
    });
    let listen = config.listen.clone();
    let state = build_state(config).await.unwrap_or_else(|error| {
        eprintln!("failed to initialize upload sidecar: {error}");
        std::process::exit(2);
    });
    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .unwrap_or_else(|error| {
            eprintln!("failed to bind upload sidecar on {listen}: {error}");
            std::process::exit(2);
        });
    info!(listen = %listen, "upload sidecar listening");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("upload sidecar server failed");
}
