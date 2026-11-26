use selkies_upload_sidecar::{Config, build_state, router};
use tracing::info;
use tracing_subscriber::EnvFilter;

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(16)
        .enable_all()
        .build()
        .expect("failed to build sidecar runtime");
    runtime.block_on(run());
}

async fn run() {
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
    let address: std::net::SocketAddr = listen.parse().unwrap_or_else(|_| {
        eprintln!("invalid runtime listen address");
        std::process::exit(2);
    });
    if !address.ip().is_loopback() {
        eprintln!("runtime sidecar must listen on loopback");
        std::process::exit(2);
    }
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
