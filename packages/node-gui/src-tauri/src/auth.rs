use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct DeviceCodeInfo {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// Mirrors the JSON shape `constellation node auth complete` prints on its single
/// stdout line — both sides agree on `status`/`host`/`message` so this deserializes
/// straight from the CLI's output with no translation layer.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum AuthResult {
    Success { host: String },
    Error { message: String },
    Timeout,
}

/// Mirrors the JSON shape `constellation node auth device-code` prints.
#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    ok: bool,
    data: Option<DeviceCodeInfo>,
    error: Option<String>,
}

/// Requests a device code via the CLI rather than talking to the relay directly —
/// the CLI is the single implementation of the device-code client and of node.yaml
/// persistence (see `node auth device-code`/`node auth complete`), so this command
/// is a thin wrapper, not a second copy of that logic.
#[tauri::command]
pub async fn start_device_flow(relay_url: String) -> Result<DeviceCodeInfo, String> {
    let relay_url = relay_url.trim().to_string();
    let stdout = tauri::async_runtime::spawn_blocking(move || {
        crate::cli::output(&["node", "auth", "device-code", "--relay", &relay_url])
    })
    .await
    .map_err(|e| format!("Internal error: {e}"))??;

    let parsed: DeviceCodeResponse = serde_json::from_str(&stdout)
        .map_err(|e| format!("Unexpected CLI output: {e}"))?;

    if parsed.ok {
        parsed.data.ok_or_else(|| "CLI reported success with no data".to_string())
    } else {
        Err(parsed.error.unwrap_or_else(|| "Failed to start device flow".to_string()))
    }
}

/// Blocks (in a background thread, not the async runtime) on `node auth complete`,
/// which does its own polling and persists node.yaml/paths.yaml on success, then
/// emits the single terminal result as an `auth-result` event for the webview.
#[tauri::command]
pub async fn poll_device_flow(
    app: AppHandle,
    relay_url: String,
    device_code: String,
    interval: u64,
    expires_in: u64,
) {
    let relay_url = relay_url.trim().to_string();
    let interval = interval.to_string();
    let expires_in = expires_in.to_string();

    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::cli::output(&[
            "node", "auth", "complete",
            "--relay", &relay_url,
            "--device-code", &device_code,
            "--interval", &interval,
            "--expires-in", &expires_in,
        ])
    })
    .await;

    let outcome = match result {
        Ok(Ok(stdout)) => serde_json::from_str::<AuthResult>(&stdout)
            .unwrap_or_else(|e| AuthResult::Error { message: format!("Unexpected CLI output: {e}") }),
        Ok(Err(e)) => AuthResult::Error { message: e },
        Err(e) => AuthResult::Error { message: format!("Internal error: {e}") },
    };

    let _ = app.emit("auth-result", outcome);
}

// Pins the wire contract with `constellation node auth device-code`/`node auth
// complete` (packages/node/src/cli/node.ts) — these are the literal lines those
// subcommands print to stdout.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_device_code_success() {
        let line = r#"{"ok":true,"data":{"device_code":"dc-123","user_code":"ABCD-1234","verification_uri":"http://localhost:4321/activate","verification_uri_complete":"http://localhost:4321/activate?code=ABCD-1234","expires_in":30,"interval":1}}"#;
        let parsed: DeviceCodeResponse = serde_json::from_str(line).unwrap();
        assert!(parsed.ok);
        assert_eq!(parsed.data.unwrap().user_code, "ABCD-1234");
        assert!(parsed.error.is_none());
    }

    #[test]
    fn parses_device_code_failure() {
        let line = r#"{"ok":false,"error":"Refusing to connect: relay URL uses ws:// for a non-localhost host"}"#;
        let parsed: DeviceCodeResponse = serde_json::from_str(line).unwrap();
        assert!(!parsed.ok);
        assert!(parsed.data.is_none());
        assert!(parsed.error.unwrap().contains("Refusing to connect"));
    }

    #[test]
    fn parses_complete_success() {
        let line = r#"{"status":"success","host":"test-host"}"#;
        let parsed: AuthResult = serde_json::from_str(line).unwrap();
        assert!(matches!(parsed, AuthResult::Success { host } if host == "test-host"));
    }

    #[test]
    fn parses_complete_error() {
        let line = r#"{"status":"error","message":"Access denied."}"#;
        let parsed: AuthResult = serde_json::from_str(line).unwrap();
        assert!(matches!(parsed, AuthResult::Error { message } if message == "Access denied."));
    }

    #[test]
    fn parses_complete_timeout() {
        let line = r#"{"status":"timeout"}"#;
        let parsed: AuthResult = serde_json::from_str(line).unwrap();
        assert!(matches!(parsed, AuthResult::Timeout));
    }
}
