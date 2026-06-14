-- Rename SharedPathLabel -> HubPathLabel, for consistency with the shared-agent->hub rename.

-- Rename shared_path_labels -> hub_path_labels, and its constraints/index.
ALTER TABLE "shared_path_labels" RENAME TO "hub_path_labels";
ALTER TABLE "hub_path_labels" RENAME CONSTRAINT "shared_path_labels_pkey" TO "hub_path_labels_pkey";
ALTER TABLE "hub_path_labels" RENAME CONSTRAINT "shared_path_labels_executor_id_fkey" TO "hub_path_labels_executor_id_fkey";
ALTER INDEX "shared_path_labels_executor_id_label_key" RENAME TO "hub_path_labels_executor_id_label_key";
