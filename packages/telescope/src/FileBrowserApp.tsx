import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp, useHostStyleVariables, type App } from "@modelcontextprotocol/ext-apps/react";
import { Prism, escapeHtml, languageForPath } from "./prism";

interface DirNode {
  path: string;
  type: "file" | "directory" | "symlink";
}

interface LabelEntry {
  label: string;
  host: string;
}

interface StatusMessage {
  text: string;
  isError: boolean;
}

interface BrowserContextValue {
  app: App | null;
  isConnected: boolean;
  error: Error | null;
  labels: LabelEntry[];
  selectedLabel: string | null;
  selectedPath: string | null;
  fileContent: string | null;
  isEditing: boolean;
  status: StatusMessage;
  sidebarOpen: boolean;
  wordWrap: boolean;
  toggleSidebar: () => void;
  toggleWordWrap: () => void;
  selectLabel: (label: string, openPath?: string) => void;
  handleLabelChange: (value: string) => void;
  openFile: (label: string, relativePath: string) => Promise<void>;
  saveFile: (content: string) => Promise<void>;
  startEditing: () => void;
  cancelEditing: () => void;
}

// App-level context: the file browser's pieces (label picker, tree, editor)
// all read and act on the same connection/selection/content state, and the
// set of shared capabilities is expected to grow, so everything lives here
// rather than being threaded through props.
const BrowserContext = createContext<BrowserContextValue | null>(null);

function useBrowserContext(): BrowserContextValue {
  const ctx = use(BrowserContext);
  if (!ctx) throw new Error("useBrowserContext must be used within BrowserContext.Provider");
  return ctx;
}

function byTypeThenName(a: DirNode, b: DirNode): number {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
  return a.path.localeCompare(b.path);
}

function nodeName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

// MCP tool errors (e.g. an offline agent host) come back as a normal
// CallToolResult with isError:true rather than a thrown/rejected call —
// structuredContent is absent, so callers must check this before reading it.
function toolErrorMessage(result: { isError?: boolean; content?: ReadonlyArray<{ type: string; text?: string }> }): string | null {
  if (!result.isError) return null;
  return result.content?.find((c) => c.type === "text")?.text ?? "Request failed.";
}

export function FileBrowserApp() {
  const initialInput = useRef<{ label?: string; path?: string }>({});
  const [labels, setLabels] = useState<LabelEntry[]>([]);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [status, setStatusMessage] = useState<StatusMessage>({ text: "Connecting…", isError: false });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [wordWrap, setWordWrap] = useState(false);

  const setStatus = useCallback((text: string) => setStatusMessage({ text, isError: false }), []);
  const setStatusError = useCallback((text: string) => setStatusMessage({ text, isError: true }), []);

  const { app, isConnected, error } = useApp({
    appInfo: { name: "constellation-file-browser", version: "0.1.0" },
    // Declare which display modes we render correctly in — hosts may use this
    // to decide whether to honor a requestDisplayMode("pip") call.
    capabilities: { availableDisplayModes: ["pip", "inline", "fullscreen"] },
    onAppCreated: (app) => {
      app.ontoolinput = (params) => {
        initialInput.current = (params.arguments as { label?: string; path?: string } | undefined) ?? {};
      };
    },
  });

  // Sets `color-scheme` to match the host's actual theme (light/dark), so the
  // brand colors in style.css — defined via light-dark() — pick the right side.
  useHostStyleVariables(app, app?.getHostContext());

  const openFile = useCallback(
    async (label: string, relativePath: string) => {
      if (!app) return;
      setIsEditing(false);
      setStatus(`Loading ${relativePath}…`);
      const result = await app.callServerTool({ name: "read_file", arguments: { label, relative_path: relativePath } });
      const err = toolErrorMessage(result);
      if (err) {
        setSelectedPath(null);
        setFileContent(null);
        setStatusError(err);
        return;
      }
      setSelectedPath(relativePath);
      setFileContent(String(result.structuredContent?.["content"] ?? ""));
      setStatus(`${label}/${relativePath}`);
      await app.updateModelContext({
        content: [{ type: "text", text: `User has file open: ${label}/${relativePath}` }],
      });
    },
    [app, setStatus, setStatusError]
  );

  const saveFile = useCallback(
    async (content: string) => {
      if (!app || !selectedLabel || !selectedPath) return;
      setStatus(`Saving ${selectedPath}…`);
      const written = await app.callServerTool({
        name: "write_file",
        arguments: { label: selectedLabel, relative_path: selectedPath, content, mode: "overwrite" },
      });
      const writeErr = toolErrorMessage(written);
      if (writeErr) {
        setStatusError(writeErr);
        return;
      }
      // Re-read to confirm the round-trip rather than trusting the local draft.
      const reread = await app.callServerTool({
        name: "read_file",
        arguments: { label: selectedLabel, relative_path: selectedPath },
      });
      const readErr = toolErrorMessage(reread);
      if (readErr) {
        setStatusError(readErr);
        return;
      }
      setFileContent(String(reread.structuredContent?.["content"] ?? ""));
      setIsEditing(false);
      setStatus(`Saved ${selectedLabel}/${selectedPath} at ${new Date().toLocaleTimeString()}`);
    },
    [app, selectedLabel, selectedPath, setStatus, setStatusError]
  );

  const selectLabel = useCallback(
    (label: string, openPath?: string) => {
      setSelectedLabel(label);
      setSelectedPath(null);
      setFileContent(null);
      setIsEditing(false);
      setStatus(`Browsing ${label}`);
      if (openPath) void openFile(label, openPath);
    },
    [openFile, setStatus]
  );

  const handleLabelChange = useCallback(
    (value: string) => {
      if (value) {
        selectLabel(value);
      } else {
        setSelectedLabel(null);
        setSelectedPath(null);
        setFileContent(null);
        setIsEditing(false);
        setStatus("Select a label to begin.");
      }
    },
    [selectLabel, setStatus]
  );

  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
  const toggleWordWrap = useCallback(() => setWordWrap((wrap) => !wrap), []);
  const startEditing = useCallback(() => setIsEditing(true), []);
  const cancelEditing = useCallback(() => setIsEditing(false), []);

  // Prefer floating alongside the conversation (pip) so the browser stays visible
  // while the user keeps chatting; hosts that don't support it fall back to inline.
  // Guard with a ref so this fires exactly once per app instance — duplicate
  // requests can cause a visual snap-back if the host is mid-transition.
  // Per spec, View MUST check hostContext.availableDisplayModes before requesting
  // a mode change; hosts MAY silently decline undeclared or unsupported modes.
  const displayModeRequested = useRef(false);
  useEffect(() => {
    if (!app || !isConnected || displayModeRequested.current) return;
    const ctx = app.getHostContext();
    if (!ctx?.availableDisplayModes?.includes("pip")) {
      console.warn(
        "[telescope] host does not advertise pip in availableDisplayModes:",
        ctx?.availableDisplayModes,
      );
      return;
    }
    displayModeRequested.current = true;
    app.requestDisplayMode({ mode: "pip" }).then(({ mode }) => {
      if (mode !== "pip") {
        console.warn("[telescope] pip requested but host returned:", mode);
      }
    }).catch((err: unknown) => {
      console.error("[telescope] requestDisplayMode failed:", err);
    });
  }, [app, isConnected]);

  useEffect(() => {
    if (!app || !isConnected) return;
    void (async () => {
      setStatus("Loading labels…");
      const result = await app.callServerTool({ name: "list_labels", arguments: {} });
      const err = toolErrorMessage(result);
      if (err) {
        setStatusError(err);
        return;
      }
      const loaded = (result.structuredContent?.["labels"] as LabelEntry[] | undefined) ?? [];
      setLabels(loaded);

      const initial = initialInput.current;
      if (initial.label && loaded.some((l) => l.label === initial.label)) {
        selectLabel(initial.label, initial.path);
      } else {
        setStatus(loaded.length ? "Select a label to begin." : "No labels available.");
      }
    })();
  }, [app, isConnected, selectLabel, setStatus, setStatusError]);

  const context = useMemo<BrowserContextValue>(
    () => ({
      app,
      isConnected,
      error,
      labels,
      selectedLabel,
      selectedPath,
      fileContent,
      isEditing,
      status,
      sidebarOpen,
      wordWrap,
      toggleSidebar,
      toggleWordWrap,
      selectLabel,
      handleLabelChange,
      openFile,
      saveFile,
      startEditing,
      cancelEditing,
    }),
    [
      app,
      isConnected,
      error,
      labels,
      selectedLabel,
      selectedPath,
      fileContent,
      isEditing,
      status,
      sidebarOpen,
      wordWrap,
      toggleSidebar,
      toggleWordWrap,
      selectLabel,
      handleLabelChange,
      openFile,
      saveFile,
      startEditing,
      cancelEditing,
    ]
  );

  return (
    <BrowserContext value={context}>
      <FileBrowserLayout />
    </BrowserContext>
  );
}

function FileBrowserLayout() {
  const { error, labels, selectedLabel, sidebarOpen, toggleSidebar, handleLabelChange, status } = useBrowserContext();

  if (error) return <div className="status">Connection error: {error.message}</div>;

  return (
    <div className="app">
      <header className="header">
        <button className="menu-toggle" type="button" aria-label="Toggle file tree" onClick={toggleSidebar}>
          ☰
        </button>
        <select aria-label="Label" value={selectedLabel ?? ""} onChange={(e) => handleLabelChange(e.target.value)}>
          <option value="">Select a label…</option>
          {labels.map((l) => (
            <option key={l.label} value={l.label}>
              {l.label} ({l.host})
            </option>
          ))}
        </select>
      </header>
      <div className="layout">
        <nav className="sidebar" hidden={!sidebarOpen}>
          {selectedLabel && <DirectoryTree path="" />}
        </nav>
        <div className="main">
          <FileEditor />
        </div>
      </div>
      <div className={`status${status.isError ? " error" : ""}`}>
        {status.isError ? `⚠ ${status.text}` : status.text}
      </div>
    </div>
  );
}

function DirectoryTree({ path }: { path: string }) {
  const { app, selectedLabel } = useBrowserContext();
  const [nodes, setNodes] = useState<DirNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!app || !selectedLabel) return;
    let cancelled = false;
    void (async () => {
      const result = await app.callServerTool({
        name: "list_directory",
        arguments: path ? { label: selectedLabel, relative_path: path } : { label: selectedLabel },
      });
      if (cancelled) return;
      const err = toolErrorMessage(result);
      if (err) {
        setError(err);
        setNodes(null);
        return;
      }
      setError(null);
      const loaded = ((result.structuredContent?.["nodes"] as DirNode[] | undefined) ?? []).slice().sort(byTypeThenName);
      setNodes(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [app, selectedLabel, path]);

  if (error) {
    return (
      <ul className="tree">
        <li className="node error">⚠ {error}</li>
      </ul>
    );
  }

  if (nodes === null) {
    return (
      <ul className="tree">
        <li className="node loading">Loading…</li>
      </ul>
    );
  }

  return (
    <ul className="tree">
      {nodes.map((node) => (
        <TreeNode key={node.path} node={node} />
      ))}
    </ul>
  );
}

function TreeNode({ node }: { node: DirNode }) {
  const { selectedLabel, selectedPath, openFile } = useBrowserContext();
  const [expanded, setExpanded] = useState(false);
  const isDir = node.type === "directory";
  const classes = ["node", isDir ? "dir" : "file", expanded && "expanded", selectedPath === node.path && "selected"]
    .filter(Boolean)
    .join(" ");

  return (
    <li>
      <div
        className={classes}
        onClick={() => (isDir ? setExpanded((e) => !e) : void openFile(selectedLabel!, node.path))}
      >
        {nodeName(node.path)}
      </div>
      {isDir && expanded && <DirectoryTree path={node.path} />}
    </li>
  );
}

function FileEditor() {
  const {
    fileContent,
    selectedLabel,
    selectedPath,
    isEditing,
    startEditing,
    cancelEditing,
    saveFile,
    openFile,
    wordWrap,
    toggleWordWrap,
  } = useBrowserContext();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const highlighted = useMemo(() => {
    if (fileContent == null) return null;
    const language = selectedPath ? languageForPath(selectedPath) : null;
    const grammar = language ? Prism.languages[language] : undefined;
    if (!language || !grammar) return { html: escapeHtml(fileContent), language: "none" };
    return { html: Prism.highlight(fileContent, grammar, language), language };
  }, [fileContent, selectedPath]);

  // Refreshing re-fetches from the agent host, so a click puts the button on a
  // 2s cooldown rather than letting repeated clicks pile up redundant calls.
  const [refreshCooldown, setRefreshCooldown] = useState(false);
  const refreshTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current != null) window.clearTimeout(refreshTimeoutRef.current);
    };
  }, []);

  const handleRefresh = useCallback(() => {
    if (!selectedLabel || !selectedPath || refreshCooldown) return;
    setRefreshCooldown(true);
    void openFile(selectedLabel, selectedPath);
    refreshTimeoutRef.current = window.setTimeout(() => setRefreshCooldown(false), 2000);
  }, [selectedLabel, selectedPath, openFile, refreshCooldown]);

  if (fileContent == null || highlighted == null) return <pre className="viewer" />;

  if (isEditing) {
    return (
      <div className="editor">
        <textarea ref={textareaRef} className="editor-input" defaultValue={fileContent} spellCheck={false} />
        <div className="editor-actions">
          <button type="button" onClick={() => void saveFile(textareaRef.current?.value ?? "")}>
            Save
          </button>
          <button type="button" onClick={cancelEditing}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer-pane">
      <pre className={`viewer language-${highlighted.language}${wordWrap ? " wrap" : ""}`}>
        <code className={`language-${highlighted.language}`} dangerouslySetInnerHTML={{ __html: highlighted.html }} />
      </pre>
      <div className="viewer-actions">
        <button type="button" title="Refresh" aria-label="Refresh" disabled={refreshCooldown} onClick={handleRefresh}>
          ↻
        </button>
        <button
          type="button"
          className={wordWrap ? "active" : ""}
          title="Toggle word wrap"
          aria-label="Toggle word wrap"
          aria-pressed={wordWrap}
          onClick={toggleWordWrap}
        >
          ↵
        </button>
        <button type="button" title="Edit" aria-label="Edit" onClick={startEditing}>
          ✎
        </button>
      </div>
    </div>
  );
}
