# ADR 0013: Shared Agent Config Changes Require Process Restart (No Live Reload)

**Status:** Accepted  
**Date:** 2026-06-06

## Context

The shared agent's config file contains security-sensitive settings: identity
resolution tiers, label permission configs, and UID restriction ranges. The question
was whether to support live config reload (e.g. via SIGHUP) or require a process
restart for config changes to take effect.

## Decision

Config changes require a full process restart. There is no live sync path, no SIGHUP
reload, and no mid-flight config update mechanism. If a live reload path exists in the
codebase for any prior iteration, it must be removed.

On restart:
- Incoming RPCs are rejected immediately with `AGENT_RESTARTING — retry after 45 seconds`.
- In-flight requests drain with a 30-second timeout, then the process exits.
- The 45-second retry window is above the drain timeout plus process startup time.

On shutdown (SIGTERM):
- Incoming RPCs are rejected immediately with `AGENT_SHUTTING_DOWN`.
- In-flight requests drain with a 30-second timeout.
- Pooled subagents with no in-flight work receive SIGTERM immediately.
- Subagents with in-flight work receive SIGTERM after their current response is sent or
  the 30-second limit is reached, whichever comes first.

## Rationale

The shared agent's config includes identity resolution (which OS user executes a
request), label permission rules (who can access what), and UID restriction ranges
(which OS users can be impersonated). These settings have direct security implications.

A live reload that applies mid-flight — between identity resolution and subagent spawn,
or between permission check and dispatch — could create a window where the old config's
security checks have run but the new config's restrictions haven't yet applied. Making
config take effect only on a clean process start eliminates this window entirely.

The operational cost is low: shared agent config changes are infrequent (admin-driven,
not user-driven), and a clean restart with a 45-second retry window is an acceptable
interruption for a background service.

## Alternatives Considered

**SIGHUP reload with in-flight quiescence:** the process quiesces (no new RPCs
accepted), waits for in-flight requests to complete, then reloads config and resumes.
Correct but complex: requires tracking quiescence state, handling the window between
SIGHUP and quiescence, and ensuring no partial config state is visible. Rejected as
over-engineered for the expected frequency of config changes.

**Live reload without quiescence:** config changes take effect immediately for new RPCs
while existing RPCs complete under old config. Rejected because it creates a period
where different requests may see different permission states — auditing becomes unclear
and edge cases around concurrent identity checks are hard to reason about.

## Consequences

- `constellation shared-agent validate-config --config <path>` provides a dry-run
  check before restart. Operators should validate before applying.
- Config changes to identity, permissions, or UID restrictions take effect atomically
  on the next clean process start.
- Subagent pool state is lost on restart. All active subagent processes are terminated
  as part of the shutdown sequence.
- The 30-second drain timeout is hard-coded. A future configurable drain timeout is a
  reasonable follow-on if operators report issues with long-running RPC operations
  (e.g., `grep_files` over large trees).
