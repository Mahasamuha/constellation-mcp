-- isPathFiltered queries relay_path_filters by scope_user_id (plus an OR over
-- scope_executor_id IS NULL / = executor_id) on every tool call — the hottest
-- read path in the relay — with no index backing the column.
CREATE INDEX "relay_path_filters_scope_user_id_idx" ON "relay_path_filters"("scope_user_id");

-- Composite index lets the planner satisfy the scope_executor_id OR branch
-- (NULL or a specific executor) via a single index scan instead of a full
-- table scan once a user accumulates more than a handful of filters.
CREATE INDEX "relay_path_filters_scope_user_id_scope_executor_id_idx" ON "relay_path_filters"("scope_user_id", "scope_executor_id");
