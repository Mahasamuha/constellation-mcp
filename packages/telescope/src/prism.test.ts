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
    expect(result.html).toBe("&lt;img src=x onerror=alert(1)&gt;");
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

  // prism-markdown and prism-php both process inline HTML (via prism-markup-templating)
  // and are not entity-escaped like most other language grammars. These tests pin the
  // secondary escaping layer so a Prism update can't silently introduce an XSS path.
  it("neutralizes <script> in a markdown file", () => {
    const result = highlightForPath("<script>alert(1)</script>", "readme.md");
    expect(result.html).not.toContain("<script");
  });

  it("neutralizes <img onerror> in a markdown file", () => {
    const result = highlightForPath("<img src=x onerror=alert(1)>", "readme.md");
    expect(result.html).not.toContain("<img");
  });

  it("neutralizes <script> in a PHP file", () => {
    const result = highlightForPath("<?php ?><script>alert(1)</script>", "index.php");
    expect(result.html).not.toContain("<script");
  });
});
