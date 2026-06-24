import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp, useHostStyleVariables, type App } from "@modelcontextprotocol/ext-apps/react";
import { highlightForPath } from "./prism";

type DisplayMode = "inline" | "fullscreen" | "pip";

const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = { inline: "Inline", fullscreen: "Fullscreen", pip: "PIP" };
const ALL_DISPLAY_MODES: readonly DisplayMode[] = ["inline", "fullscreen", "pip"];

// SVG instead of Unicode glyphs (▭ ⛶ ▣): symbol-character glyphs aren't
// vertically centered within their own em-box consistently across fonts/
// platforms, so flex-centering the button doesn't actually center what you
// see. A fixed viewBox sidesteps that — we own the geometry outright.
function DisplayModeIcon({ mode }: { mode: DisplayMode }) {
  if (mode === "fullscreen") {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 9V4h5" />
        <path d="M15 4h5v5" />
        <path d="M20 15v5h-5" />
        <path d="M9 20H4v-5" />
      </svg>
    );
  }
  if (mode === "pip") {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

function WordWrapIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 12 9 17 20 6" />
    </svg>
  );
}

function CancelIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

function FolderClosedIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h5l2 2h9v10H3z" />
    </svg>
  );
}

function FolderOpenIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h5l2 2h9v8L1 20H3z" />
    </svg>
  );
}

interface DirNode {
  path: string;
  type: "file" | "directory" | "symlink";
}

interface ShareEntry {
  share: string;
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
  shares: ShareEntry[];
  selectedShare: string | null;
  selectedHost: string | null;
  selectedPath: string | null;
  fileContent: string | null;
  isLoadingFile: boolean;
  isEditing: boolean;
  status: StatusMessage;
  sidebarOpen: boolean;
  wordWrap: boolean;
  displayMode: DisplayMode;
  availableDisplayModes: DisplayMode[];
  requestDisplayModeChange: (mode: DisplayMode) => void;
  toggleSidebar: () => void;
  toggleWordWrap: () => void;
  selectShare: (share: string, host: string, openPath?: string, deferSidebarCollapse?: boolean) => void;
  handleShareChange: (value: string) => void;
  openFile: (share: string, host: string, relativePath: string, opts?: { deferSidebarCollapse?: boolean }) => Promise<void>;
  saveFile: (content: string) => Promise<void>;
  startEditing: () => void;
  cancelEditing: () => void;
}

// App-level context: the file browser's pieces (share picker, tree, editor)
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

// Spaces out slashes so path segments are easier to pick out when read
// sideways in the collapsed sidebar bar — tightly-kerned "/" reads as noise
// rotated 90°.
function spacedPath(path: string): string {
  return path.replace(/\//g, " / ");
}

// A hub share name isn't unique across hosts (see ADR 0017) — list_shares
// can return e.g. "constellation-project" on both "sirius" and "milky-way".
// The <select>'s option value must encode both, or selecting the second
// entry silently resolves to whichever one happens to come first in the
// array.
function shareKey(share: string, host: string): string {
  return `${share}::${host}`;
}

// MCP tool errors (e.g. an offline agent host) come back as a normal
// CallToolResult with isError:true rather than a thrown/rejected call —
// structuredContent is absent, so callers must check this before reading it.
function toolErrorMessage(result: { isError?: boolean; content?: ReadonlyArray<{ type: string; text?: string }> }): string | null {
  if (!result.isError) return null;
  return result.content?.find((c) => c.type === "text")?.text ?? "Request failed.";
}

// Unlike the isError:true result path above, transport failure/timeout/connection loss
// makes callServerTool/updateModelContext *throw* instead of resolving — every call site
// needs to turn that into the same displayable string.
function transportErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function FileBrowserApp() {
  const initialInput = useRef<{ share?: string; path?: string }>({});
  // Bumped at the start of every openFile() call; a call only applies its result if
  // this still equals the value it captured when it started — otherwise a newer
  // openFile() call has superseded it, and its (possibly out-of-order) response is stale.
  const openFileSeq = useRef(0);
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [selectedShare, setSelectedShare] = useState<string | null>(null);
  const [selectedHost, setSelectedHost] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [status, setStatusMessage] = useState<StatusMessage>({ text: "Connecting…", isError: false });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [wordWrap, setWordWrap] = useState(false);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const [availableDisplayModes, setAvailableDisplayModes] = useState<DisplayMode[]>(["inline"]);

  const setStatus = useCallback((text: string) => setStatusMessage({ text, isError: false }), []);
  const setStatusError = useCallback((text: string) => setStatusMessage({ text, isError: true }), []);

  const { app, isConnected, error } = useApp({
    appInfo: { name: "constellation-file-browser", version: "0.1.0" },
    // Declare which display modes we render correctly in — hosts may use this
    // to decide whether to honor a requestDisplayMode("pip") call.
    capabilities: { availableDisplayModes: ["pip", "inline", "fullscreen"] },
    onAppCreated: (app) => {
      app.ontoolinput = (params) => {
        initialInput.current = (params.arguments as { share?: string; path?: string } | undefined) ?? {};
      };
    },
  });

  // Sets `color-scheme` to match the host's actual theme (light/dark), so the
  // brand colors in style.css — defined via light-dark() — pick the right side.
  useHostStyleVariables(app, app?.getHostContext());

  const openFile = useCallback(
    async (share: string, host: string, relativePath: string, opts: { deferSidebarCollapse?: boolean } = {}) => {
      if (!app) return;
      const seq = ++openFileSeq.current;
      setIsEditing(false);
      setIsLoadingFile(true);
      // Normally the sidebar collapses immediately, concurrent with the load
      // starting. The one exception is the initial bootstrap open (see the
      // selectShare call below) — there we want the tree to stay visible
      // until this load finishes, as a one-time visual cue for new users
      // that the bar is what they tap to bring the picker back.
      if (!opts.deferSidebarCollapse) setSidebarOpen(false);
      setStatus(`Loading ${relativePath}…`);
      let result;
      try {
        result = await app.callServerTool({ name: "read_file", arguments: { share, host, relative_path: relativePath } });
      } catch (e) {
        // Transport failure/timeout/connection loss throws here instead of resolving
        // with isError:true — without this, the status bar is left at "Loading…" forever.
        if (openFileSeq.current !== seq) return;
        setSelectedPath(null);
        setFileContent(null);
        setIsLoadingFile(false);
        setSidebarOpen(true);
        setStatusError(transportErrorMessage(e));
        return;
      }
      // A newer openFile() call started while this one was in flight — its result (this
      // one) is stale and arrived out of order. Bail out before touching any state; the
      // newer call owns the loading/error/content state from here.
      if (openFileSeq.current !== seq) return;
      const err = toolErrorMessage(result);
      if (err) {
        setSelectedPath(null);
        setFileContent(null);
        setIsLoadingFile(false);
        setSidebarOpen(true);
        setStatusError(err);
        return;
      }
      setSelectedPath(relativePath);
      setFileContent(String(result.structuredContent?.["content"] ?? ""));
      setIsLoadingFile(false);
      if (opts.deferSidebarCollapse) setSidebarOpen(false);
      setStatus("");
      try {
        await app.updateModelContext({
          content: [{ type: "text", text: `User has file open: ${share}/${relativePath}` }],
        });
      } catch (e) {
        // Best-effort notification to the host/model — the file genuinely is open even
        // if this fails, so don't roll the UI back to "no file selected" over it.
        console.error("[telescope] updateModelContext failed:", e);
      }
    },
    [app, setStatus, setStatusError]
  );

  const saveFile = useCallback(
    async (content: string) => {
      if (!app || !selectedShare || !selectedHost || !selectedPath) return;
      setStatus(`Saving ${selectedPath}…`);
      try {
        const written = await app.callServerTool({
          name: "write_file",
          arguments: { share: selectedShare, host: selectedHost, relative_path: selectedPath, content, mode: "overwrite" },
        });
        const writeErr = toolErrorMessage(written);
        if (writeErr) {
          setStatusError(writeErr);
          return;
        }
        // Re-read to confirm the round-trip rather than trusting the local draft.
        const reread = await app.callServerTool({
          name: "read_file",
          arguments: { share: selectedShare, host: selectedHost, relative_path: selectedPath },
        });
        const readErr = toolErrorMessage(reread);
        if (readErr) {
          setStatusError(readErr);
          return;
        }
        setFileContent(String(reread.structuredContent?.["content"] ?? ""));
        setIsEditing(false);
        setStatus(`Saved ${selectedShare}/${selectedPath} at ${new Date().toLocaleTimeString()}`);
      } catch (e) {
        // Transport failure/timeout/connection loss throws here instead of resolving
        // with isError:true — without this, the status bar is left at "Saving…" forever.
        setStatusError(transportErrorMessage(e));
      }
    },
    [app, selectedShare, selectedHost, selectedPath, setStatus, setStatusError]
  );

  const selectShare = useCallback(
    (share: string, host: string, openPath?: string, deferSidebarCollapse?: boolean) => {
      setSelectedShare(share);
      setSelectedHost(host);
      setSelectedPath(null);
      setFileContent(null);
      setIsEditing(false);
      setSidebarOpen(true);
      setStatus(`Browsing ${share}`);
      if (openPath) void openFile(share, host, openPath, { deferSidebarCollapse });
    },
    [openFile, setStatus]
  );

  const handleShareChange = useCallback(
    (value: string) => {
      const match = shares.find((s) => shareKey(s.share, s.host) === value);
      if (match) {
        selectShare(match.share, match.host);
      } else {
        setSelectedShare(null);
        setSelectedHost(null);
        setSelectedPath(null);
        setFileContent(null);
        setIsEditing(false);
        setSidebarOpen(true);
        setStatus("Select a share to begin.");
      }
    },
    [shares, selectShare, setStatus]
  );

  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
  const toggleWordWrap = useCallback(() => setWordWrap((wrap) => !wrap), []);
  const startEditing = useCallback(() => setIsEditing(true), []);
  const cancelEditing = useCallback(() => setIsEditing(false), []);

  // User-initiated mode switch (e.g. the header buttons below). Unlike the
  // auto pip request, this can be called repeatedly — the spec's own
  // reference pattern is exactly "toggle between modes via a button," not a
  // one-shot handshake. Still gated on availableDisplayModes per spec.
  const requestDisplayModeChange = useCallback(
    (mode: DisplayMode) => {
      if (!app || !availableDisplayModes.includes(mode)) return;
      app.requestDisplayMode({ mode }).then(({ mode: granted }) => {
        setDisplayMode(granted);
        if (granted !== mode) {
          console.warn("[telescope] requested display mode", mode, "but host returned:", granted);
        }
      }).catch((err: unknown) => {
        console.error("[telescope] requestDisplayMode failed:", err);
      });
    },
    [app, availableDisplayModes]
  );

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
      setDisplayMode(mode);
      if (mode !== "pip") {
        console.warn("[telescope] pip requested but host returned:", mode);
      }
    }).catch((err: unknown) => {
      console.error("[telescope] requestDisplayMode failed:", err);
    });
  }, [app, isConnected]);

  // Track the live displayMode and availableDisplayModes (initial value, plus
  // changes the host pushes on its own, e.g. the user resizing/closing a pip
  // window) so style.css can size .app accordingly via [data-display-mode] on
  // <html>, and so the manual mode-switch buttons below know what to offer.
  useEffect(() => {
    if (!app || !isConnected) return;
    const ctx = app.getHostContext();
    if (ctx?.displayMode) setDisplayMode(ctx.displayMode);
    if (ctx?.availableDisplayModes) setAvailableDisplayModes(ctx.availableDisplayModes);
  }, [app, isConnected]);

  useEffect(() => {
    if (!app) return;
    const handleContextChange = (ctx: { displayMode?: DisplayMode; availableDisplayModes?: DisplayMode[] }) => {
      if (ctx.displayMode) setDisplayMode(ctx.displayMode);
      if (ctx.availableDisplayModes) setAvailableDisplayModes(ctx.availableDisplayModes);
    };
    app.addEventListener("hostcontextchanged", handleContextChange);
    return () => app.removeEventListener("hostcontextchanged", handleContextChange);
  }, [app]);

  useEffect(() => {
    document.documentElement.dataset.displayMode = displayMode;
  }, [displayMode]);

  useEffect(() => {
    if (!app || !isConnected) return;
    void (async () => {
      setStatus("Loading shares…");
      let result;
      try {
        result = await app.callServerTool({ name: "list_shares", arguments: {} });
      } catch (e) {
        // Transport failure/timeout/connection loss throws here instead of resolving
        // with isError:true — without this, the status bar is left at "Loading…" forever.
        setStatusError(transportErrorMessage(e));
        return;
      }
      const err = toolErrorMessage(result);
      if (err) {
        setStatusError(err);
        return;
      }
      const loaded = (result.structuredContent?.["shares"] as ShareEntry[] | undefined) ?? [];
      setShares(loaded);

      const initial = initialInput.current;
      const match = initial.share ? loaded.find((s) => s.share === initial.share) : undefined;
      if (match) {
        selectShare(match.share, match.host, initial.path, true);
      } else {
        setStatus(loaded.length ? "Select a share to begin." : "No shares available.");
      }
    })();
  }, [app, isConnected, selectShare, setStatus, setStatusError]);

  const context = useMemo<BrowserContextValue>(
    () => ({
      app,
      isConnected,
      error,
      shares,
      selectedShare,
      selectedHost,
      selectedPath,
      fileContent,
      isLoadingFile,
      isEditing,
      status,
      sidebarOpen,
      wordWrap,
      displayMode,
      availableDisplayModes,
      requestDisplayModeChange,
      toggleSidebar,
      toggleWordWrap,
      selectShare,
      handleShareChange,
      openFile,
      saveFile,
      startEditing,
      cancelEditing,
    }),
    [
      app,
      isConnected,
      error,
      shares,
      selectedShare,
      selectedHost,
      selectedPath,
      fileContent,
      isLoadingFile,
      isEditing,
      status,
      sidebarOpen,
      wordWrap,
      displayMode,
      availableDisplayModes,
      requestDisplayModeChange,
      toggleSidebar,
      toggleWordWrap,
      selectShare,
      handleShareChange,
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
  const {
    error,
    shares,
    selectedShare,
    selectedHost,
    selectedPath,
    sidebarOpen,
    toggleSidebar,
    handleShareChange,
    status,
    displayMode,
    availableDisplayModes,
    requestDisplayModeChange,
  } = useBrowserContext();

  if (error) return <div className="status">Connection error: {error.message}</div>;

  // Only offer modes the host actually supports, and never the one we're
  // already in — there's nothing to request there.
  const requestableModes = ALL_DISPLAY_MODES.filter(
    (mode) => mode !== displayMode && availableDisplayModes.includes(mode)
  );

  return (
    <div className="app">
      <header className="header">
        <select
          aria-label="Share"
          value={selectedShare && selectedHost ? shareKey(selectedShare, selectedHost) : ""}
          onChange={(e) => handleShareChange(e.target.value)}
        >
          <option value="">Select a share…</option>
          {shares.map((s) => (
            <option key={shareKey(s.share, s.host)} value={shareKey(s.share, s.host)}>
              {s.share} ({s.host})
            </option>
          ))}
        </select>
        {requestableModes.length > 0 && (
          <div className="display-mode-buttons">
            {requestableModes.map((mode) => (
              <button
                key={mode}
                type="button"
                title={`Switch to ${DISPLAY_MODE_LABELS[mode]}`}
                aria-label={`Switch to ${DISPLAY_MODE_LABELS[mode]} display mode`}
                onClick={() => requestDisplayModeChange(mode)}
              >
                <DisplayModeIcon mode={mode} />
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="layout">
        <nav className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
          {/* Both branches stay mounted, with CSS toggling which is visible —
           * conditionally rendering DirectoryTree here would unmount it (and
           * every nested TreeNode's expanded state) every time the bar
           * closes, forcing a re-fetch and collapsing all navigation on
           * every reopen. */}
          <button type="button" className="sidebar-bar" aria-label="Open file tree" onClick={toggleSidebar}>
            <span className="sidebar-bar-label">{spacedPath(selectedPath ?? selectedShare ?? "")}</span>
          </button>
          <div className="sidebar-tree">{selectedShare && <DirectoryTree path="" />}</div>
        </nav>
        <div className="main">
          <FileEditor />
        </div>
      </div>
      <div className={`status${status.isError ? " error" : ""}`}>
        {status.isError ? `⚠ ${status.text}` : status.text || " "}
      </div>
    </div>
  );
}

const TREE_SKELETON_WIDTHS = [70, 45, 85, 55, 65];

function TreeSkeleton() {
  return (
    <ul className="tree">
      {TREE_SKELETON_WIDTHS.map((width, i) => (
        <li key={i} className="node skeleton-row">
          <span className="skeleton" style={{ width: `${width}%` }} />
        </li>
      ))}
    </ul>
  );
}

const EDITOR_SKELETON_WIDTHS = [60, 85, 40, 70, 90, 35, 75, 50, 80, 45];

function EditorSkeleton() {
  return (
    <div className="viewer-pane">
      <div className="skeleton-lines">
        {EDITOR_SKELETON_WIDTHS.map((width, i) => (
          <span key={i} className="skeleton" style={{ width: `${width}%` }} />
        ))}
      </div>
    </div>
  );
}

function DirectoryTree({ path }: { path: string }) {
  const { app, selectedShare, selectedHost } = useBrowserContext();
  const [nodes, setNodes] = useState<DirNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!app || !selectedShare || !selectedHost) return;
    let cancelled = false;
    void (async () => {
      let result;
      try {
        result = await app.callServerTool({
          name: "list_directory",
          arguments: path
            ? { share: selectedShare, host: selectedHost, relative_path: path }
            : { share: selectedShare, host: selectedHost },
        });
      } catch (e) {
        // Transport failure/timeout/connection loss throws here instead of resolving
        // with isError:true — without this, the tree is left on its loading skeleton forever.
        if (cancelled) return;
        setError(transportErrorMessage(e));
        setNodes(null);
        return;
      }
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
  }, [app, selectedShare, selectedHost, path]);

  if (error) {
    return (
      <ul className="tree">
        <li className="node error">⚠ {error}</li>
      </ul>
    );
  }

  if (nodes === null) {
    return <TreeSkeleton />;
  }

  if (nodes.length === 0) {
    return (
      <ul className="tree">
        <li className="node empty">&lt;empty&gt;</li>
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
  const { selectedShare, selectedHost, selectedPath, openFile } = useBrowserContext();
  const [expanded, setExpanded] = useState(false);
  const isDir = node.type === "directory";
  const classes = ["node", isDir ? "dir" : "file", expanded && "expanded", selectedPath === node.path && "selected"]
    .filter(Boolean)
    .join(" ");

  return (
    <li>
      <div
        className={classes}
        onClick={() => (isDir ? setExpanded((e) => !e) : void openFile(selectedShare!, selectedHost!, node.path))}
      >
        <span className="node-icon">{isDir && (expanded ? <FolderOpenIcon /> : <FolderClosedIcon />)}</span>
        {nodeName(node.path)}
      </div>
      {isDir && expanded && <DirectoryTree path={node.path} />}
    </li>
  );
}

function FileEditor() {
  const {
    fileContent,
    isLoadingFile,
    selectedShare,
    selectedHost,
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
    return highlightForPath(fileContent, selectedPath);
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
    if (!selectedShare || !selectedHost || !selectedPath || refreshCooldown) return;
    setRefreshCooldown(true);
    void openFile(selectedShare, selectedHost, selectedPath);
    refreshTimeoutRef.current = window.setTimeout(() => setRefreshCooldown(false), 2000);
  }, [selectedShare, selectedHost, selectedPath, openFile, refreshCooldown]);

  if (isLoadingFile) return <EditorSkeleton />;

  if (fileContent == null || highlighted == null) return <pre className="viewer" />;

  return (
    <div className="editor-pane">
      <div className="editor-content">
        {isEditing ? (
          <textarea ref={textareaRef} className="editor-input" defaultValue={fileContent} spellCheck={false} />
        ) : (
          <pre className={`viewer language-${highlighted.language}${wordWrap ? " wrap" : ""}`}>
            <code className={`language-${highlighted.language}`} dangerouslySetInnerHTML={{ __html: highlighted.html }} />
          </pre>
        )}
      </div>
      {/* Persistent — was an absolute overlay on top of the content before,
       * which covered text on narrower layouts (no room to push it aside). */}
      <div className="action-bar">
        {isEditing ? (
          <>
            <button
              type="button"
              className="save"
              title="Save"
              aria-label="Save"
              onClick={() => void saveFile(textareaRef.current?.value ?? "")}
            >
              <SaveIcon />
            </button>
            <button type="button" title="Cancel" aria-label="Cancel" onClick={cancelEditing}>
              <CancelIcon />
            </button>
          </>
        ) : (
          <>
            <button type="button" title="Refresh" aria-label="Refresh" disabled={refreshCooldown} onClick={handleRefresh}>
              <RefreshIcon />
            </button>
            <button
              type="button"
              className={wordWrap ? "active" : ""}
              title="Toggle word wrap"
              aria-label="Toggle word wrap"
              aria-pressed={wordWrap}
              onClick={toggleWordWrap}
            >
              <WordWrapIcon />
            </button>
            <button type="button" title="Edit" aria-label="Edit" onClick={startEditing}>
              <EditIcon />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
