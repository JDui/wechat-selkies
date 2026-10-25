fn main() {
    // tauri-build's Windows resource step does not watch bundle icons itself.
    // Recompile the EXE resources whenever the shared brand assets change.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
