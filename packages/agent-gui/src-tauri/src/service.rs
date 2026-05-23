use serde_json::Value;
use std::process::Command;
use tauri::AppHandle;

use crate::config;

fn run_cli(args: &[&str]) -> Result<(), String> {
    let out = Command::new("constellation")
        .args(args)
        .output()
        .map_err(|e| format!("Could not run constellation CLI: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("constellation {} failed (exit {})", args.join(" "), out.status)
        } else {
            stderr
        })
    }
}

fn cli_output(args: &[&str]) -> Result<String, String> {
    let out = Command::new("constellation")
        .args(args)
        .output()
        .map_err(|e| format!("Could not run constellation CLI: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("constellation {} failed (exit {})", args.join(" "), out.status)
        } else {
            stderr
        })
    }
}

#[tauri::command]
pub async fn rotate_token(app: AppHandle) -> Result<(), String> {
    run_cli(&["agent", "rotate"])?;
    crate::refresh_tray(&app);
    Ok(())
}

#[tauri::command]
pub fn deregister_agent(app: AppHandle) -> Result<(), String> {
    let path = config::config_dir().join("agent.yaml");
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    crate::refresh_tray(&app);
    Ok(())
}

#[tauri::command]
pub fn get_service_status() -> String {
    cli_output(&["agent", "status", "--json"])
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["service"].as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

#[tauri::command]
pub fn start_agent() -> Result<(), String> {
    run_cli(&["agent", "start"])
}

#[tauri::command]
pub fn stop_agent() -> Result<(), String> {
    run_cli(&["agent", "stop"])
}

#[tauri::command]
pub fn restart_agent() -> Result<(), String> {
    run_cli(&["agent", "restart"])
}

#[tauri::command]
pub async fn get_logs(lines: u32) -> Result<String, String> {
    cli_output(&["agent", "logs", "--lines", &lines.to_string()])
}
