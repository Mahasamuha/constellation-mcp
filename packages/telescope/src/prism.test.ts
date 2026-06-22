import { describe, it, expect } from "vitest";
import { highlightForPath, languageForPath } from "./prism";

describe("languageForPath", () => {
  it("maps a known extension to its Prism language id", () => {
    expect(languageForPath("src/main.py")).toBe("python");
  });

  it("returns null for an unregistered extension", () => {
    expect(languageForPath("notes.txt")).toBeNull();
  });

  it("returns null for a path with no extension", () => {
    expect(languageForPath("README")).toBeNull();
  });
});

describe("highlightForPath", () => {
  it("neutralizes an HTML/script payload when no grammar is registered for the path", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const result = highlightForPath(payload, "notes.txt");
    expect(result.language).toBe("none");
    expect(result.html).not.toContain("<img");
    expect(result.html).toBe("&lt;img src=x onerror=alert(1)>");
  });

  it("neutralizes the same payload when path is null", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const result = highlightForPath(payload, null);
    expect(result.html).not.toContain("<img");
  });

  it("still produces real Prism token markup for a recognized language", () => {
    const result = highlightForPath("def f():\n    pass\n", "script.py");
    expect(result.language).toBe("python");
    expect(result.html).toContain('class="token');
  });

  it("escapes an HTML/script payload embedded inside a recognized language's source too", () => {
    const payload = '"<img src=x onerror=alert(1)>"';
    const result = highlightForPath(payload, "script.py");
    expect(result.html).not.toContain("<img");
  });
});
