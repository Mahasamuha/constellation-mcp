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

pub fn detect_state(config: &AgentConfig) -> AgentState {
    if config.broker_url.is_none() || config.agent_token.is_none() {
        return AgentState::Unconfigured;
    }
    // Phase 3 will wire up real service status; for now assume disconnected when configured
    AgentState::Disconnected
}
