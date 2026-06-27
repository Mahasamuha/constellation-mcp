# Security Review — constellation-mcp
**Date:** 2026-06-27  
**Branch:** feature/production-readiness  
**Scope:** cli, hub, node, node-gui, relay, shared, telescope (excluded: telescope-dev)  
**Approach:** fresh/targeted, ranked by severity, includes supply chain  
**Result:** No CRITICAL or HIGH findings.

---

## Status Legend
- [ ] open
- [x] fixed + committed

---

## MEDIUM Findings

### M1 — relay: No consent screen during OAuth (phishing via open dynamic client registration)
**File:** `packages/relay/src/oauth.ts:55–205`  
**Status:** [x] fixed in 2f9be4e

Open dynamic client registration (RFC 7591) combined with no consent screen lets an attacker:
1. POST `/oauth/register` with `redirect_uris: ["https://attacker.com/steal"]` — no auth required
2. Send victim to `/oauth/authorize?client_id=ATTACKER_ID&redirect_uri=https://attacker.com/steal&code_challenge=...`
3. Victim sees relay's own "Sign in" page (no mention of which client or where code goes) and authenticates
4. Auth code redirected to attacker; redeemed with attacker's `code_verifier` → valid session

PKCE does not protect here — attacker initiated the flow and holds the verifier.

**Fix:** Add the requesting `client_id` and destination domain to the login page. Or require admin approval of dynamic clients before they can initiate redirect-based flows.

---

### M2 — relay: Missing `Strict-Transport-Security` header
**File:** `packages/relay/src/app.ts:68–75`  
**Status:** [x] fixed in 28eac68

Security headers middleware sets X-Content-Type-Options, X-Frame-Options, Referrer-Policy, CSP — but no HSTS. First-time visitors or DNS-spoofed victims can be served plain HTTP, exposing Bearer tokens and OAuth codes to MITM.

**Fix:**
```ts
if (config.secureCookies) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
```

---

### M3 — hub: `user_claims: null` causes unaudited TypeError
**File:** `packages/hub/src/index.ts:325`, `packages/hub/src/identity.ts:102`  
**Status:** [x] fixed in 28eac68

`handleRpc` validates `params` is a non-null object but not `user_claims`. A compromised relay sending `user_claims: null` causes a TypeError inside `resolveIdentity` that propagates past all audit-write paths, landing in `onMessage`'s `.catch` — which sends a generic error but writes **no audit entry**. A compromised relay can probe shares/identity with no paper trail.

**Fix:**
```ts
const rawClaims = envelope.user_claims;
const userClaims: Record<string, unknown> =
  (typeof rawClaims === "object" && rawClaims !== null && !Array.isArray(rawClaims))
    ? rawClaims as Record<string, unknown>
    : {};
```
Also add a parallel early-exit audit write for the bad-claims case, matching the `params` guard pattern at line 307.

---

### M4 — hub/shared: No `maxPayload` on relay WebSocket
**File:** `packages/shared/src/relay-socket.ts:144`  
**Status:** [x] fixed in 28eac68

`WebSocket` constructed with no `maxPayload` option. `ws` v8 default is 100 MiB. A compromised relay can send a single 100 MiB message causing ~200 MiB peak allocation (raw buffer + JSON.parse result), OOM-killing the hub and dropping all in-flight audit entries.

**Fix:** Pass `{ maxPayload: 1_048_576 }` (1 MiB) to the WebSocket constructor — no legitimate RPC payload exceeds a few KB.

---

### M5 — hub: Audit log fail-open with no disk pressure gate
**File:** `packages/hub/src/audit.ts:66–82`  
**Status:** [x] fixed in 28eac68

`AuditWriter` is explicitly fail-open: write failures are logged to stderr and swallowed. No threshold causes the hub to reject requests when audit writes begin failing. An authorized user with write access to any share on a filesystem that shares quota with the audit log partition can fill the disk, silencing all subsequent audit records while hub continues to serve requests.

**Fix:** Add optional `fail_closed_on_audit_error: true` config flag that rejects new requests after N consecutive audit write failures. Or at minimum track consecutive failures and emit a structured log at ERROR level on each failure so alerting picks it up.

---

### M6 — shared: `grepFiles` TOCTOU symlink escape
**File:** `packages/shared/src/executor/tools/fs-search.ts:108–111`  
**Status:** [x] fixed in 27e08ea

`grepFiles` walk filters symlinks via dirent semantics, but then calls `fs.stat(filePath)` (symlink-following) and `fs.readFile(filePath)` — not the `openNoFollow` pattern used everywhere else. Between `readdir` and `fs.readFile`, a local attacker with write access to any share directory can race to replace a regular file with a symlink to `/etc/shadow` or any outside-share path. File content is returned in grep results.

**Fix:** Use `fs.lstat` instead of `fs.stat`, and open the file with `openNoFollow` (matching the pattern in `readFile`, `writeFile`, `editFile`).

---

### M7 — shared: `fileInfo` TOCTOU — raw `readlink` target leaks outside-share paths
**File:** `packages/shared/src/executor/tools/fs-read.ts:111–114`  
**Status:** [x] fixed in 27e08ea

`execute()` uses `safeRealpath` to validate the path, but `assertPathStable` only validates the *parent directory*, not the final component. Between `safeRealpath` and `fileInfo`'s `lstat`, a local attacker can plant a symlink at the exact file location. `lstat` sees the symlink and `readlink` returns its raw absolute target (e.g., `/root/.ssh/id_rsa`) — no file content, but filesystem topology disclosure.

**Fix:** After `readlink`, validate the target is within the share boundary before returning it. Or omit the target when it resolves outside the share.

---

### M8 — cli + hub: No HTTPS enforcement for relay HTTP API calls
**Files:** `packages/cli/src/cli/relay.ts:77,304,652,741,762`, `packages/hub/src/cli.ts:87`  
**Status:** [x] fixed in b3afc86

`node init` and `hub rotate-token` correctly call `assertSecureRelayUrl` before opening WebSocket connections. But `relay login`, `relay status`, all CRUD relay commands, and `hub register` make plain `fetch()` calls with no scheme check. If a user passes `--relay http://relay.example.com`, Bearer tokens are sent in cleartext and the relay URL is persisted to `relay-session.yaml` for all future operations.

**Fix:** Apply an HTTP-plane equivalent of `assertSecureRelayUrl` inside `resolveRelayUrl` and at the top of `hub register`'s action. Reject `http://` unless host is localhost/127.x/::1.

---

### M9 — cli + node + node-gui: `verification_uri_complete` opened without scheme/origin check
**Files:** `packages/node/src/cli/node.ts:86`, `packages/hub/src/cli.ts:108`, `packages/node-gui/src/windows/Auth.tsx:121`  
**Status:** [x] fixed in b3afc86

`relay login` and `relay elevate` already gate the `open()` call with `isSameOrigin(relayUrl, dc.verification_uri_complete)`. But `node init` (node.ts:86) and `hub register` (hub/cli.ts:108) call `open(dc.verification_uri_complete)` unconditionally, and the node-gui passes it directly to Tauri's `openUrl()`. A compromised relay can return `vscode://...`, `file:///...`, `ssh://attacker.com`, or any custom URI scheme to exploit registered protocol handlers.

**Fix for CLI paths:** Apply `isSameOrigin` guard (move helper to `@constellation/shared` for reuse):
```ts
if (isSameOrigin(relayUrl, dc.verification_uri_complete)) {
  try { await open(dc.verification_uri_complete); } catch { /* ignore */ }
}
```
**Fix for node-gui (Auth.tsx:121):** Validate scheme in Rust before returning the struct:
```rust
if !info.verification_uri_complete.starts_with("https://") {
  return Err("Relay returned an unsafe verification URI".to_string());
}
```

---

### M10 — telescope: `dangerouslySetInnerHTML` trusts Prism for markdown/PHP grammars
**File:** `packages/telescope/src/FileBrowserApp.tsx:845`, `packages/telescope/src/prism.ts:84–89`  
**Status:** [x] fixed in 1121ee8

Highlighted HTML is rendered via `dangerouslySetInnerHTML` with no secondary escaping. For most languages this is fine; Prism's tokenizer entity-encodes `<` and `>`. However `prism-markdown` and `prism-php` process inline HTML (via `prism-markup-templating`) and are not covered by the XSS test suite. If Prism's tokenizer has a grammar edge case, there is no fallback escape layer.

**Fix:** Add XSS test cases for `.md` files containing `<script>` and `<img onerror=>`, and `.php` files with inline HTML. Consider a secondary DOMPurify pass for the markdown/PHP code paths.

---

## LOW Findings

### L1 — relay: `/healthz` before rate-limit middleware
**File:** `packages/relay/src/app.ts:77–84`  
**Status:** [x] fixed in 00d90b3

`/healthz` is mounted before the rate-limit dispatcher. Every request executes `prisma.$queryRaw SELECT 1` with no throttle, potentially exhausting the PG connection pool.

**Fix:** Move healthz to after the rate-limit dispatcher (classify as `"default"`) or add a dedicated limiter to the handler.

---

### L2 — relay: OAuth flow-state cookies unsigned
**Files:** `packages/relay/src/app.ts:57`, `packages/relay/src/oauth.ts:157–168`, `packages/relay/src/device.ts:182–188`  
**Status:** [x] fixed in 07dbeb4

`cookieParser()` initialized without a signing secret. Flow-state cookies like `login_pending_${pendingId}` carry `redirectUri` used by `issueAuthCode()`. Tampered cookies could redirect auth codes to an attacker-registered URI.

**Fix:** `cookieParser(requireEnv("COOKIE_SECRET"))` and read via `req.signedCookies`.

---

### L3 — relay: Auth code deleted before `client_secret` verified
**File:** `packages/relay/src/oauth.ts:427–449`  
**Status:** [x] fixed in 00d90b3

`handleAuthorizationCodeGrant` deletes the auth code before looking up the OAuth client and checking `client_secret`. Targeted DoS: attacker who intercepts a code submits it with wrong `client_secret` → code consumed, no token issued, legitimate client's code is gone.

**Fix:** Move `client_secret` check to before `authCode.delete()`.

---

### L4 — relay: Per-user rate limits are in-process only
**File:** `packages/relay/src/router.ts:73–110`  
**Status:** [x] documented in 07dbeb4

`toolCallTimestamps` and `expensiveToolTimestamps` are module-level Maps. Lost on restart; not shared across instances. A restart resets every user's rate-limit window.

**Fix:** Document single-instance limitation. For multi-instance, back with Redis using `express-rate-limit`'s store interface.

---

### L5 — relay: Hub `instructions` field has no size cap
**File:** `packages/relay/src/hub.ts:606–609`  
**Status:** [x] fixed in 00d90b3

`instructions` validated as string (type only), no max length. Stored in DB and returned in every `list_shares` response. A compromised hub can write up to the WS message cap per share.

**Fix:** Reject `instructions` longer than e.g. 4096 characters in the share-validation loop.

---

### L6 — hub: `getent`/`id` calls missing `--` end-of-options sentinel
**File:** `packages/hub/src/identity.ts:42,68`  
**Status:** [x] fixed in d58bf05

```ts
execFileAsync("getent", ["passwd", username])
execFileAsync("id", ["-G", username])
```

A username claim starting with `-` may be interpreted as a flag. Both calls fail gracefully (null → identity rejected), but this is fragile.

**Fix:** `["passwd", "--", username]` and `["-G", "--", username]`.

---

### L7 — hub: `sourceEnvFile` doesn't strip shell-style quotes
**File:** `packages/hub/src/index.ts:69`  
**Status:** [x] fixed in d58bf05

`CONSTELLATION_HUB_TOKEN="abc123"` sets the token to the literal string `"abc123"` (with quotes), not `abc123`. Silent authentication failure on every hub start.

**Fix:** Strip a single pair of matching surrounding quotes after trim, or document the format and reject quoted values.

---

### L8 — hub: `file_info` leaks absolute symlink targets outside share
**File:** `packages/shared/src/executor/tools/fs-read.ts:112–114`  
**Status:** [x] fixed in 27e08ea (same code path as M7)

See also M7 (same code path, overlapping with hub review finding). Users with read access to a share containing an out-of-share symlink receive the absolute target path in `file_info` results.

**Fix:** Return target relative to share root only if it resolves within bounds, or omit unconditionally for out-of-share targets.

---

### L9 — hub: Share path not validated as absolute
**File:** `packages/hub/src/config.ts:213–215`, `packages/hub/src/paths.ts:15`  
**Status:** [x] fixed in d58bf05

`parseShares` does not verify `path` is absolute before `realpath`. A relative path resolves against `process.cwd()`, which varies by how the hub is started.

**Fix:** `if (!path.startsWith('/')) throw new Error('shares[N].path must be absolute')` in `parseShares`.

---

### L10 — hub: `request_id` length unbounded
**File:** `packages/hub/src/index.ts:214`  
**Status:** [x] fixed in d58bf05

`request_id` is checked as a string with no max length. A relay injecting a megabyte-long `request_id` bloats every audit log entry and log line for that request.

**Fix:** Reject `request_id` longer than e.g. 200 characters in the same guard block as the string type check.

---

### L11 — shared: `writeFile` `fs.mkdir` outside TOCTOU-protected window
**File:** `packages/shared/src/executor/tools/fs-write.ts:29–33`  
**Status:** [x] fixed in 24386e4

`assertPathStable` runs, then `fs.mkdir` runs outside that protection. Race: swap intermediate component to symlink → `mkdir -p` creates directories outside the share. `openNoFollow` still guards the actual file write, but directory tree can be created outside the share.

**Fix:** Use `openNoFollow`-compatible mkdir, or re-validate after mkdir before the open.

---

### L12 — shared: `createDirectory` same unprotected `mkdir` race
**File:** `packages/shared/src/executor/tools/fs-write.ts:45–48`  
**Status:** [x] fixed in 24386e4

Same issue as L11 but more direct — `createDirectory` is only `assertPathStable` + `mkdir`.

---

### L13 — shared: `copyRecursive` uses `fs.copyFile` without `O_NOFOLLOW` on destination
**File:** `packages/shared/src/executor/tools/fs-write.ts:194`  
**Status:** [x] fixed in 24386e4

`COPYFILE_EXCL` rejects existing destinations but does NOT set `O_NOFOLLOW`. Attacker plants a symlink at `dst` pointing outside the share → `copyFile` writes file content to that outside path.

**Fix:** Open destination with `openNoFollow` (getting a file descriptor) and use `fs.copyFile(src, dstFd)` form, or check that destination is not a symlink via `lstat` before `copyFile`.

---

### L14 — shared: picomatch `exclude`/`file_glob` patterns not ReDoS-validated
**Files:** `packages/shared/src/executor/tools/fs-read.ts:58`, `packages/shared/src/executor/tools/fs-search.ts:151`  
**Status:** [x] fixed in 24386e4

User-supplied regex patterns already go through `safe-regex2`. But `exclude` array (picomatch) and `file_glob` string are not validated. picomatch converts globs to regex internally; crafted glob with nested quantifiers could cause ReDoS.

**Fix:** Run `safeRegex(picomatch.makeRe(pattern).source)` on `exclude` entries and `file_glob` before passing to picomatch.

---

### L15 — shared: `err.path` logged unredacted
**File:** `packages/shared/src/logger.ts:6`  
**Status:** [x] fixed in 24386e4

Pino redact list covers `token`, `auth`, `password`, `secret` and their `*.field` variants. When a raw `ErrnoException` is logged, `err.path` (absolute filesystem path) is serialized into the log entry and visible to operators / log-forwarding pipelines.

**Fix:** Add `"err.path"` to the pino redact paths list, or log `{ err: { message: err.message, code: err.code } }` instead of the full error object.

---

### L16 — shared: `safeRealpath` unbounded recursion
**File:** `packages/shared/src/executor/tools/safe-path.ts:8–23`  
**Status:** [x] fixed in 24386e4

`safeRealpath` recurses up to the filesystem root on ENOENT. A path with ~1000 non-existent components fits within the 4096-byte Linux path limit and generates a matching call stack depth, potentially causing a stack overflow / unhandled promise rejection (DoS).

**Fix:** Add a depth counter; throw `"Cannot resolve path"` after e.g. 50 levels beyond the boundary root.

---

### L17 — cli: `--admin-token` flag visible in `/proc/cmdline`/`ps`
**Files:** `packages/cli/src/cli/relay.ts:734,754`  
**Status:** [x] fixed in 4ce9ab4

`relay user promote/demote --admin-token <token>` exposes the admin token in process args. Any local user (same machine) can read `/proc/<pid>/cmdline` during execution.

**Fix:** Remove the `--admin-token` flag entirely; require `RELAY_ADMIN_TOKEN` env var exclusively.

---

### L18 — cli/hub: `writeFileSync` `mode` doesn't chmod existing files
**File:** `packages/hub/src/cli.ts:488`  
**Status:** [x] fixed in 4ce9ab4

`writeFileSync(envFile, content, { mode: 0o600 })` — on Linux/macOS, `mode` only applies when creating the file, not when overwriting an existing one. If `hub.env` exists at `0o644`, the new token is written to a world-readable file. `warnIfEnvFileInsecure` detects this reactively after the write.

**Fix:** Add `chmodSync(envFile, 0o600)` before `writeFileSync`, or adopt the `atomicWriteFileSync` pattern (write to temp with correct mode, rename).

---

### L19 — node: Service files written without explicit permissions; Windows TOCTOU
**File:** `packages/node/src/cli/service.ts:68,105,132`  
**Status:** [x] fixed in 4ce9ab4

`writeFileSync(unitPath, unit)` with no `mode` — permissions are `0o666 & ~umask`, typically `0o644`. Windows XML temp file (line 131) uses a predictable path at `C:\Temp\constellation-node.xml` vulnerable to swap before `schtasks /Create` reads it.

**Fix:** Add `{ mode: 0o600 }` to unit/plist `writeFileSync` calls. For Windows, use `os.tmpdir()` with a random suffix in the filename.

---

### L20 — node: `sysdQuote()` doesn't escape `$` or `\`
**File:** `packages/node/src/cli/service.ts:40–43`  
**Status:** [x] fixed in 4ce9ab4

`sysdQuote()` only escapes `"`. systemd expands `$VAR` references in `ExecStart` lines; a binary path containing `$` would cause systemd variable expansion instead of treating it as literal. A trailing `\` corrupts the unit.

**Fix:**
```ts
function sysdQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/\$/g, "\\$").replace(/"/g, '\\"')}"`;
}
```

---

### L21 — node-gui: Share names starting with `--` treated as CLI flags
**File:** `packages/node-gui/src-tauri/src/paths.rs:40–47`  
**Status:** [x] fixed in 4ce9ab4

Share names passed as positional arguments to the CLI with no format validation. A share named `--relay` becomes `constellation node paths add --relay /real/path`.

**Fix:** Reject share names starting with `-`, or insert `--` sentinel: `vec!["node", "paths", "add", "--", &share, &path]`.

---

## Supply Chain

| Package | Finding | Severity |
|---------|---------|---------|
| root | `esbuild@0.27.3–0.28.0` (transitive via `@yao-pkg/pkg`) — dev server file read on Windows | LOW (dev-only, Windows-only) |

No runtime CVEs found. All production deps are current major versions.

---

## Informational / Positives Noted
- No command injection surface in shared executor — zero `child_process` calls
- `ws` TLS validation correct throughout; `assertSecureRelayUrl` enforced for all non-loopback WS
- Token storage: node config files all `0o600` via `atomicWriteFileSync`; config dir `0o700`
- All `systemctl`/`launchctl`/`schtasks` invocations use `execFileSync` with array args — no shell interpolation
- Prisma queries use typed parameters; the one raw query (`pruneActivityLog`) uses tagged-template parameterization
- `safe-regex2` guards all relay-supplied regex patterns in `find_files`/`grep_files`
- bcrypt cost factor 12 for passwords; `timingSafeEqual` for all token comparisons; 256-bit entropy throughout
- `js-yaml` v4 uses safe schema by default (no arbitrary JS object deserialization)
- node-gui: `node_token` never crosses Tauri IPC boundary; no localStorage/sessionStorage usage; no external CDN scripts
- PKCE (S256) mandatory for all auth codes; `code_challenge` required and enforced as NOT NULL in schema
