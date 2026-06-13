/** Polls fn every intervalMs until it returns a non-null value or timeoutMs elapses. */
export async function poll<T>(
  fn: () => Promise<T | null>,
  intervalMs: number,
  timeoutMs: number
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await sleep(intervalMs);
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
