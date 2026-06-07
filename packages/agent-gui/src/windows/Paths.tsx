import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./Paths.css";

const MAX_INSTRUCTIONS_LENGTH = 500;
const RECOMMENDED_INSTRUCTIONS_LENGTH = 250;

interface PathEntry {
  label: string;
  path: string;
  instructions?: string;
}

export default function Paths() {
  const [paths, setPaths] = useState<PathEntry[]>([]);
  const [label, setLabel] = useState("");
  const [path, setPath] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    invoke<PathEntry[]>("get_paths").then(setPaths).catch(() => {});
  }, []);

  async function browse() {
    const selected = await open({ directory: true, multiple: false });
    if (selected) setPath(selected as string);
  }

  async function addPath() {
    setError("");
    setLoading(true);
    try {
      const trimmedInstructions = instructions.trim();
      const updated = await invoke<PathEntry[]>("add_path", {
        label,
        path,
        instructions: trimmedInstructions || undefined,
      });
      setPaths(updated);
      setLabel("");
      setPath("");
      setInstructions("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function removePath(lbl: string) {
    setRemoving(lbl);
    try {
      const updated = await invoke<PathEntry[]>("remove_path", { label: lbl });
      setPaths(updated);
    } catch (e) {
      setError(String(e));
    } finally {
      setRemoving(null);
    }
  }

  const canAdd = label.trim().length > 0 && path.trim().length > 0
    && instructions.length <= MAX_INSTRUCTIONS_LENGTH && !loading;

  return (
    <div className="paths-container">

      {/* Current paths */}
      <div>
        <div className="paths-section-label">Registered Paths</div>
        {paths.length === 0 ? (
          <p className="paths-empty">No paths configured.</p>
        ) : (
          <table className="paths-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Path</th>
                <th>Instructions</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {paths.map((p) => (
                <tr key={p.label}>
                  <td className="label-cell">{p.label}</td>
                  <td className="path-cell">{p.path}</td>
                  <td className="instructions-cell" title={p.instructions ?? ""}>
                    {p.instructions ? p.instructions : <span className="instructions-empty">—</span>}
                  </td>
                  <td>
                    <button
                      className="paths-remove-btn"
                      disabled={removing === p.label}
                      onClick={() => removePath(p.label)}
                    >
                      {removing === p.label ? "…" : "Remove"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add form */}
      <div className="paths-add-form">
        <div className="paths-section-label">Add Path</div>
        <div className="paths-add-row">
          <input
            className="paths-input label-input"
            placeholder="label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            className="paths-input"
            placeholder="/path/to/directory"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <button className="paths-browse-btn" onClick={browse}>Browse…</button>
        </div>
        <textarea
          className="paths-textarea"
          placeholder="Brief framing for MCP clients (optional) — light context on this label's purpose, not full documentation"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={3}
        />
        <div className={`paths-char-count${instructions.length > MAX_INSTRUCTIONS_LENGTH ? " over-limit" : ""}`}>
          {instructions.length} / {MAX_INSTRUCTIONS_LENGTH}
          {instructions.length > RECOMMENDED_INSTRUCTIONS_LENGTH && instructions.length <= MAX_INSTRUCTIONS_LENGTH && (
            <span className="paths-char-hint"> — recommended max is {RECOMMENDED_INSTRUCTIONS_LENGTH}; keep it brief</span>
          )}
        </div>
        {error && <p className="paths-error">{error}</p>}
        <button
          className="paths-add-btn"
          disabled={!canAdd}
          onClick={addPath}
        >
          {loading ? "Adding…" : "Add"}
        </button>
      </div>

    </div>
  );
}
