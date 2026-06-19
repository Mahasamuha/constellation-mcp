import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Status.css";

interface NodeConfig {
  relay_url?: string;
  host?: string;
}

interface NodeRelayInfo {
  connected: boolean;
  last_heartbeat_at: string | null;
  last_disconnect_reason: string | null;
  registered_at: string | null;
  token_last_used_at: string | null;
}

type ServiceState = "active" | "inactive" | "unknown" | "loading";
type ConnectionState = "connected" | "connecting" | "disconnected" | "error";

function getConnectionState(service: ServiceState, ri: NodeRelayInfo | null): ConnectionState {
  if (ri) {
    if (ri.connected) return "connected";
    const r = ri.last_disconnect_reason;
    if (r === "error" || r === "timeout") return "error";
    if (service === "active") return "connecting";
    return "disconnected";
  }
  return service === "active" ? "connected" : "disconnected";
}

function timeAgo(iso: string, now: number): string {
  const diff = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

const CONN_CLASS: Record<ConnectionState, string> = {
  connected: "active",
  connecting: "unknown",
  disconnected: "inactive",
  error: "error",
};

const CONN_LABEL: Record<ConnectionState, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  disconnected: "Disconnected",
  error: "Disconnected (error)",
};

export default function Status() {
  const [serviceState, setServiceState] = useState<ServiceState>("loading");
  const [config, setConfig] = useState<NodeConfig>({});
  const [relayInfo, setRelayInfo] = useState<NodeRelayInfo | null>(null);
  const [logs, setLogs] = useState("");
  const [follow, setFollow] = useState(true);
  const [logsCopied, setLogsCopied] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const logsRef = useRef<HTMLDivElement>(null);

  async function refresh() {
    const [cfg, state, logText, ri] = await Promise.all([
      invoke<NodeConfig>("get_config").catch(() => ({})),
      invoke<string>("get_service_status").catch(() => "unknown"),
      invoke<string>("get_logs", { lines: 50 }).catch(() => ""),
      invoke<NodeRelayInfo | null>("get_node_relay_info").catch(() => null),
    ]);
    setConfig(cfg);
    setServiceState(state as ServiceState);
    setLogs(logText);
    setRelayInfo(ri);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
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
      await invoke(`${action}_node`);
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

  const connState = getConnectionState(serviceState, relayInfo);
  const showDisconnect =
    relayInfo?.last_disconnect_reason &&
    connState !== "connected" &&
    connState !== "connecting";

  const svcClass = serviceState === "active" ? "active"
    : serviceState === "inactive" ? "inactive" : "unknown";
  const svcLabel = serviceState === "loading" ? "Checking…"
    : serviceState === "active" ? "Running"
    : serviceState === "inactive" ? "Stopped" : "Unknown";

  return (
    <div className="status-container">

      {/* Connection */}
      <div>
        <div className="status-section-label">Connection</div>
        <div className="status-service-row">
          <span className={`status-badge ${CONN_CLASS[connState]}`}>
            <span className="status-badge-dot" />
            {CONN_LABEL[connState]}
          </span>
        </div>
        <div className="status-info-grid" style={{ marginTop: "0.5rem" }}>
          <span className="status-info-key">Relay</span>
          <span className="status-info-val">{config.relay_url ?? "—"}</span>
          {relayInfo?.last_heartbeat_at && (
            <>
              <span className="status-info-key">Last seen</span>
              <span className="status-info-val">{timeAgo(relayInfo.last_heartbeat_at, now)}</span>
            </>
          )}
          {showDisconnect && (
            <>
              <span className="status-info-key">Disconnect</span>
              <span className="status-info-val">{relayInfo!.last_disconnect_reason}</span>
            </>
          )}
        </div>
      </div>

      {/* Node */}
      <div>
        <div className="status-section-label">Node</div>
        <div className="status-info-grid">
          <span className="status-info-key">Host</span>
          <span className="status-info-val">{config.host ?? "—"}</span>
          <span className="status-info-key">Registered</span>
          <span className="status-info-val">{fmtDate(relayInfo?.registered_at)}</span>
          <span className="status-info-key">Token used</span>
          <span className="status-info-val">{fmtDate(relayInfo?.token_last_used_at)}</span>
        </div>
      </div>

      {/* Service */}
      <div>
        <div className="status-section-label">Service</div>
        <div className="status-service-row">
          <span className={`status-badge ${svcClass}`}>
            <span className="status-badge-dot" />
            {svcLabel}
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
          {logs ? logs : <span className="status-logs-empty">No log output.</span>}
        </div>
      </div>

    </div>
  );
}
