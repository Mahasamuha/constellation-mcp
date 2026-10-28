import open from "open";
import {
  loadRelaySession,
  writeRelaySession,
  deleteRelaySession,
  relaySessionLockPath,
  type RelaySession,
} from "@constellation/node/config";
import {
  AsterismError,
  clientIdFor,
  deviceSignIn,
  discoverAsterism,
  refreshTokens,
  resourceFor,
  revokeRefreshToken,
  sanitizeForTerminal,
  deviceCodeLines,
  withLockFile,
  confirm,
  isSameOrigin,
  type DeviceAuthorization,
} from "@constellation/shared";

/** asterism's absolute lifetime for a refresh token chain. Not extended by rotation. */
const REFRESH_LIFETIME_MS = 30 * 86_400_000;
/** An access token this close to expiring is refreshed rather than risked on a request. */
const EXPIRY_SKEW_MS = 30_000;

const REVOKE_TIMEOUT_MS = 5_000;

const SESSION_SCOPE = "relay offline_access";
const ADMIN_SCOPE = "relay admin";

/** The sign-in is gone for good (expired, revoked, or its refresh chain was reused): sign in again. */
export class SessionExpiredError extends Error {}

type Print = (line: string) => void;

function showCode(print: Print, heading: string, dc: DeviceAuthorization, openUrl: string | null): void {
  for (const line of deviceCodeLines(heading, dc, openUrl)) print(line);
  if (openUrl) void open(openUrl).catch(() => { /* ignore */ });
}

/** Turns a failed device flow into a one-line exit; network errors surface with their cause. */
export function exitOnSignInError(err: unknown): never {
  // AsterismError messages are already stripped of control characters; others may carry a host or URL.
  console.error(err instanceof AsterismError ? `\n${err.message}` : `\nSign-in failed: ${sanitizeForTerminal((err as Error).message)}`);
  if (err instanceof AsterismError && err.code === "issuer_changed") {
    console.error("If you trust the change, run 'constellation relay login' (it asks before accepting a new authorization server).");
  }
  return process.exit(1);
}

/**
 * Signs in to the relay's authorization server (device flow, scope `relay offline_access`, the
 * `cli` client) and persists the session. `print` is stdout for `relay login`, stderr when
 * re-signing in mid-command so a command's own output stays clean. `expectedIssuer` pins the
 * authorization server: a relay that names another one ends the sign-in before it is contacted.
 */
export async function signIn(
  relayUrl: string,
  dir: string,
  print: Print = console.log,
  expectedIssuer?: string
): Promise<RelaySession> {
  const { endpoints, tokens } = await deviceSignIn(relayUrl, {
    kind: "cli",
    scope: SESSION_SCOPE,
    ...(expectedIssuer ? { expectedIssuer } : {}),
    onCode: (dc, openUrl) => showCode(print, "Open the following URL to authenticate", dc, openUrl),
  }).catch(exitOnSignInError);

  const now = Date.now();
  const session: RelaySession = {
    relay_url: relayUrl,
    issuer: endpoints.issuer,
    access_token: tokens.access_token,
    access_token_expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
    refresh_token: tokens.refresh_token,
    refresh_token_expires_at: tokens.refresh_token ? new Date(now + REFRESH_LIFETIME_MS).toISOString() : undefined,
  };
  writeRelaySession(dir, session);
  return session;
}

/**
 * An admin access token for one command: a second device flow with scope `relay admin` and no
 * `offline_access` (asterism gives it 5 minutes, never refreshes it, and grants it only to
 * members of the admin group). Held in memory by the caller, never written to disk.
 * `expectedIssuer` is the authorization server of the stored session: a relay that now names
 * another one is refused rather than asked for an admin token.
 */
export async function adminStepUp(relayUrl: string, expectedIssuer?: string): Promise<string> {
  const { tokens } = await deviceSignIn(relayUrl, {
    kind: "cli",
    scope: ADMIN_SCOPE,
    ...(expectedIssuer ? { expectedIssuer } : {}),
    onCode: (dc, openUrl) => showCode(console.error, "This needs admin access. Approve it to continue", dc, openUrl),
  }).catch((err) => {
    if (err instanceof AsterismError && err.code === "access_denied") {
      console.error("\nAdmin access was denied. Your account must be in the admin group.");
      return process.exit(1);
    }
    return exitOnSignInError(err);
  });
  return tokens.access_token;
}

function isFresh(session: RelaySession): boolean {
  return new Date(session.access_token_expires_at).getTime() - EXPIRY_SKEW_MS > Date.now();
}

/**
 * Refreshes an expired session under a lock file. asterism rotates the refresh token and
 * treats a second use of the old one as theft (ending the whole grant), so two concurrent CLI
 * processes must not both spend it: the loser waits, re-reads the file, and finds it fresh.
 * The rotated refresh token is written to disk before the new access token is returned.
 */
async function refreshSession(dir: string): Promise<RelaySession> {
  return withLockFile(relaySessionLockPath(dir), async () => {
    const session = loadRelaySession(dir);
    if (isFresh(session)) return session;

    const expiry = session.refresh_token_expires_at ? new Date(session.refresh_token_expires_at).getTime() : Infinity;
    if (!session.refresh_token || expiry <= Date.now()) throw new SessionExpiredError();

    // A session from before the issuer was recorded cannot be tied to an authorization server, so
    // it is not refreshed; signing in again records one.
    if (!session.issuer) throw new SessionExpiredError();
    // Pinned: if the relay now names another authorization server this throws issuer_changed and
    // the session file is kept, so the refresh token never reaches the new one.
    const endpoints = await discoverAsterism(session.relay_url, {}, session.issuer);
    let tokens;
    try {
      tokens = await refreshTokens(endpoints, {
        clientId: clientIdFor(session.relay_url, "cli"),
        resource: resourceFor(session.relay_url),
        refreshToken: session.refresh_token,
      });
    } catch (err) {
      if (err instanceof AsterismError && err.code === "invalid_grant") {
        // The refresh token is spent or revoked; keeping it would only trip reuse detection again.
        deleteRelaySession(dir);
        throw new SessionExpiredError();
      }
      throw err;
    }

    const refreshed: RelaySession = {
      relay_url: session.relay_url,
      issuer: session.issuer,
      access_token: tokens.access_token,
      access_token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      refresh_token: tokens.refresh_token ?? session.refresh_token,
      // Absolute: rotation does not extend the 30 days.
      refresh_token_expires_at: session.refresh_token_expires_at,
    };
    writeRelaySession(dir, refreshed);
    return refreshed;
  });
}

/**
 * The stored session with a usable access token, refreshing it if needed. When the sign-in has
 * expired or been revoked, runs the device flow again if a person is at the terminal, and
 * otherwise tells them to.
 */
export async function getValidSession(dir: string): Promise<RelaySession> {
  let session: RelaySession;
  try {
    session = loadRelaySession(dir);
  } catch {
    console.error("Not logged in. Run 'constellation relay login' first.");
    return process.exit(1);
  }
  if (isFresh(session)) return session;

  try {
    return await refreshSession(dir);
  } catch (err) {
    if (!(err instanceof SessionExpiredError)) {
      console.error(`Could not refresh the session: ${sanitizeForTerminal((err as Error).message)}`);
      if (err instanceof AsterismError && err.code === "issuer_changed") {
        console.error("Your session was kept. Run 'constellation relay login' to sign in to the new authorization server.");
      }
      return process.exit(1);
    }
  }

  if (process.stdin.isTTY && process.stderr.isTTY) {
    console.error("Session expired. Signing in again.");
    return signIn(session.relay_url, dir, console.error, session.issuer);
  }
  console.error("Session expired. Run 'constellation relay login' to sign in again.");
  return process.exit(1);
}

/**
 * Best effort at logout: asks the authorization server that issued the session to revoke its
 * refresh token (which ends the rotation chain), with a short timeout. Never throws; the caller
 * deletes the session file either way. Only an authorization server recorded at sign-in is
 * contacted, and only if it is still the one the relay names.
 */
export async function revokeStoredSession(dir: string): Promise<void> {
  let session: RelaySession;
  try {
    session = loadRelaySession(dir);
  } catch {
    return;
  }
  if (!session.refresh_token || !session.issuer) return;
  const deps = { timeoutMs: REVOKE_TIMEOUT_MS };
  try {
    const endpoints = await discoverAsterism(session.relay_url, deps, session.issuer);
    await revokeRefreshToken(endpoints, {
      clientId: clientIdFor(session.relay_url, "cli"),
      refreshToken: session.refresh_token,
    }, deps);
  } catch (err) {
    console.error(`Could not revoke the sign-in at the authorization server (${sanitizeForTerminal((err as Error).message)}). You can revoke it in asterism's /grants page.`);
  }
}

/** Whether a person can answer a prompt: a terminal on both ends, and not the GUI's assume-yes mode. */
function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env["CONSTELLATION_ASSUME_YES"]);
}

/**
 * An explicit `relay login`. When a session for this relay already exists and the relay now names a
 * different authorization server than the one it was issued by, shows both and asks before going on
 * (refusing outright without a terminal, unless `acceptNewIssuer`). The sign-in itself is pinned to
 * the server that was discovered (and confirmed), so it cannot change between the question and the
 * device request.
 */
export async function login(relayUrl: string, dir: string, acceptNewIssuer = false): Promise<RelaySession> {
  let existing: RelaySession | undefined;
  try { existing = loadRelaySession(dir); } catch { /* no session yet */ }

  let pin: string | undefined;
  if (existing?.issuer && isSameOrigin(existing.relay_url, relayUrl)) {
    const endpoints = await discoverAsterism(relayUrl).catch(exitOnSignInError);
    pin = endpoints.issuer;
    if (pin !== existing.issuer) {
      console.error(`\n${relayUrl} now names a different authorization server than your current sign-in.`);
      console.error(`  Signed in with: ${sanitizeForTerminal(existing.issuer)}`);
      console.error(`  Relay now names: ${sanitizeForTerminal(pin)}`);
      const accepted = acceptNewIssuer
        || (canPrompt() && await confirm("Sign in to the new authorization server? Only do this if you expected the change."));
      if (!accepted) {
        console.error(canPrompt()
          ? "Cancelled. Your existing session was kept."
          : "Not signing in: this is not a terminal. Pass --accept-new-issuer if you trust the change. Your existing session was kept.");
        return process.exit(1);
      }
    }
  }
  return signIn(relayUrl, dir, console.log, pin);
}
