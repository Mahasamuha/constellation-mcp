import { describe, it, expect } from "vitest";
import { sanitizeForTerminal, isValidUserCode, deviceCodeLines } from "./terminal-text.js";

describe("sanitizeForTerminal", () => {
  it("strips C0 and C1 controls, including escape sequences' ESC and CSI", () => {
    expect(sanitizeForTerminal("a\u001b[2Jb\u0007c\u009bd\u007fe\r\nf\tg")).toBe("a[2Jbcdefg");
  });

  it("strips bidi and zero-width characters", () => {
    expect(sanitizeForTerminal("exa\u202emple\u2066x\u2069\u200b.com\ufeff\u200f")).toBe("examplex.com");
  });

  it("leaves ordinary text, including non-Latin letters, alone", () => {
    expect(sanitizeForTerminal("https://auth.example.com/oauth/device?user_code=ABCD-2345")).toBe("https://auth.example.com/oauth/device?user_code=ABCD-2345");
    expect(sanitizeForTerminal("Zugriff verweigert: übermäßig 日本語")).toBe("Zugriff verweigert: übermäßig 日本語");
  });

  it("truncates a very long string", () => {
    expect(sanitizeForTerminal("x".repeat(10_000)).length).toBeLessThan(600);
  });

  it("accepts non-strings", () => {
    expect(sanitizeForTerminal(42)).toBe("42");
  });
});

describe("isValidUserCode", () => {
  it("accepts asterism's format and nothing else", () => {
    expect(isValidUserCode("ABCD-2345")).toBe(true);
    expect(isValidUserCode("abcd-2345")).toBe(false);
    expect(isValidUserCode("ABCD2345")).toBe(false);
    expect(isValidUserCode("ABCI-2345")).toBe(false); // I is not in the alphabet
    expect(isValidUserCode("ABCD-2345\n")).toBe(false);
    expect(isValidUserCode("\u001b[2JABCD-2345")).toBe(false);
    expect(isValidUserCode("")).toBe(false);
  });
});

describe("deviceCodeLines", () => {
  const dc = { user_code: "ABCD-2345", verification_uri_complete: "https://evil.example/\u001b[2J" };

  it("shows the URL it is opening", () => {
    const text = deviceCodeLines("Open this", dc, "https://auth.example.com/d?user_code=ABCD-2345").join("\n");
    expect(text).toContain("opening browser automatically");
    expect(text).toContain("https://auth.example.com/d?user_code=ABCD-2345");
    expect(text).toContain("enter this code: ABCD-2345");
    expect(text).not.toContain("WARNING");
  });

  it("warns instead of presenting an off-origin URL, with controls stripped", () => {
    const text = deviceCodeLines("Open this", dc, null).join("\n");
    expect(text).toContain("WARNING");
    expect(text).toContain("not on its own origin");
    expect(text).not.toContain("opening browser automatically");
    expect(text).not.toContain("\u001b");
  });

  it("names who should enter the code", () => {
    expect(deviceCodeLines("x", dc, "https://a.example/", "the admin").join("\n")).toContain("the admin should enter this code");
  });
});
