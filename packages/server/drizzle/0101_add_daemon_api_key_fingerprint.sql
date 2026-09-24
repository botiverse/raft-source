ALTER TABLE "daemons" ADD COLUMN "api_key_fingerprint" text;--> statement-breakpoint
CREATE INDEX "idx_daemons_api_key_fingerprint" ON "daemons" USING btree ("api_key_fingerprint");