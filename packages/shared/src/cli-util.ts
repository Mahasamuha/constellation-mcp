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

/**
 * Prompts for a y/N confirmation. Returns true if user answers y/yes.
 *
 * Skips the prompt entirely (returns true without touching stdin) if
 * CONSTELLATION_ASSUME_YES is set — for callers like node-gui that already
 * obtained confirmation through their own UI and spawn this CLI with no TTY
 * to prompt on. Without that bypass, if stdin closes before an answer is
 * given (the same non-interactive case, just without the env var set),
 * treats it as "no" rather than leaving the prompt's promise pending
 * forever while the action silently never happens.
 */
export async function confirm(
  prompt: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): Promise<boolean> {
  if (process.env["CONSTELLATION_ASSUME_YES"]) return true;

  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    let answered = false;
    rl.once("close", () => {
      if (!answered) resolve(false);
    });
    rl.question(`${prompt} [y/N] `, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}
