use futures_util::{SinkExt, StreamExt};
use http::Request;
use serde_json::Value;
use tauri::AppHandle;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::config;

#[tauri::command]
pub async fn rotate_token(app: AppHandle) -> Result<String, String> {
    let cfg = config::load_agent_config();
    let broker_url = cfg.broker_url.ok_or("No broker URL configured")?;
    let token = cfg.agent_token.ok_or("No agent token configured")?;

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

    ws.send(Message::Text(r#"{"type":"rotate_token"}"#.to_string().into()))
        .await
        .map_err(|e| e.to_string())?;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);

    loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .ok_or("Timed out waiting for token rotation response")?;

        let msg = tokio::time::timeout(remaining, ws.next())
            .await
            .map_err(|_| "Timed out waiting for token rotation response")?
            .ok_or("Connection closed")?
            .map_err(|e| e.to_string())?;

        if let Message::Text(text) = msg {
            let v: Value = serde_json::from_str(&text).unwrap_or_default();
            if v["type"] == "token_rotated" {
                let new_token = v["token"]
                    .as_str()
                    .ok_or("Missing token in rotation response")?
                    .to_string();
                let _ = ws.close(None).await;
                write_token(&new_token)?;
                crate::refresh_tray(&app);
                return Ok(new_token);
            }
        }
    }
}

#[tauri::command]
pub fn deregister_agent(app: AppHandle) -> Result<(), String> {
    let dir = config::config_dir();
    let path = dir.join("agent.yaml");
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    crate::refresh_tray(&app);
    Ok(())
}

const SERVICE_NAME: &str = "constellation-agent";

#[tauri::command]
pub fn get_service_status() -> String {
    #[cfg(target_os = "linux")]
    {
        run_output("systemctl", &["--user", "is-active", SERVICE_NAME])
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "inactive".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        run_output("launchctl", &["list", "com.constellation.agent"])
            .map(|s| if s.contains("\"PID\"") { "active".to_string() } else { "inactive".to_string() })
            .unwrap_or_else(|_| "inactive".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        run_output("schtasks", &["/Query", "/TN", SERVICE_NAME, "/FO", "LIST"])
            .map(|s| if s.contains("Running") { "active".to_string() } else { "inactive".to_string() })
            .unwrap_or_else(|_| "inactive".to_string())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    "unknown".to_string()
}

#[tauri::command]
pub fn start_agent() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return run_void("systemctl", &["--user", "start", SERVICE_NAME]);
    #[cfg(target_os = "macos")]
    return run_void("launchctl", &["load", &launchd_plist()]);
    #[cfg(target_os = "windows")]
    return run_void("schtasks", &["/Run", "/TN", SERVICE_NAME]);
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    Err("Unsupported platform".to_string())
}

#[tauri::command]
pub fn stop_agent() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return run_void("systemctl", &["--user", "stop", SERVICE_NAME]);
    #[cfg(target_os = "macos")]
    return run_void("launchctl", &["unload", &launchd_plist()]);
    #[cfg(target_os = "windows")]
    return run_void("schtasks", &["/End", "/TN", SERVICE_NAME]);
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    Err("Unsupported platform".to_string())
}

#[tauri::command]
pub fn restart_agent() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return run_void("systemctl", &["--user", "restart", SERVICE_NAME]);
    #[cfg(target_os = "macos")]
    {
        run_void("launchctl", &["unload", &launchd_plist()])?;
        return run_void("launchctl", &["load", &launchd_plist()]);
    }
    #[cfg(target_os = "windows")]
    {
        let _ = run_void("schtasks", &["/End", "/TN", SERVICE_NAME]);
        return run_void("schtasks", &["/Run", "/TN", SERVICE_NAME]);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    Err("Unsupported platform".to_string())
}

#[tauri::command]
pub async fn get_logs(lines: u32) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        run_output("journalctl", &[
            "--user", "-u", SERVICE_NAME,
            "-n", &lines.to_string(),
            "--no-pager",
            "--output=short-iso",
        ])
    }
    #[cfg(target_os = "macos")]
    {
        let log_path = dirs::home_dir()
            .unwrap_or_default()
            .join("Library/Logs/constellation-agent.log");
        run_output("tail", &["-n", &lines.to_string(), log_path.to_str().unwrap_or("")])
    }
    #[cfg(target_os = "windows")]
    {
        Err("Log tailing not supported on Windows".to_string())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    Err("Unsupported platform".to_string())
}

fn run_output(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn run_void(cmd: &str, args: &[&str]) -> Result<(), String> {
    std::process::Command::new(cmd)
        .args(args)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn launchd_plist() -> String {
    dirs::home_dir()
        .unwrap_or_default()
        .join("Library/LaunchAgents/com.constellation.agent.plist")
        .to_string_lossy()
        .into_owned()
}

fn write_token(token: &str) -> Result<(), String> {
    use std::io::Write;

    let dir = config::config_dir();
    let path = dir.join("agent.yaml");

    let mut map = match std::fs::read_to_string(&path) {
        Ok(content) => serde_yaml::from_str::<serde_yaml::Value>(&content)
            .unwrap_or_else(|_| serde_yaml::Value::Mapping(Default::default())),
        Err(_) => serde_yaml::Value::Mapping(Default::default()),
    };

    if let serde_yaml::Value::Mapping(ref mut m) = map {
        m.insert("agent_token".into(), token.into());
    }

    let content = serde_yaml::to_string(&map).map_err(|e| e.to_string())?;

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
