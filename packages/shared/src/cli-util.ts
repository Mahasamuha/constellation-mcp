import readline from "node:readline";

export interface PollContext {
  /** The interval that will be waited after this call if it returns null. */
  intervalMs: number;
  /**
   * Changes the interval used for this and all subsequent waits — e.g. RFC 8628
   * §3.5's "slow_down" device-flow response, which requires the poller to back off
   * by 5 seconds rather than keep hammering the token endpoint at the original rate.
   */
  setIntervalMs: (ms: number) => void;
}

/** Polls fn every intervalMs until it returns a non-null value or timeoutMs elapses. */
export async function poll<T>(
  fn: (ctx: PollContext) => Promise<T | null>,
  intervalMs: number,
  timeoutMs: number
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  let interval = intervalMs;
  while (Date.now() < deadline) {
    const result = await fn({ intervalMs: interval, setIntervalMs: (ms) => { interval = ms; } });
    if (result !== null) return result;
    await sleep(interval);
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Prompts for a y/N confirmation. Returns true if user answers y/yes. */
export async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}
