/**
 * Interprets a queue_timeout config value and returns the resolved number of
 * milliseconds a request may wait for a free worker before being rejected.
 *
 * - Float (!Number.isInteger): fraction of rpcTimeoutMs.
 *   E.g. 0.5 → half the RPC timeout.
 * - Integer (Number.isInteger): explicit seconds, clamped to rpcTimeoutMs.
 *   E.g. 5 → 5 000 ms. Note: in YAML/JSON 1.0 parses as integer 1 (1 s),
 *   so expressing "100 % of the RPC timeout" as a fraction is not directly
 *   possible. Values above 0.8 (or the integer equivalent) are not recommended
 *   — a request that spends most of the RPC budget waiting in queue has very
 *   little time left for actual processing and is likely to time out even if
 *   a worker does pick it up.
 *
 * Intentionally lives in @constellation/shared rather than packages/hub so
 * that packages/node can import it when it gains its own concurrency-limiting
 * config. Do not inline this back into hub. See ADR 0016.
 */
export function resolveQueueTimeout(queueTimeout: number, rpcTimeoutMs: number): number {
  return Number.isInteger(queueTimeout)
    ? Math.min(queueTimeout * 1000, rpcTimeoutMs)
    : queueTimeout * rpcTimeoutMs;
}
