import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp, type App } from "@modelcontextprotocol/ext-apps/react";

interface DirNode {
  path: string;
  type: "file" | "directory" | "symlink";
}

interface LabelEntry {
  label: string;
  host: string;
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
  status: string;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
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

export function FileBrowserApp() {
  const initialInput = useRef<{ label?: string; path?: string }>({});
  const [labels, setLabels] = useState<LabelEntry[]>([]);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [status, setStatus] = useState("Connecting…");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const { app, isConnected, error } = useApp({
    appInfo: { name: "constellation-file-browser", version: "0.1.0" },
    capabilities: {},
    onAppCreated: (app) => {
      app.ontoolinput = (params) => {
        initialInput.current = (params.arguments as { label?: string; path?: string } | undefined) ?? {};
      };
    },
  });

  const openFile = useCallback(
    async (label: string, relativePath: string) => {
      if (!app) return;
      setIsEditing(false);
      setStatus(`Loading ${relativePath}…`);
      const result = await app.callServerTool({ name: "read_file", arguments: { label, relative_path: relativePath } });
      setSelectedPath(relativePath);
      setFileContent(String(result.structuredContent?.["content"] ?? ""));
      setStatus(`${label}/${relativePath}`);
      await app.updateModelContext({
        content: [{ type: "text", text: `User has file open: ${label}/${relativePath}` }],
      });
    },
    [app]
  );

  const saveFile = useCallback(
    async (content: string) => {
      if (!app || !selectedLabel || !selectedPath) return;
      setStatus(`Saving ${selectedPath}…`);
      await app.callServerTool({
        name: "write_file",
        arguments: { label: selectedLabel, relative_path: selectedPath, content, mode: "overwrite" },
      });
      // Re-read to confirm the round-trip rather than trusting the local draft.
      const reread = await app.callServerTool({
        name: "read_file",
        arguments: { label: selectedLabel, relative_path: selectedPath },
      });
      setFileContent(String(reread.structuredContent?.["content"] ?? ""));
      setIsEditing(false);
      setStatus(`Saved ${selectedLabel}/${selectedPath} at ${new Date().toLocaleTimeString()}`);
    },
    [app, selectedLabel, selectedPath]
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
    [openFile]
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
    [selectLabel]
  );

  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
  const startEditing = useCallback(() => setIsEditing(true), []);
  const cancelEditing = useCallback(() => setIsEditing(false), []);

  // Prefer floating alongside the conversation (pip) so the browser stays visible
  // while the user keeps chatting; hosts that don't support it fall back to inline.
  useEffect(() => {
    if (!app || !isConnected) return;
    void (async () => {
      const { mode } = await app.requestDisplayMode({ mode: "pip" });
      if (mode !== "pip") await app.requestDisplayMode({ mode: "inline" });
    })();
  }, [app, isConnected]);

  useEffect(() => {
    if (!app || !isConnected) return;
    void (async () => {
      setStatus("Loading labels…");
      const result = await app.callServerTool({ name: "list_labels", arguments: {} });
      const loaded = (result.structuredContent?.["labels"] as LabelEntry[] | undefined) ?? [];
      setLabels(loaded);

      const initial = initialInput.current;
      if (initial.label && loaded.some((l) => l.label === initial.label)) {
        selectLabel(initial.label, initial.path);
      } else {
        setStatus(loaded.length ? "Select a label to begin." : "No labels available.");
      }
    })();
  }, [app, isConnected, selectLabel]);

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
      toggleSidebar,
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
      toggleSidebar,
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
      <div className="status">{status}</div>
    </div>
  );
}

function DirectoryTree({ path }: { path: string }) {
  const { app, selectedLabel } = useBrowserContext();
  const [nodes, setNodes] = useState<DirNode[] | null>(null);

  useEffect(() => {
    if (!app || !selectedLabel) return;
    let cancelled = false;
    void (async () => {
      const result = await app.callServerTool({
        name: "list_directory",
        arguments: path ? { label: selectedLabel, relative_path: path } : { label: selectedLabel },
      });
      if (cancelled) return;
      const loaded = ((result.structuredContent?.["nodes"] as DirNode[] | undefined) ?? []).slice().sort(byTypeThenName);
      setNodes(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [app, selectedLabel, path]);

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
  const { fileContent, isEditing, startEditing, cancelEditing, saveFile } = useBrowserContext();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const highlighted = useMemo(() => {
    if (fileContent == null || !window.hljs) return null;
    const result = window.hljs.highlightAuto(fileContent);
    return { html: result.value, language: result.language ?? "plaintext" };
  }, [fileContent]);

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
      <pre className="viewer">
        <code
          className={`hljs language-${highlighted.language}`}
          dangerouslySetInnerHTML={{ __html: highlighted.html }}
        />
      </pre>
      <button type="button" className="edit-button" onClick={startEditing}>
        Edit
      </button>
    </div>
  );
}
