-- Client ID Metadata Document (CIMD) support: rows whose id is an HTTPS document URL
-- cache the fetched metadata. Existing rows are DCR or static clients, so the default
-- of false is correct for all of them.
ALTER TABLE "oauth_clients" ADD COLUMN "is_metadata_document" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "oauth_clients" ADD COLUMN "client_name" TEXT;
ALTER TABLE "oauth_clients" ADD COLUMN "metadata_expires_at" TIMESTAMP(3);
