use futures_util::{SinkExt, StreamExt};
use http::Request;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::config;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct PathEntry {
    pub label: String,
    pub path: String,
}

#[derive(Debug, Deserialize, Serialize, Default)]
struct PathsFile {
    paths: Vec<PathEntry>,
}

fn paths_file() -> std::path::PathBuf {
    config::config_dir().join("paths.yaml")
}

fn load_paths() -> Vec<PathEntry> {
    match std::fs::read_to_string(paths_file()) {
        Ok(content) => serde_yaml::from_str::<PathsFile>(&content)
            .unwrap_or_default()
            .paths,
        Err(_) => vec![],
    }
}

fn save_paths(paths: &[PathEntry]) -> Result<(), String> {
    let dir = config::config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let content = serde_yaml::to_string(&PathsFile { paths: paths.to_vec() })
        .map_err(|e| e.to_string())?;

    let path = paths_file();
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }

    file.write_all(content.as_bytes()).map_err(|e| e.to_string())
}

async fn sync_to_broker(paths: &[PathEntry]) -> Result<(), String> {
    let cfg = config::load_agent_config();
    let broker_url = match cfg.broker_url {
        Some(u) => u,
        None => return Ok(()), // not configured yet — skip silently
    };
    let token = match cfg.agent_token {
        Some(t) => t,
        None => return Ok(()),
    };

    let ws_url = broker_url
        .trim_end_matches('/')
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1)
        + "/agent/connect";

    let request = Request::builder()
        .uri(&ws_url)
        .header("Authorization", format!("Bearer {}", token))
        .body(())
        .map_err(|e| e.to_string())?;

    let (mut ws, _) = connect_async(request)
        .await
        .map_err(|e| format!("Could not connect to broker: {e}"))?;

    let msg = serde_json::json!({
        "type": "config_update",
        "paths": paths.iter().map(|p| serde_json::json!({
            "label": p.label,
            "reported_path": p.path,
        })).collect::<Vec<_>>()
    });

    ws.send(Message::Text(msg.to_string().into()))
        .await
        .map_err(|e| e.to_string())?;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);

    loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .ok_or("Timed out waiting for broker sync response")?;

        let frame = tokio::time::timeout(remaining, ws.next())
            .await
            .map_err(|_| "Timed out waiting for broker sync response")?
            .ok_or("Connection closed")?
            .map_err(|e| e.to_string())?;

        if let Message::Text(text) = frame {
            let v: Value = serde_json::from_str(&text).unwrap_or_default();
            match v["type"].as_str() {
                Some("config_update_ok") => {
                    let _ = ws.close(None).await;
                    return Ok(());
                }
                Some("config_update_error") => {
                    let err = v["error"].as_str().unwrap_or("unknown error").to_string();
                    let _ = ws.close(None).await;
                    return Err(err);
                }
                _ => continue,
            }
        }
    }
}

#[tauri::command]
pub fn get_paths() -> Vec<PathEntry> {
    load_paths()
}

#[tauri::command]
pub async fn add_path(label: String, path: String) -> Result<Vec<PathEntry>, String> {
    let label = label.trim().to_string();
    let path = path.trim().to_string();

    if label.is_empty() || path.is_empty() {
        return Err("Label and path are required".to_string());
    }
    if label.contains(' ') {
        return Err("Label must not contain spaces".to_string());
    }

    let mut paths = load_paths();

    if paths.iter().any(|p| p.label == label) {
        return Err(format!("Label '{label}' already exists"));
    }

    paths.push(PathEntry { label, path });
    save_paths(&paths)?;
    sync_to_broker(&paths).await?;
    Ok(paths)
}

#[tauri::command]
pub async fn remove_path(label: String) -> Result<Vec<PathEntry>, String> {
    let mut paths = load_paths();
    let before = paths.len();
    paths.retain(|p| p.label != label);

    if paths.len() == before {
        return Err(format!("Label '{label}' not found"));
    }

    save_paths(&paths)?;
    sync_to_broker(&paths).await?;
    Ok(paths)
}
