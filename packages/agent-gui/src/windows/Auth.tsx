import { useState, useEffect } from "react";
import "./Auth.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface DeviceCodeInfo {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

type AuthResult =
  | { status: "pending" }
  | { status: "success"; host: string }
  | { status: "error"; message: string }
  | { status: "timeout" };

type Step = "url" | "code" | "done" | "error";

export default function Auth() {
  const [step, setStep] = useState<Step>("url");
  const [brokerUrl, setBrokerUrl] = useState("");
  const [codeInfo, setCodeInfo] = useState<DeviceCodeInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function startFlow() {
    setLoading(true);
    setError("");
    try {
      const info = await invoke<DeviceCodeInfo>("start_device_flow", { brokerUrl: brokerUrl.trim() });
      setCodeInfo(info);
      setStep("code");
      invoke("poll_device_flow", {
        brokerUrl: brokerUrl.trim(),
        deviceCode: info.device_code,
        interval: info.interval,
        expiresIn: info.expires_in,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function copyCode() {
    if (!codeInfo) return;
    await navigator.clipboard.writeText(codeInfo.user_code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  useEffect(() => {
    if (step !== "code") return;
    let cancel = false;
    const unlisten = listen<AuthResult>("auth-result", async (event) => {
      if (cancel) return;
      const result = event.payload;
      if (result.status === "success") {
        await invoke("update_tray");
        setStep("done");
        setTimeout(() => getCurrentWindow().close(), 1500);
      } else if (result.status === "error") {
        setError(result.message);
        setStep("error");
      } else if (result.status === "timeout") {
        setError("Timed out waiting for authentication.");
        setStep("error");
      }
    });
    return () => {
      cancel = true;
      unlisten.then((f) => f());
    };
  }, [step]);

  return (
    <div className="auth-container">
      {step === "url" && (
        <>
          <h2 className="auth-heading">Connect to Broker</h2>
          <label className="auth-label">Broker URL</label>
          <input
            className="auth-input"
            type="url"
            placeholder="https://broker.example.com"
            value={brokerUrl}
            onChange={(e) => setBrokerUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && brokerUrl && startFlow()}
            autoFocus
          />
          {error && <p className="auth-error">{error}</p>}
          <button
            className="auth-btn"
            style={{ opacity: !brokerUrl || loading ? 0.5 : 1 }}
            disabled={!brokerUrl || loading}
            onClick={startFlow}
          >
            {loading ? "Connecting…" : "Continue"}
          </button>
        </>
      )}

      {step === "code" && codeInfo && (
        <>
          <h2 className="auth-heading">Authenticate</h2>
          <p className="auth-hint">Open your browser and enter this code:</p>
          <div className="auth-code-row">
            <div className="auth-code">{codeInfo.user_code}</div>
            <button className="auth-copy-btn" onClick={copyCode} title="Copy to clipboard">
              {copied ? "✓ Copied" : "Copy"}
            </button>
          </div>
          <button
            className="auth-btn"
            onClick={() => openUrl(codeInfo.verification_uri_complete)}
          >
            Open Browser
          </button>
          <p className="auth-hint auth-waiting">
            Waiting for authentication…
          </p>
        </>
      )}

      {step === "done" && (
        <>
          <h2 className="auth-heading">Connected</h2>
          <p className="auth-hint">Agent registered successfully.</p>
        </>
      )}

      {step === "error" && (
        <>
          <h2 className="auth-heading">Authentication failed</h2>
          <p className="auth-error">{error}</p>
          <button className="auth-btn" onClick={() => { setStep("url"); setError(""); }}>
            Try again
          </button>
        </>
      )}
    </div>
  );
}
