-- Rename BrokerPathFilter -> RelayPathFilter, for consistency with the broker->relay rename.

-- Rename broker_path_filters -> relay_path_filters, and its constraints.
ALTER TABLE "broker_path_filters" RENAME TO "relay_path_filters";
ALTER TABLE "relay_path_filters" RENAME CONSTRAINT "broker_path_filters_pkey" TO "relay_path_filters_pkey";
ALTER TABLE "relay_path_filters" RENAME CONSTRAINT "broker_path_filters_scope_user_id_fkey" TO "relay_path_filters_scope_user_id_fkey";
ALTER TABLE "relay_path_filters" RENAME CONSTRAINT "broker_path_filters_scope_executor_id_fkey" TO "relay_path_filters_scope_executor_id_fkey";
