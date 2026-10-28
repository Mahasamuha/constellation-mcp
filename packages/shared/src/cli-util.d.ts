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
/** Polls fn every intervalMs until it returns a non-null value or timeoutMs elapses.
 *
 * A throw from fn (DNS hiccup, connection reset, laptop suspend mid-poll) is treated
 * like a null return rather than aborting the whole poll — every caller here drives a
 * flow meant to run for minutes (device-code login/elevate), and a single transient
 * network error shouldn't kill it. The existing deadline is still the only bound: this
 * doesn't retry forever, it just stops *that* counting as a fatal error.
 */
export declare function poll<T>(fn: (ctx: PollContext) => Promise<T | null>, intervalMs: number, timeoutMs: number): Promise<T | null>;
export declare function sleep(ms: number): Promise<void>;
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
export declare function confirm(prompt: string, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): Promise<boolean>;
/** The relay's host-name rule (relay/src/host-name.ts): 1-63 of letters, digits, dot, underscore, hyphen. */
export declare const HOST_NAME_PATTERN: RegExp;
/**
 * Trims `raw` and checks it against the relay's host-name rule, so a bad name fails before the
 * user approves a sign-in rather than after.
 */
export declare function checkHostName(raw: string): {
    ok: true;
    host: string;
} | {
    ok: false;
    error: string;
};
//# sourceMappingURL=cli-util.d.ts.map