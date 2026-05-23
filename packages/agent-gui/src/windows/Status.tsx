import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Status.css";

interface AgentConfig {
  broker_url?: string;
  host?: string;
  max_file_size_kb?: number;
}

type ServiceState = "active" | "inactive" | "unknown" | "loading";

export default function Status() {
  const [serviceState, setServiceState] = useState<ServiceState>("loading");
  const [config, setConfig] = useState<AgentConfig>({});
  const [logs, setLogs] = useState("");
  const [follow, setFollow] = useState(true);
  const [logsCopied, setLogsCopied] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const logsRef = useRef<HTMLDivElement>(null);

  async function refresh() {
    const [cfg, state, logText] = await Promise.all([
      invoke<AgentConfig>("get_config").catch(() => ({})),
      invoke<string>("get_service_status").catch(() => "unknown"),
      invoke<string>("get_logs", { lines: 50 }).catch(() => ""),
    ]);
    setConfig(cfg);
    setServiceState(state as ServiceState);
    setLogs(logText);
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (follow && logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs, follow]);

  async function serviceAction(action: "start" | "stop" | "restart") {
    setActionLoading(true);
    try {
      await invoke(`${action}_agent`);
      await new Promise((r) => setTimeout(r, 600));
      await refresh();
    } finally {
      setActionLoading(false);
    }
  }

  async function copyLogs() {
    await navigator.clipboard.writeText(logs);
    setLogsCopied(true);
    setTimeout(() => setLogsCopied(false), 2000);
  }

  const badgeClass =
    serviceState === "active" ? "active" :
    serviceState === "inactive" ? "inactive" : "unknown";

  const badgeLabel =
    serviceState === "loading" ? "Checking…" :
    serviceState === "active" ? "Running" :
    serviceState === "inactive" ? "Stopped" : "Unknown";

  return (
    <div className="status-container">

      {/* Service */}
      <div>
        <div className="status-section-label">Service</div>
        <div className="status-service-row">
          <span className={`status-badge ${badgeClass}`}>
            <span className="status-badge-dot" />
            {badgeLabel}
          </span>
          <div className="status-actions">
            <button
              className="status-btn"
              disabled={actionLoading || serviceState === "active"}
              onClick={() => serviceAction("start")}
            >Start</button>
            <button
              className="status-btn"
              disabled={actionLoading || serviceState === "inactive"}
              onClick={() => serviceAction("stop")}
            >Stop</button>
            <button
              className="status-btn"
              disabled={actionLoading}
              onClick={() => serviceAction("restart")}
            >Restart</button>
          </div>
        </div>
      </div>

      {/* Agent info */}
      <div>
        <div className="status-section-label">Agent</div>
        <div className="status-info-grid">
          <span className="status-info-key">Host</span>
          <span className="status-info-val">{config.host ?? "—"}</span>
          <span className="status-info-key">Broker</span>
          <span className="status-info-val">{config.broker_url ?? "—"}</span>
          <span className="status-info-key">Max file</span>
          <span className="status-info-val">{config.max_file_size_kb ?? 100} KB</span>
        </div>
      </div>

      {/* Logs */}
      <div>
        <div className="status-logs-header">
          <div className="status-section-label" style={{ marginBottom: 0 }}>Logs</div>
          <div className="status-logs-controls">
            <label>
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />
              Follow
            </label>
            <button className="status-copy-btn" onClick={copyLogs}>
              {logsCopied ? "✓ Copied" : "Copy all"}
            </button>
          </div>
        </div>
        <div className="status-logs-box" ref={logsRef}>
          {logs
            ? logs
            : <span className="status-logs-empty">No log output.</span>
          }
        </div>
      </div>

    </div>
  );
}
