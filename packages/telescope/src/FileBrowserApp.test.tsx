// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FileBrowserApp } from "./FileBrowserApp";

// Replaces the real postMessage/AppBridge integration (useApp's job) with a directly
// controllable fake `app` — everything below that boundary is what these tests exercise.
const mockApp = {
  callServerTool: vi.fn(),
  updateModelContext: vi.fn().mockResolvedValue(undefined),
  getHostContext: vi.fn(() => ({ availableDisplayModes: ["inline"] })),
  requestDisplayMode: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

vi.mock("@modelcontextprotocol/ext-apps/react", () => ({
  useApp: () => ({ app: mockApp, isConnected: true, error: null }),
  useHostStyleVariables: () => {},
}));

interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

/** A promise this test controls the resolution/rejection timing of, independent of
 * when the call that created it happens to fire relative to any other call. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SHARE = ok({ shares: [{ share: "docs", host: "h1" }] });
const TWO_FILES = ok({ nodes: [{ path: "a.txt", type: "file" }, { path: "b.txt", type: "file" }] });

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Renders the app, selects the only share, and waits for the (2-file) tree to appear. */
async function renderWithShareSelected(): Promise<void> {
  render(<FileBrowserApp />);
  // Wait for list_shares to resolve and populate the <option> before changing it —
  // otherwise the change event fires against a <select> with no matching option yet.
  await screen.findByText("docs (h1)");
  fireEvent.change(screen.getByLabelText("Share"), { target: { value: "docs::h1" } });
  await screen.findByText("a.txt");
}

describe("FileBrowserApp", () => {
  it("opens a file end to end (sanity check for the test harness itself)", async () => {
    mockApp.callServerTool.mockImplementation(({ name }: { name: string }) => {
      if (name === "list_shares") return Promise.resolve(SHARE);
      if (name === "list_directory") return Promise.resolve(TWO_FILES);
      if (name === "read_file") return Promise.resolve(ok({ content: "hello from a" }));
      throw new Error(`unexpected tool call: ${name}`);
    });

    await renderWithShareSelected();
    fireEvent.click(screen.getByText("a.txt"));

    const viewer = await screen.findByText(/hello from a/);
    expect(viewer).toBeTruthy();
  });

  // Regression test for the out-of-order race fixed via openFileSeq: clicking file A
  // then quickly file B used to let A's slower response clobber B's already-displayed
  // content if A's read_file happened to resolve after B's.
  it("does not let a stale openFile() result clobber a more recently opened file", async () => {
    const reads = new Map<string, ReturnType<typeof deferred<CallToolResult>>>();
    mockApp.callServerTool.mockImplementation(({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
      if (name === "list_shares") return Promise.resolve(SHARE);
      if (name === "list_directory") return Promise.resolve(TWO_FILES);
      if (name === "read_file") {
        const path = args!["relative_path"] as string;
        const d = deferred<CallToolResult>();
        reads.set(path, d);
        return d.promise;
      }
      throw new Error(`unexpected tool call: ${name}`);
    });

    await renderWithShareSelected();

    fireEvent.click(screen.getByText("a.txt"));
    await flush();
    fireEvent.click(screen.getByText("b.txt"));
    await flush();

    // B resolves first, then the slower, now-stale A result arrives after it.
    reads.get("b.txt")!.resolve(ok({ content: "content of B" }));
    await screen.findByText(/content of B/);

    reads.get("a.txt")!.resolve(ok({ content: "content of A" }));
    await flush();

    expect(screen.queryByText(/content of A/)).toBeNull();
    expect(screen.getByText(/content of B/)).toBeTruthy();
  });

  // Regression test for the unhandled-rejection fix: callServerTool throwing (transport
  // failure/timeout) instead of resolving with isError:true used to leave the status bar
  // on "Loading…" forever, with no error ever shown.
  it("shows an error and clears loading state when read_file's transport call throws", async () => {
    mockApp.callServerTool.mockImplementation(({ name }: { name: string }) => {
      if (name === "list_shares") return Promise.resolve(SHARE);
      if (name === "list_directory") return Promise.resolve(TWO_FILES);
      if (name === "read_file") return Promise.reject(new Error("fetch failed"));
      throw new Error(`unexpected tool call: ${name}`);
    });

    await renderWithShareSelected();
    fireEvent.click(screen.getByText("a.txt"));

    await screen.findByText(/fetch failed/);
    expect(screen.queryByText(/Loading a\.txt/)).toBeNull();
  });

  // Regression test for the save-while-navigating fix: saveFile's confirmation re-read
  // used to clobber whatever file the user had since navigated to, because nothing
  // checked whether a newer openFile() call had superseded it by the time the re-read
  // resolved (the write itself was already correctly targeted either way).
  it("does not let a stale saveFile() re-read clobber a file opened after navigating away", async () => {
    const write = deferred<CallToolResult>();
    const staleReread = deferred<CallToolResult>();
    let aTxtReadCount = 0;

    mockApp.callServerTool.mockImplementation(({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
      if (name === "list_shares") return Promise.resolve(SHARE);
      if (name === "list_directory") return Promise.resolve(TWO_FILES);
      if (name === "read_file") {
        const path = args!["relative_path"] as string;
        if (path === "b.txt") return Promise.resolve(ok({ content: "content of B" }));
        // a.txt: the first read_file call is the initial open; the second is
        // saveFile's confirmation re-read, which this test keeps in flight.
        aTxtReadCount += 1;
        return aTxtReadCount === 1 ? Promise.resolve(ok({ content: "original A" })) : staleReread.promise;
      }
      if (name === "write_file") return write.promise;
      throw new Error(`unexpected tool call: ${name}`);
    });

    await renderWithShareSelected();
    fireEvent.click(screen.getByText("a.txt"));
    await screen.findByText(/original A/);

    fireEvent.click(screen.getByLabelText("Edit"));
    fireEvent.click(screen.getByLabelText("Save"));
    await flush();

    // Let the write succeed while A is still the open file — only the re-read is left
    // in flight, matching the original bug's actual trigger point.
    write.resolve(ok({ ok: true }));
    await flush();

    // Navigate to B while that re-read is still pending.
    fireEvent.click(screen.getByText("b.txt"));
    await screen.findByText(/content of B/);

    // The stale re-read finally resolves — it must not clobber B.
    staleReread.resolve(ok({ content: "re-read of A" }));
    await flush();

    expect(screen.getByText(/content of B/)).toBeTruthy();
    expect(screen.queryByText(/re-read of A/)).toBeNull();
    expect(screen.queryByText(/original A/)).toBeNull();
  });

  // Regression test for the unsaved-changes guard: navigating away mid-edit used to
  // silently discard whatever was typed into the (uncontrolled) textarea, with no
  // warning at all.
  it("blocks navigating to a different file mid-edit and pulses Save/Cancel instead", async () => {
    mockApp.callServerTool.mockImplementation(({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
      if (name === "list_shares") return Promise.resolve(SHARE);
      if (name === "list_directory") return Promise.resolve(TWO_FILES);
      if (name === "read_file") {
        const path = args!["relative_path"] as string;
        return Promise.resolve(ok({ content: path === "a.txt" ? "original A" : "content of B" }));
      }
      throw new Error(`unexpected tool call: ${name}`);
    });

    await renderWithShareSelected();
    fireEvent.click(screen.getByText("a.txt"));
    await screen.findByText(/original A/);
    fireEvent.click(screen.getByLabelText("Edit"));

    fireEvent.click(screen.getByText("b.txt"));
    await flush();

    // Still editing A — the click was blocked rather than routed to openFile.
    expect(screen.getByLabelText("Save")).toBeTruthy();
    expect(screen.queryByText(/content of B/)).toBeNull();
    expect(screen.getByLabelText("Save").className).toContain("pulse");
    expect(screen.getByLabelText("Cancel").className).toContain("pulse");
  });

  it("blocks switching shares mid-edit", async () => {
    const twoShares = ok({ shares: [{ share: "docs", host: "h1" }, { share: "other", host: "h1" }] });
    mockApp.callServerTool.mockImplementation(({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
      if (name === "list_shares") return Promise.resolve(twoShares);
      if (name === "list_directory") return Promise.resolve(TWO_FILES);
      if (name === "read_file") {
        const path = args!["relative_path"] as string;
        return Promise.resolve(ok({ content: path === "a.txt" ? "original A" : "content of B" }));
      }
      throw new Error(`unexpected tool call: ${name}`);
    });

    await renderWithShareSelected();
    fireEvent.click(screen.getByText("a.txt"));
    await screen.findByText(/original A/);
    fireEvent.click(screen.getByLabelText("Edit"));

    fireEvent.change(screen.getByLabelText("Share"), { target: { value: "other::h1" } });
    await flush();

    // Still on "docs" — the change was blocked rather than routed to handleShareChange.
    expect((screen.getByLabelText("Share") as HTMLSelectElement).value).toBe("docs::h1");
    expect(screen.getByLabelText("Save").className).toContain("pulse");
  });
});
