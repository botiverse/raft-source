CREATE TABLE "message_translations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"source_lang" text NOT NULL,
	"source_confidence" integer DEFAULT 0 NOT NULL,
	"target_lang" text NOT NULL,
	"provider" text NOT NULL,
	"provider_version" text NOT NULL,
	"placeholder_policy_version" text NOT NULL,
	"status" text NOT NULL,
	"skip_reason" text,
	"quota_reason" text,
	"translated_content" text,
	"protected_entities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_chars" integer DEFAULT 0 NOT NULL,
	"provider_billed_chars" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "translation_quota_buckets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"bucket_date" text NOT NULL,
	"mode" text NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"requested_chars" integer DEFAULT 0 NOT NULL,
	"provider_billed_chars" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "translation_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "preferred_language" text;--> statement-breakpoint
ALTER TABLE "message_translations" ADD CONSTRAINT "message_translations_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_translations" ADD CONSTRAINT "message_translations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_quota_buckets" ADD CONSTRAINT "translation_quota_buckets_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_message_translations_cache_key" ON "message_translations" USING btree ("message_id","content_hash","source_lang","target_lang","provider_version","placeholder_policy_version");--> statement-breakpoint
CREATE INDEX "idx_message_translations_server_accessed" ON "message_translations" USING btree ("server_id","last_accessed_at");--> statement-breakpoint
CREATE INDEX "idx_message_translations_server_created" ON "message_translations" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_translation_quota_bucket" ON "translation_quota_buckets" USING btree ("server_id","actor_type","actor_id","bucket_date","mode");--> statement-breakpoint
CREATE INDEX "idx_translation_quota_server_date" ON "translation_quota_buckets" USING btree ("server_id","bucket_date");