use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
pub struct AgentConfig {
    pub broker_url: Option<String>,
    pub agent_token: Option<String>,
    pub host: Option<String>,
    pub max_file_size_kb: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    Unconfigured,
    Disconnected,
    Connecting,
    Connected,
    Error,
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("constellation")
}

pub fn load_agent_config() -> AgentConfig {
    let path = config_dir().join("agent.yaml");
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_yaml::from_str(&content).unwrap_or_default(),
        Err(_) => AgentConfig::default(),
    }
}

pub fn write_secure(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    std::fs::create_dir_all(path.parent().unwrap_or(path)).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .write(true).create(true).truncate(true)
        .open(path).map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    file.write_all(data).map_err(|e| e.to_string())
}

pub fn detect_state(config: &AgentConfig, service: &str) -> AgentState {
    if config.broker_url.is_none() || config.agent_token.is_none() {
        return AgentState::Unconfigured;
    }
    match service {
        "active" => AgentState::Connected,
        "inactive" => AgentState::Disconnected,
        _ => AgentState::Error,
    }
}
