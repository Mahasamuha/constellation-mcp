import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Settings.css";

interface AgentConfig {
  broker_url?: string;
  host?: string;
  max_file_size_kb?: number;
}

export default function Settings() {
  const [original, setOriginal] = useState<AgentConfig>({});
  const [brokerUrl, setBrokerUrl] = useState("");
  const [host, setHost] = useState("");
  const [maxFileSizeKb, setMaxFileSizeKb] = useState(100);
  const [configDir, setConfigDir] = useState("");
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [deregistering, setDeregistering] = useState(false);
  const [dangerOpen, setDangerOpen] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    invoke<AgentConfig>("get_config").then((cfg) => {
      setOriginal(cfg);
      setBrokerUrl(cfg.broker_url ?? "");
      setHost(cfg.host ?? "");
      setMaxFileSizeKb(cfg.max_file_size_kb ?? 100);
    });
    invoke<string>("get_config_dir").then(setConfigDir);
  }, []);

  const brokerUrlChanged = brokerUrl.trim() !== (original.broker_url ?? "");

  async function save() {
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      await invoke("save_settings", {
        brokerUrl: brokerUrl.trim(),
        host: host.trim(),
        maxFileSizeKb,
      });
      setOriginal({ broker_url: brokerUrl.trim(), host: host.trim(), max_file_size_kb: maxFileSizeKb });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function rotateToken() {
    setError("");
    setRotating(true);
    try {
      await invoke("rotate_token");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(String(e));
    } finally {
      setRotating(false);
    }
  }

  async function deregister() {
    setDeregistering(true);
    setError("");
    try {
      await invoke("deregister_agent");
    } catch (e) {
      setError(String(e));
      setDeregistering(false);
    }
  }

  return (
    <div className="settings-container">

      <div className="settings-section">
        <div className="settings-section-label">Connection</div>
        <div className="settings-field">
          <label className="settings-label">Broker URL</label>
          <input
            className="settings-input"
            value={brokerUrl}
            onChange={(e) => setBrokerUrl(e.target.value)}
            placeholder="https://broker.example.com"
          />
          {brokerUrlChanged && (
            <p className="settings-warn">Restart the agent service for this change to take effect.</p>
          )}
        </div>
        <div className="settings-field">
          <label className="settings-label">Agent Name</label>
          <input
            className="settings-input"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="my-machine"
          />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-label">Limits</div>
        <div className="settings-field settings-field--inline">
          <label className="settings-label">Max File Size (KB)</label>
          <input
            className="settings-input settings-input--narrow"
            type="number"
            min={1}
            max={100}
            value={maxFileSizeKb}
            onChange={(e) => setMaxFileSizeKb(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-label">Info</div>
        <div className="settings-field">
          <label className="settings-label">Config Directory</label>
          <span className="settings-readonly">{configDir}</span>
        </div>
      </div>

      {error && <p className="settings-error">{error}</p>}
      {saved && <p className="settings-saved">Saved.</p>}

      <div className="settings-actions">
        <button className="settings-save-btn" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="settings-rotate-btn" disabled={rotating} onClick={rotateToken}>
          {rotating ? "Rotating…" : "Rotate Token…"}
        </button>
      </div>

      <div className="settings-danger-zone">
        <button className="settings-danger-toggle" onClick={() => setDangerOpen((o) => !o)}>
          {dangerOpen ? "▾" : "▸"} Danger Zone
        </button>
        {dangerOpen && (
          <div className="settings-danger-body">
            <p className="settings-danger-desc">
              Clears your agent token and broker URL. You will need to reconnect to use Constellation again.
            </p>
            <button
              className="settings-deregister-btn"
              disabled={deregistering}
              onClick={deregister}
            >
              {deregistering ? "Deregistering…" : "Deregister Agent"}
            </button>
          </div>
        )}
      </div>

    </div>
  );
}
