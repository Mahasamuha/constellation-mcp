import escHtml from "escape-html";
import { pageStyle } from "./page-style.js";
import type { ClientDisclosure } from "./oauth-clients.js";

/** Client identity, redirect host, and loopback warning shared by the login and consent pages. */
export function clientDisclosureHtml(info: ClientDisclosure): string {
  const name = info.clientName ?? info.clientId;
  const identity = info.verifiedHost
    ? `Client identity published by <strong>${escHtml(info.verifiedHost)}</strong>.`
    : "This client registered itself; its name and identity are not verified.";
  const loopbackWarning = info.isLoopbackRedirect
    ? `<p class="warning">Access will be returned to an application running on this computer. Only continue if you started this connection yourself.</p>`
    : "";
  return `<div class="client-info">
      <p>Signing in to grant <strong>${escHtml(name)}</strong> access to your Constellation files.</p>
      <p>${identity}</p>
      <p>After sign-in you will be redirected to <strong>${escHtml(info.redirectHost)}</strong>.</p>
    </div>
    ${loopbackWarning}`;
}

/** OIDC-mode interstitial shown before the upstream IdP (named to avoid device.ts's consentPage). */
export function authorizeConsentPage(pendingId: string, csrfToken: string, info: ClientDisclosure): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Constellation — Authorize access</title>${pageStyle()}
</head>
<body>
  <div class="card">
    <h1>Authorize access</h1>
    ${clientDisclosureHtml(info)}
    <form method="POST" action="/oauth/authorize/consent">
      <input type="hidden" name="pending" value="${escHtml(pendingId)}">
      <input type="hidden" name="csrf_token" value="${escHtml(csrfToken)}">
      <div class="actions">
        <button type="submit" name="action" value="approve">Continue to sign in</button>
        <button type="submit" name="action" value="deny" class="secondary">Deny</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

export function loginPage(pendingId: string, error?: string, clientInfo?: ClientDisclosure): string {
  const clientBanner = clientInfo ? clientDisclosureHtml(clientInfo) : "";
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Constellation — Sign in</title>${pageStyle()}
</head>
<body>
  <div class="card">
    <h1>Sign in</h1>
    ${clientBanner}
    ${error ? `<p class="error">${escHtml(error)}</p>` : ""}
    <form method="POST" action="/auth/login">
      <input type="hidden" name="pending" value="${escHtml(pendingId)}">
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username" autofocus required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}
