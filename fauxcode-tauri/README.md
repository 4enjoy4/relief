# FauxCode Tauri package

This folder contains an optional Tauri 2 desktop wrapper for Relief. The Python build described in the main README is the verified desktop path. The Tauri installer has not been tested for this publication.

## Requirements

* Rust and Cargo.
* Microsoft C++ Build Tools with the desktop C++ workload.
* Microsoft Edge WebView2 Runtime.
* Tauri CLI version 2.
* Python for preparing the frontend.

Install a compatible Tauri CLI through Cargo or your preferred Rust toolchain setup. The Cargo manifest in `src-tauri` targets Tauri 2.

## Prepare and build

From the repository root:

```powershell
python fauxcode-tauri/prepare.py
cd fauxcode-tauri/src-tauri
cargo tauri icon ../../fauxcode-app/icon_1024.png
cargo tauri build
```

The preparation script copies the current `workbench.html` and `app` folder into `fauxcode-tauri/src`. Run it again whenever the frontend changes. These copies are generated files and are excluded from Git.

The installer output is written under `src-tauri/target/release/bundle/nsis`.

The application name and identifier are set in `src-tauri/tauri.conf.json`. The window uses the native operating system title bar.
