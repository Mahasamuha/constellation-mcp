/**
 * Text from a server (a verification URL, a user code, an OAuth error description, a relay
 * error body) is untrusted. Printed raw, a control sequence in it can rewrite the terminal
 * (clear the screen, move the cursor over the real prompt), and bidi or zero-width characters
 * can make one URL read as another. Every print site for server-supplied text goes through
 * sanitizeForTerminal.
 */

// C0 and C1 controls (including ESC and DEL), the Unicode line/paragraph separators, zero-width
// characters, and bidirectional formatting characters. Tab, newline and carriage return are
// stripped too: none of these strings is multi-line.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

const DEFAULT_MAX_LENGTH = 500;

/** `text` with control, bidi and zero-width characters removed, cut to `maxLength` characters. */
export function sanitizeForTerminal(text: unknown, maxLength = DEFAULT_MAX_LENGTH): string {
  const clean = String(text).replace(UNSAFE, "");
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean;
}

/**
 * The format asterism's device flow generates: eight characters from a 31-character alphabet
 * (no I, L, O, 0 or 1), shown as two groups of four.
 */
const USER_CODE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

export function isValidUserCode(code: string): boolean {
  return USER_CODE.test(code);
}

/** What a device-flow caller shows the user. */
export interface DeviceCodePrompt {
  user_code: string;
  verification_uri_complete: string;
}

/**
 * The lines that tell the user where to go and what code to enter. `openUrl` is the result of
 * verificationUrlToOpen: when it is null the URL the server named is not on the authorization
 * server's origin, so it is shown as a warning, not as the place to go. `who` is the person
 * who enters the code ("you" by default; the hub flow has an admin do it).
 */
export function deviceCodeLines(
  heading: string,
  dc: DeviceCodePrompt,
  openUrl: string | null,
  who = "you"
): string[] {
  const code = sanitizeForTerminal(dc.user_code);
  const entry = who === "you" ? "enter this code" : `${who} should enter this code`;
  if (openUrl) {
    return [
      `\n${heading} (opening browser automatically):`,
      `  ${sanitizeForTerminal(openUrl)}\n`,
      `If the browser did not open, ${entry}: ${code}\n`,
    ];
  }
  return [
    `\n${heading}:`,
    "  WARNING: the authorization server named a sign-in URL that is not on its own origin, so",
    `  it was not opened: ${sanitizeForTerminal(dc.verification_uri_complete)}`,
    "  Do not sign in there unless you recognize that address.\n",
    `If you do trust it, ${entry}: ${code}\n`,
  ];
}

// What `--json` output strips: the invisible and reordering characters of UNSAFE, but not the C0
// controls, which JSON.stringify already escapes (so they cannot reach the terminal raw) and which
// a legitimate multi-line value may contain.
const HIDDEN = /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

/**
 * A copy of parsed JSON with C1 controls, bidi formatting and zero-width characters removed from
 * every string, in object keys as well as values. `--json` output is meant for pipes, but people
 * also read it in a terminal, and a server-supplied string there can hide or reorder text. One
 * helper so every `--json` print site strips the same set.
 */
export function sanitizeJsonStrings<T>(value: T): T {
  if (typeof value === "string") return value.replace(HIDDEN, "") as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeJsonStrings(v)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k.replace(HIDDEN, ""), sanitizeJsonStrings(v)])
    ) as T;
  }
  return value;
}

// Multi-line text (share instructions): UNSAFE minus tab and newline, which such text may use.
// eslint-disable-next-line no-control-regex
const UNSAFE_MULTILINE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

/** `text` with control (except tab and newline), bidi and zero-width characters removed. */
export function sanitizeMultilineText(text: string): string {
  return text.replace(UNSAFE_MULTILINE, "");
}
