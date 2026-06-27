# ADR 0015: Bundle Prism.js for File Browser Syntax Highlighting

**Status:** Accepted
**Date:** 2026-06-10

## Context

The MCP Apps file browser (`packages/telescope`, see `plans/relay-file-viewer.md`)
renders file contents with syntax highlighting. The initial implementation loaded
highlight.js from cdnjs via a `<script>`/`<link>` tag in `index.html`, with a matching
CSP `resourceDomains: ["https://cdnjs.cloudflare.com"]` on the `ui://` resource.

CDN-based loading proved unreliable across MCP Apps hosts — it works on claude.ai
desktop but is blocked on claude.ai mobile and other non-claude.ai clients, leaving
the file browser without highlighting (or broken styling) on those clients.

## Decision

Bundle [Prism.js](https://prismjs.com/) directly into `packages/telescope`'s single-file
build (`vite-plugin-singlefile` inlines it into `dist/app.html`) instead of loading
highlight.js from a CDN. The CSP `resourceDomains` allowance for cdnjs is removed —
the UI resource now makes no external network requests.

Rather than the full language grammar set, a fixed list of components is imported in
`packages/telescope/src/prism.ts`:

- Python
- JavaScript / TypeScript
- C# (csharp)
- PHP
- Rust
- JSON
- YAML
- Markdown
- Shell (bash)
- SQL
- C / C++
- Go
- Dockerfile
- TOML

This list is **not exhaustive** — it covers the languages most commonly encountered
across Constellation hosts today. Adding another language is a one-line addition
(`import "prismjs/components/prism-<lang>"` plus an entry in `EXTENSION_LANGUAGE`),
respecting the dependency ordering documented in `prism.ts` (e.g. `prism-c` before
`prism-cpp`, `prism-markup-templating` before `prism-php`). Files with extensions
that aren't mapped to a language render as plain (escaped) text rather than failing.

## Rationale

- **Reliability over CDN**: bundling guarantees highlighting works identically on
  every MCP Apps host, including offline/air-gapped deployments.
- **Bundle size is acceptable**: the cherry-picked language set keeps `dist/app.html`
  around 600KB (≈165KB gzipped) — large relative to a bare React app, but the file
  browser is a single inlined resource fetched once per session via `resources/read`,
  not a page asset reloaded per request.
- **Prism over highlight.js**: Prism's per-language components tree-shake cleanly
  with ESM imports (`import "prismjs/components/prism-python"`), whereas
  highlight.js's common bundle is harder to subset without its build tooling.
- **No language auto-detection**: Prism (unlike highlight.js) has no built-in
  `highlightAuto`. Language is instead derived from the file extension
  (`languageForPath` in `prism.ts`), which is simpler and avoids
  misdetection on short or ambiguous files.

## Alternatives Considered

**Vendor highlight.js instead of switching to Prism**: would have kept the existing
`hljs.highlightAuto` auto-detection, but highlight.js's "common languages" bundle is
~150KB and not easily trimmed to a custom language set without its CLI build step.
Prism's per-component imports are bundler-native.

**Keep CDN loading, accept degraded experience on unsupported clients**: rejected —
defeats the purpose of a polished inline file viewer if highlighting silently breaks
on mobile and non-claude.ai clients, which are a primary target per
`plans/relay-file-viewer.md`.

## Consequences

- The project's private deferred-work backlog (not part of this repo) has a stale
  "Unbundle highlight.js from the File Viewer" entry, written before the switch to
  Prism — it should be retired or rewritten against Prism if CDN whitelisting ever
  becomes consistent enough to revisit.
- Adding a new language requires a `packages/telescope` rebuild (`dist/app.html` is
  copied into the relay image at Docker build time — see `packages/relay/Dockerfile`).
