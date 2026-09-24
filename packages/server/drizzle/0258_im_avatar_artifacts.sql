ALTER TABLE "external_projection_avatar_artifacts" DROP CONSTRAINT "external_avatar_shape_valid";--> statement-breakpoint
ALTER TABLE "external_projection_avatar_artifacts" ADD COLUMN "source_locator_digest" text;--> statement-breakpoint
ALTER TABLE "external_projection_avatar_artifacts" ADD COLUMN "storage_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_avatar_owner_pending" ON "external_projection_avatar_artifacts" USING btree ("owner_type","owner_id") WHERE "external_projection_avatar_artifacts"."state" = 'pending';--> statement-breakpoint
ALTER TABLE "external_projection_avatar_artifacts" ADD CONSTRAINT "external_avatar_shape_valid" CHECK ("external_projection_avatar_artifacts"."owner_type" IN ('user', 'agent', 'external_projection')
      AND length(btrim("external_projection_avatar_artifacts"."owner_id")) > 0
      AND "external_projection_avatar_artifacts"."source_digest" ~ '^[0-9a-f]{64}$'
      AND ("external_projection_avatar_artifacts"."source_locator_digest" IS NULL OR "external_projection_avatar_artifacts"."source_locator_digest" ~ '^[0-9a-f]{64}$')
      AND ("external_projection_avatar_artifacts"."storage_key" IS NULL OR (
        length(btrim("external_projection_avatar_artifacts"."storage_key")) > 0 AND length("external_projection_avatar_artifacts"."storage_key") <= 1024
      ))
      AND (("external_projection_avatar_artifacts"."source_locator_digest" IS NULL AND "external_projection_avatar_artifacts"."storage_key" IS NULL)
        OR ("external_projection_avatar_artifacts"."source_locator_digest" IS NOT NULL AND "external_projection_avatar_artifacts"."storage_key" IS NOT NULL))
      AND "external_projection_avatar_artifacts"."public_url" ~ '^https://'
      AND "external_projection_avatar_artifacts"."mime_type" IN ('image/png', 'image/jpeg', 'image/webp')
      AND "external_projection_avatar_artifacts"."byte_size" > 0 AND "external_projection_avatar_artifacts"."byte_size" <= 5242880
      AND "external_projection_avatar_artifacts"."width" > 0 AND "external_projection_avatar_artifacts"."width" <= 4096
      AND "external_projection_avatar_artifacts"."height" > 0 AND "external_projection_avatar_artifacts"."height" <= 4096
      AND "external_projection_avatar_artifacts"."artifact_revision" > 0
      AND "external_projection_avatar_artifacts"."state" IN ('pending', 'active', 'revoked')
      AND ("external_projection_avatar_artifacts"."state" <> 'pending' OR ("external_projection_avatar_artifacts"."source_locator_digest" IS NOT NULL AND "external_projection_avatar_artifacts"."storage_key" IS NOT NULL)));