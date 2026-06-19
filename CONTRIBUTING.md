# Contributing

- [Development Setup](#development-setup)
- [Running the Relay](#running-the-relay)
- [Running the Node](#running-the-node)
- [Running the Node GUI](#running-the-node-gui)
- [Tests and Linting](#tests-and-linting)
- [Code Standards](#code-standards)
- [Pull Requests](#pull-requests)

---

## Development Setup

**Prerequisites:** Node.js 24+ (matches CI), Docker (for Postgres)

```sh
git clone https://github.com/Mahasamuha/constellation-mcp.git
cd constellation-mcp
npm install
```

`npm install` at the root installs dependencies for all workspaces (`packages/relay`, `packages/node`, `packages/hub`, `packages/cli`, `packages/shared`, `packages/node-gui`).

---

## Running the Relay

### 1. Start Postgres

The relay requires a running Postgres instance. The easiest way in development is Docker:

```sh
docker run -d \
  --name constellation-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=constellation \
  -p 5432:5432 \
  postgres:16
```

### 2. Configure environment

```sh
cp packages/relay/.env.example packages/relay/.env
```

The example file is pre-configured for local development (`AUTH_MODE=local`, `RELAY_URL=http://localhost:3000`, `DATABASE_URL` pointing to the Docker container above). No edits are needed to get started.

### 3. Apply migrations

```sh
cd packages/relay
npx prisma migrate dev
cd ../..
```

Migrations only need to be run once per schema change. When pulling new commits, re-run this if `packages/relay/prisma/migrations/` has changed.

### 4. Start the relay

Open two terminals:

**Terminal 1** — compile and watch for changes:
```sh
npm run dev -w packages/relay
```

**Terminal 2** — run the compiled output:
```sh
node packages/relay/dist/index.js
```

For readable logs, pipe through `pino-pretty`:
```sh
node packages/relay/dist/index.js | npx pino-pretty
```

Restart the process in Terminal 2 after the compiler finishes rebuilding. The relay will be available at `http://localhost:3000`. On first visit the setup wizard will prompt you to create an account.

---

## Running the Node

### 1. Build and watch

The `constellation` binary lives in `packages/cli`, which bundles `@constellation/node` and `@constellation/hub` from their built `dist/` output. Open two terminals:

**Terminal 1** — rebuild `packages/node` on change:
```sh
npm run dev -w packages/node
```

**Terminal 2** — rebundle the CLI on change:
```sh
npm run dev -w packages/cli
```

### 2. Run in foreground mode

Point the node at your local relay and run it directly in the current process:

```sh
CONSTELLATION_CONFIG_DIR=/tmp/constellation-dev \
  node packages/cli/dist/cli.js node start --foreground
```

Using a temporary config directory keeps dev credentials separate from any real node config. If this is a fresh directory, run `init` first:

```sh
CONSTELLATION_CONFIG_DIR=/tmp/constellation-dev \
  node packages/cli/dist/cli.js node init --relay http://localhost:3000
```

For readable logs:
```sh
LOG_LEVEL=debug CONSTELLATION_CONFIG_DIR=/tmp/constellation-dev \
  node packages/cli/dist/cli.js node start --foreground | npx pino-pretty
```

### Hub mode

The hub (`constellation hub ...` — see `packages/hub/src/cli.ts` and `packages/hub/src/`) is a separate package for machines shared by multiple OS users. It's Linux-only and needs `CAP_SETUID`/`CAP_SETGID` plus multiple real local accounts to exercise end-to-end, so it's impractical to spin up casually in dev.

For most changes, the unit tests under `packages/hub/src/*.test.ts` (config, identity resolution, permissions, subnode spawning) give fast coverage of the core logic without a live setup. If you do need to validate config parsing or the operator commands without spawning subnodes, `constellation hub validate-config` and `constellation hub status` are safe to run as a normal user. Full deployment and security-model details live in [`docs/hub.md`](docs/hub.md).

---

## Running the Node GUI

The GUI is a Tauri v2 app — a React/TypeScript frontend with a Rust backend. It requires Rust in addition to Node.

### Prerequisites

Install Rust via [rustup](https://rustup.rs/):

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Install the system dependencies Tauri needs for your platform — see the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/). On Linux this typically means a few GTK/WebKit packages; on macOS and Windows Xcode CLT or the VS Build Tools respectively.

### Install dependencies

From the `packages/node-gui` directory:

```sh
cd packages/node-gui
npm install
```

### Start in dev mode

```sh
npm run tauri dev
```

This compiles the Rust backend and starts the Vite dev server simultaneously. Hot-reload applies to the React frontend; changes to Rust code trigger a Rust recompile and app restart. The first run takes longer because Cargo downloads and compiles all Rust dependencies.

The GUI expects the `constellation` CLI binary to be on `PATH`. Point it at the locally built CLI:

```sh
# From the repo root, after building node and cli:
npm run build -w packages/node
npm run build -w packages/cli
export PATH="$PWD/packages/cli/dist:$PATH"
```

### Build a release binary

```sh
npm run tauri build
```

Artifacts are written to `packages/node-gui/src-tauri/target/release/bundle/`.

---

## Tests and Linting

```sh
# Run all tests once
npm test

# Run tests in watch mode
npm run test:watch

# Lint all packages
npm run lint

# Type-check the node and CLI (relay type errors surface via tsc --watch during dev)
npm run typecheck -w packages/node
npm run typecheck -w packages/cli
```

Tests live alongside source files as `*.test.ts`. Vitest discovers them automatically from `packages/*/src/**/*.test.ts`.

---

## Code Standards

- **TypeScript throughout.** No `any` unless unavoidable, and with a comment explaining why.
- **No comments explaining what the code does.** Only comment non-obvious constraints, workarounds, or invariants — things that would surprise a reader who understands the language.
- **No speculative abstractions.** Don't generalise until there are at least three concrete cases. Prefer a few repeated lines to a premature helper.
- **No unnecessary error handling.** Don't add fallbacks for conditions that can't happen. Validate at system boundaries (user input, external APIs) and trust internal guarantees.
- **Security first.** Never log tokens or secrets in plaintext. Validate all path inputs through the node's two-step check (allowlist + traversal). Don't silently swallow errors that could mask a security issue.
- **Pino for logging.** Use `createLogger(name)` from `@constellation/shared`. Structured fields over string interpolation. Never log at a level lower than the operation warrants.
- **Prisma for all database access.** No raw SQL except where Prisma can't express the query.

---

## Pull Requests

- **One concern per PR.** A bug fix and a refactor touching the same file belong in separate PRs.
- **Tests for new behaviour.** If you're adding a code path that can be unit tested, add the test. The existing test files in each package show the pattern.
- **Pass CI before requesting review.** All of `npm test`, `npm run lint`, and a successful relay compile are required.
- **PR title:** imperative mood, lowercase, under 72 characters. Examples: `fix path traversal check for symlinked directories`, `add relay users CLI commands`.
- **PR description:** explain *why*, not *what*. The diff shows what changed; the description should explain the motivation, any trade-offs considered, and how to test it manually if the change is not covered by automated tests.
- **Keep `main` releasable.** Don't merge work-in-progress. If a feature needs multiple PRs, use a feature branch as the base and merge to `main` only when complete.
