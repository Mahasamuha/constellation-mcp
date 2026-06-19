import { AppBridge, PostMessageTransport, type McpUiHostCapabilities, type McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import { listShares, callMockTool } from "./mockFs";
import "./style.css";

type DisplayMode = "inline" | "fullscreen" | "pip";
type PipStyle = "fixed" | "draggable";

// A small fixed box, deliberately not full-page — pip is meant to float
// alongside other content, not take it over (see FileBrowserApp.tsx's own
// "floating alongside the conversation" comment on its pip request).
const PIP_SIZE = { width: 420, height: 640 };
const TITLEBAR_HEIGHT = 22;

const frame = document.querySelector<HTMLIFrameElement>("#app-frame")!;
const pipTitlebar = document.querySelector<HTMLDivElement>("#pip-titlebar")!;
const urlInput = document.querySelector<HTMLInputElement>("#telescope-url")!;
const shareSelect = document.querySelector<HTMLSelectElement>("#initial-share")!;
const pathInput = document.querySelector<HTMLInputElement>("#initial-path")!;
const launchButton = document.querySelector<HTMLButtonElement>("#launch")!;
const themeToggle = document.querySelector<HTMLInputElement>("#theme-toggle")!;
const allowPipToggle = document.querySelector<HTMLInputElement>("#allow-pip")!;
const forceModeSelect = document.querySelector<HTMLSelectElement>("#force-display-mode")!;
const pipStyleSelect = document.querySelector<HTMLSelectElement>("#pip-style")!;
const latencyInput = document.querySelector<HTMLInputElement>("#latency")!;
const log = document.querySelector<HTMLPreElement>("#log")!;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLog(line: string): void {
  log.textContent += `${line}\n`;
  log.scrollTop = log.scrollHeight;
}

const emptyOption = document.createElement("option");
emptyOption.value = "";
emptyOption.textContent = "(none — show share picker)";
shareSelect.appendChild(emptyOption);
for (const shareName of [...new Set(listShares().map((s) => s.share))].sort()) {
  const opt = document.createElement("option");
  opt.value = shareName;
  opt.textContent = shareName;
  shareSelect.appendChild(opt);
}

let bridge: AppBridge | null = null;

// inline: the *view* drives sizing (reports natural content height via
// sizechange; we just shrink-wrap the iframe to match). fullscreen/pip: the
// *host* drives sizing — we commit to a box up front and ignore further
// sizechange reports, since auto-resize can only ever shrink the iframe back
// toward content size, never grow it, and the host already decided the size.
let currentDisplayMode: DisplayMode = "inline";

// The spec doesn't define whether a host's pip window is host-fixed
// (TV-style inset) or user-movable (modern OS-level pip) — see the
// conversation with the user. Both are valid host implementations; this
// toggle lets us test telescope's layout against either one. Telescope's own
// code never sees this — it only ever asks for "pip" and gets back {mode:
// "pip"}, with zero awareness of how this host happens to implement it.
let dragging = false;
let dragGrabOffset = { x: 0, y: 0 };
let pipPos = { x: 0, y: 0 };

function positionDraggablePip(x: number, y: number): void {
  pipPos = { x, y };
  frame.style.left = `${x}px`;
  frame.style.top = `${y}px`;
  pipTitlebar.style.left = `${x}px`;
  pipTitlebar.style.top = `${y - TITLEBAR_HEIGHT}px`;
  pipTitlebar.style.width = `${PIP_SIZE.width}px`;
}

function enableDraggablePip(): void {
  frame.classList.add("draggable-pip");
  frame.style.width = `${PIP_SIZE.width}px`;
  frame.style.height = `${PIP_SIZE.height}px`;
  pipTitlebar.hidden = false;
  positionDraggablePip(window.innerWidth - PIP_SIZE.width - 24, window.innerHeight - PIP_SIZE.height - 24 - TITLEBAR_HEIGHT);
}

function disableDraggablePip(): void {
  frame.classList.remove("draggable-pip");
  frame.style.left = "";
  frame.style.top = "";
  pipTitlebar.hidden = true;
}

pipTitlebar.addEventListener("pointerdown", (e) => {
  dragging = true;
  dragGrabOffset = { x: e.clientX - pipPos.x, y: e.clientY - (pipPos.y - TITLEBAR_HEIGHT) };
  pipTitlebar.setPointerCapture(e.pointerId);
});
pipTitlebar.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  positionDraggablePip(e.clientX - dragGrabOffset.x, e.clientY - dragGrabOffset.y + TITLEBAR_HEIGHT);
});
pipTitlebar.addEventListener("pointerup", () => {
  dragging = false;
});

function applyDisplayModeSizing(mode: DisplayMode): void {
  currentDisplayMode = mode;
  disableDraggablePip();
  frame.style.flex = "";
  frame.style.width = "";
  frame.style.height = "";

  if (mode === "fullscreen") {
    frame.style.height = "100%";
  } else if (mode === "pip") {
    if ((pipStyleSelect.value as PipStyle) === "draggable") {
      enableDraggablePip();
    } else {
      frame.style.flex = "0 0 auto";
      frame.style.width = `${PIP_SIZE.width}px`;
      frame.style.height = `${PIP_SIZE.height}px`;
    }
  }
}

function hostCapabilities(): McpUiHostCapabilities {
  return { serverTools: {} };
}

function hostContext(): McpUiHostContext {
  return {
    theme: themeToggle.checked ? "dark" : "light",
    displayMode: currentDisplayMode,
    availableDisplayModes: allowPipToggle.checked ? ["inline", "fullscreen", "pip"] : ["inline", "fullscreen"],
  };
}

function launch(): void {
  bridge = null;
  forceModeSelect.value = "inline";
  applyDisplayModeSizing("inline");
  // Force a reload even if the URL string is unchanged.
  frame.src = "about:blank";
  requestAnimationFrame(() => {
    frame.src = urlInput.value;
  });
}

frame.addEventListener("load", () => {
  const win = frame.contentWindow;
  if (!win || frame.src === "about:blank") return;

  const transport = new PostMessageTransport(win, win);
  const next = new AppBridge(null, { name: "telescope-dev-host", version: "0.0.0" }, hostCapabilities(), {
    hostContext: hostContext(),
  });

  next.oncalltool = async (params) => {
    appendLog(`→ ${params.name} ${JSON.stringify(params.arguments ?? {})}`);
    const latency = Number(latencyInput.value);
    if (latency > 0) await sleep(latency);
    const result = callMockTool(params.name, params.arguments ?? {});
    appendLog(`← ${result.isError ? "ERROR " : ""}${JSON.stringify(result.structuredContent ?? result.content)}`);
    return result;
  };

  next.onrequestdisplaymode = async ({ mode }) => {
    const available = hostContext().availableDisplayModes ?? ["inline"];
    const granted = available.includes(mode) ? mode : "inline";
    appendLog(`display mode requested: ${mode} → granted: ${granted}`);
    applyDisplayModeSizing(granted);
    forceModeSelect.value = granted;
    return { mode: granted };
  };

  next.addEventListener("initialized", () => {
    const share = shareSelect.value || undefined;
    const path = pathInput.value || undefined;
    void next.sendToolInput({ arguments: { share, path } });
    appendLog(`initialized — sent tool input: share=${share ?? "(none)"} path=${path ?? "(none)"}`);
  });

  // Only meaningful in inline mode — see the currentDisplayMode comment above.
  next.addEventListener("sizechange", ({ height }) => {
    if (currentDisplayMode !== "inline" || height == null) return;
    frame.style.height = `${height}px`;
    appendLog(`size changed → height: ${height}px`);
  });

  bridge = next;
  void bridge.connect(transport);
});

launchButton.addEventListener("click", launch);
themeToggle.addEventListener("change", () => bridge?.setHostContext(hostContext()));
allowPipToggle.addEventListener("change", () => bridge?.setHostContext(hostContext()));

// Host-initiated display mode change — independent of anything telescope
// itself requests, since telescope currently never requests "fullscreen" on
// its own and this is the only way to exercise that path.
forceModeSelect.addEventListener("change", () => {
  const mode = forceModeSelect.value as DisplayMode;
  applyDisplayModeSizing(mode);
  appendLog(`host forced display mode → ${mode}`);
  bridge?.setHostContext(hostContext());
});

// Re-apply immediately if pip is already showing, so switching styles is
// visible without needing to re-trigger a display-mode request.
pipStyleSelect.addEventListener("change", () => {
  if (currentDisplayMode === "pip") applyDisplayModeSizing("pip");
});

launch();
