import { describe, it, expect } from "vitest";
import { validateHostName } from "./host-name.js";

describe("validateHostName", () => {
  it("trims and accepts letters, digits, dot, underscore and hyphen", () => {
    expect(validateHostName("  nas-1.lan_a ")).toEqual({ host: "nas-1.lan_a" });
    expect(validateHostName("x".repeat(63))).toEqual({ host: "x".repeat(63) });
  });

  it.each([undefined, 5, "", "   ", "x".repeat(64), "has space", "a/b", "a:b", "<b>x</b>", "tab\there", "line\nbreak", "naïve", "a\u0000b"])(
    "rejects %j",
    (raw) => {
      expect(validateHostName(raw)).toHaveProperty("error");
    }
  );
});
