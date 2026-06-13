use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
pub struct NodeConfig {
    pub relay_url: Option<String>,
    pub node_token: Option<String>,
    pub host: Option<String>,
    pub max_file_size_kb: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeState {
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

pub fn load_node_config() -> NodeConfig {
    let path = config_dir().join("node.yaml");
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_yaml::from_str(&content).unwrap_or_default(),
        Err(_) => NodeConfig::default(),
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

pub fn detect_state(config: &NodeConfig, service: &str) -> NodeState {
    if config.relay_url.is_none() || config.node_token.is_none() {
        return NodeState::Unconfigured;
    }
    match service {
        "active" => NodeState::Connected,
        "inactive" => NodeState::Disconnected,
        _ => NodeState::Error,
    }
}
