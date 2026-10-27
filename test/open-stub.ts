// Tests must never launch a real browser. Every `import open from "open"` resolves here
// under vitest (see vitest.config.ts); tests that assert on it still vi.mock("open").
export default async function open(_target: string): Promise<void> {}
