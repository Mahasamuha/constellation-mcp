use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter};

use crate::config;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct DeviceCodeInfo {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum AuthResult {
    Pending,
    Success { host: String },
    Error { message: String },
    Timeout,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    host: Option<String>,
    error: Option<String>,
}

#[tauri::command]
pub async fn start_device_flow(broker_url: String) -> Result<DeviceCodeInfo, String> {
    let url = format!("{}/oauth/device/code", broker_url.trim_end_matches('/'));
    let res = reqwest::Client::new()
        .post(&url)
        .form(&[("scope", "agent:register")])
        .send()
        .await
        .map_err(|e| format!("Could not reach broker: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("Broker error: {}", res.text().await.unwrap_or_default()));
    }

    res.json::<DeviceCodeInfo>()
        .await
        .map_err(|e| format!("Unexpected broker response: {e}"))
}

#[tauri::command]
pub async fn poll_device_flow(
    app: AppHandle,
    broker_url: String,
    device_code: String,
    interval: u64,
    expires_in: u64,
) {
    let client = reqwest::Client::new();
    let url = format!("{}/oauth/token", broker_url.trim_end_matches('/'));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(expires_in);

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(interval)).await;

        if std::time::Instant::now() > deadline {
            let _ = app.emit("auth-result", AuthResult::Timeout);
            return;
        }

        let res = match client
            .post(&url)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", device_code.as_str()),
            ])
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let _ = app.emit("auth-result", AuthResult::Error { message: e.to_string() });
                return;
            }
        };

        let body: TokenResponse = match res.json().await {
            Ok(b) => b,
            Err(_) => continue,
        };

        if let Some(err) = body.error {
            match err.as_str() {
                "authorization_pending" => {
                    let _ = app.emit("auth-result", AuthResult::Pending);
                    continue;
                }
                // broker asking us to back off — continue at the same interval
                "slow_down" | "rate_limit_exceeded" => continue,
                _ => {
                    let _ = app.emit("auth-result", AuthResult::Error { message: err });
                    return;
                }
            }
        }

        if let (Some(token), Some(host)) = (body.access_token, body.host) {
            if let Err(e) = write_config(
                &config::config_dir(),
                &broker_url,
                &token,
                &host,
            ) {
                let _ = app.emit("auth-result", AuthResult::Error { message: e });
                return;
            }
            let _ = app.emit("auth-result", AuthResult::Success { host });
            return;
        }
    }
}

fn write_config(dir: &Path, broker_url: &str, token: &str, host: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let path = dir.join("agent.yaml");

    let mut map = match std::fs::read_to_string(&path) {
        Ok(content) => serde_yaml::from_str::<serde_yaml::Value>(&content)
            .unwrap_or_else(|_| serde_yaml::Value::Mapping(Default::default())),
        Err(_) => serde_yaml::Value::Mapping(Default::default()),
    };

    if let serde_yaml::Value::Mapping(ref mut m) = map {
        m.insert("broker_url".into(), broker_url.into());
        m.insert("agent_token".into(), token.into());
        m.insert("host".into(), host.into());
        m.entry("max_file_size_kb".into()).or_insert(100u64.into());
    }

    let content = serde_yaml::to_string(&map).map_err(|e| e.to_string())?;
    write_secure(&path, content.as_bytes())?;

    let paths_path = dir.join("paths.yaml");
    if !paths_path.exists() {
        write_secure(&paths_path, b"paths: []\n")?;
    }

    Ok(())
}

fn write_secure(path: &Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }

    file.write_all(data).map_err(|e| e.to_string())
}
