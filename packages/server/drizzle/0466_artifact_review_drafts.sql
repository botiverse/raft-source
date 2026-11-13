-- Batch comments (S8, docs/development/workspace-artifacts.md): a person's
-- review drafts (`app_artifacts.comment_drafts`, seen only by their author,
-- purged 30 days after their last change), posted reviews
-- (`app_artifacts.reviews`: author, version, the attempt's key, the summary)
-- and the review that posted a comment (`comments.review_id`). Only
-- app_artifacts tables, all behind workspace_artifacts_v0.
--
-- Bounded lock wait: the new column, foreign key and index on
-- app_artifacts.comments lock it briefly; give up after 5s (the deploy
-- retries) rather than queue its writes behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "app_artifacts"."comment_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"author_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"path" text,
	"anchor" jsonb,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comment_drafts_anchor_needs_path" CHECK ("app_artifacts"."comment_drafts"."path" IS NOT NULL OR "app_artifacts"."comment_drafts"."anchor" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "app_artifacts"."reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"author_type" text NOT NULL,
	"author_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"client_key" text,
	"request_digest" text NOT NULL,
	"summary_comment_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_author_type" CHECK ("app_artifacts"."reviews"."author_type" IN ('user', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "app_artifacts"."comments" ADD COLUMN "review_id" text;--> statement-breakpoint
ALTER TABLE "app_artifacts"."comment_drafts" ADD CONSTRAINT "comment_drafts_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "app_artifacts"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."reviews" ADD CONSTRAINT "reviews_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "app_artifacts"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_comment_drafts_author_item" ON "app_artifacts"."comment_drafts" USING btree ("author_id","item_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_comment_drafts_updated" ON "app_artifacts"."comment_drafts" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_reviews_item" ON "app_artifacts"."reviews" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_reviews_client_key" ON "app_artifacts"."reviews" USING btree ("item_id","author_type","author_id","client_key") WHERE "app_artifacts"."reviews"."client_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "app_artifacts"."comments" ADD CONSTRAINT "comments_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "app_artifacts"."reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_comments_review" ON "app_artifacts"."comments" USING btree ("review_id") WHERE "app_artifacts"."comments"."review_id" IS NOT NULL;