import readline from "node:readline";
/** Polls fn every intervalMs until it returns a non-null value or timeoutMs elapses.
 *
 * A throw from fn (DNS hiccup, connection reset, laptop suspend mid-poll) is treated
 * like a null return rather than aborting the whole poll — every caller here drives a
 * flow meant to run for minutes (device-code login/elevate), and a single transient
 * network error shouldn't kill it. The existing deadline is still the only bound: this
 * doesn't retry forever, it just stops *that* counting as a fatal error.
 */
export async function poll(fn, intervalMs, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let interval = intervalMs;
    while (Date.now() < deadline) {
        let result;
        try {
            result = await fn({ intervalMs: interval, setIntervalMs: (ms) => { interval = ms; } });
        }
        catch {
            result = null;
        }
        if (result !== null)
            return result;
        await sleep(interval);
    }
    return null;
}
export function sleep(ms) {
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
export async function confirm(prompt, input = process.stdin, output = process.stdout) {
    if (process.env["CONSTELLATION_ASSUME_YES"])
        return true;
    const rl = readline.createInterface({ input, output });
    return new Promise((resolve) => {
        let answered = false;
        rl.once("close", () => {
            if (!answered)
                resolve(false);
        });
        rl.question(`${prompt} [y/N] `, (answer) => {
            answered = true;
            rl.close();
            resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
        });
    });
}
/** The relay's host-name rule (relay/src/host-name.ts): 1-63 of letters, digits, dot, underscore, hyphen. */
export const HOST_NAME_PATTERN = /^[A-Za-z0-9._-]{1,63}$/;
/**
 * Trims `raw` and checks it against the relay's host-name rule, so a bad name fails before the
 * user approves a sign-in rather than after.
 */
export function checkHostName(raw) {
    const host = raw.trim();
    if (HOST_NAME_PATTERN.test(host))
        return { ok: true, host };
    return {
        ok: false,
        error: "host name must be 1-63 characters from letters, digits, '.', '_' and '-' (pass --host-name)",
    };
}
//# sourceMappingURL=cli-util.js.map