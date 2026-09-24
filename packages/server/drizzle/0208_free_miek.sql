CREATE TABLE "activity_sync_changes" (
	"server_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"filter" text NOT NULL,
	"window_id" text DEFAULT 'main' NOT NULL,
	"seq" bigint NOT NULL,
	"row_id" uuid,
	"row_version" bigint,
	"kind" text NOT NULL,
	"payload" jsonb,
	"tombstone_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_sync_changes_server_id_principal_id_filter_window_id_seq_pk" PRIMARY KEY("server_id","principal_id","filter","window_id","seq"),
	CONSTRAINT "activity_sync_changes_shape" CHECK (("activity_sync_changes"."kind" = 'upsert' AND "activity_sync_changes"."row_id" IS NOT NULL AND "activity_sync_changes"."row_version" IS NOT NULL
          AND "activity_sync_changes"."payload" IS NOT NULL AND "activity_sync_changes"."tombstone_reason" IS NULL)
      OR ("activity_sync_changes"."kind" = 'tombstone' AND "activity_sync_changes"."row_id" IS NOT NULL AND "activity_sync_changes"."row_version" IS NOT NULL
          AND "activity_sync_changes"."payload" IS NULL AND "activity_sync_changes"."tombstone_reason" IS NOT NULL)
      OR ("activity_sync_changes"."kind" = 'scope' AND "activity_sync_changes"."row_id" IS NULL AND "activity_sync_changes"."row_version" IS NULL
          AND "activity_sync_changes"."payload" IS NOT NULL AND "activity_sync_changes"."tombstone_reason" IS NULL)),
	CONSTRAINT "activity_sync_changes_seq_positive" CHECK ("activity_sync_changes"."seq" > 0),
	CONSTRAINT "activity_sync_changes_row_version_positive" CHECK ("activity_sync_changes"."row_version" IS NULL OR "activity_sync_changes"."row_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "activity_sync_principal_authorities" (
	"server_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"row_version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_sync_principal_authorities_server_id_principal_id_pk" PRIMARY KEY("server_id","principal_id"),
	CONSTRAINT "activity_sync_principal_row_version_nonnegative" CHECK ("activity_sync_principal_authorities"."row_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "activity_sync_row_authorities" (
	"server_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"last_version" bigint NOT NULL,
	"active" boolean NOT NULL,
	"payload_digest" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_sync_row_authorities_server_id_principal_id_row_id_pk" PRIMARY KEY("server_id","principal_id","row_id"),
	CONSTRAINT "activity_sync_row_authority_version_positive" CHECK ("activity_sync_row_authorities"."last_version" > 0),
	CONSTRAINT "activity_sync_row_authority_shape" CHECK (("activity_sync_row_authorities"."active" AND "activity_sync_row_authorities"."payload_digest" IS NOT NULL)
      OR (NOT "activity_sync_row_authorities"."active" AND "activity_sync_row_authorities"."payload_digest" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "activity_sync_rows" (
	"server_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"filter" text NOT NULL,
	"window_id" text DEFAULT 'main' NOT NULL,
	"row_id" uuid NOT NULL,
	"row_version" bigint NOT NULL,
	"active" boolean NOT NULL,
	"payload" jsonb,
	"payload_digest" text,
	"tombstone_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_sync_rows_server_id_principal_id_filter_window_id_row_id_pk" PRIMARY KEY("server_id","principal_id","filter","window_id","row_id"),
	CONSTRAINT "activity_sync_rows_shape" CHECK (("activity_sync_rows"."active" AND "activity_sync_rows"."payload" IS NOT NULL AND "activity_sync_rows"."payload_digest" IS NOT NULL AND "activity_sync_rows"."tombstone_reason" IS NULL)
      OR (NOT "activity_sync_rows"."active" AND "activity_sync_rows"."payload" IS NULL AND "activity_sync_rows"."payload_digest" IS NULL AND "activity_sync_rows"."tombstone_reason" IS NOT NULL)),
	CONSTRAINT "activity_sync_rows_version_positive" CHECK ("activity_sync_rows"."row_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "activity_sync_scopes" (
	"server_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"filter" text NOT NULL,
	"window_id" text DEFAULT 'main' NOT NULL,
	"epoch" bigint DEFAULT 1 NOT NULL,
	"watermark" bigint DEFAULT 0 NOT NULL,
	"window_size" integer DEFAULT 30 NOT NULL,
	"scope_digest" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_sync_scopes_server_id_principal_id_filter_window_id_pk" PRIMARY KEY("server_id","principal_id","filter","window_id"),
	CONSTRAINT "activity_sync_scopes_main_window" CHECK ("activity_sync_scopes"."window_id" = 'main'),
	CONSTRAINT "activity_sync_scopes_epoch_positive" CHECK ("activity_sync_scopes"."epoch" > 0),
	CONSTRAINT "activity_sync_scopes_watermark_nonnegative" CHECK ("activity_sync_scopes"."watermark" >= 0),
	CONSTRAINT "activity_sync_scopes_window_size_bounded" CHECK ("activity_sync_scopes"."window_size" BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "activity_sync_changes" ADD CONSTRAINT "activity_sync_changes_scope_fk" FOREIGN KEY ("server_id","principal_id","filter","window_id") REFERENCES "public"."activity_sync_scopes"("server_id","principal_id","filter","window_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_sync_principal_authorities" ADD CONSTRAINT "activity_sync_principal_authorities_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_sync_principal_authorities" ADD CONSTRAINT "activity_sync_principal_authorities_principal_id_users_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_sync_row_authorities" ADD CONSTRAINT "activity_sync_row_authorities_principal_fk" FOREIGN KEY ("server_id","principal_id") REFERENCES "public"."activity_sync_principal_authorities"("server_id","principal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_sync_rows" ADD CONSTRAINT "activity_sync_rows_scope_fk" FOREIGN KEY ("server_id","principal_id","filter","window_id") REFERENCES "public"."activity_sync_scopes"("server_id","principal_id","filter","window_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_sync_scopes" ADD CONSTRAINT "activity_sync_scopes_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_sync_scopes" ADD CONSTRAINT "activity_sync_scopes_principal_id_users_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_activity_sync_changes_scope_row" ON "activity_sync_changes" USING btree ("server_id","principal_id","filter","window_id","row_id");--> statement-breakpoint
CREATE INDEX "idx_activity_sync_rows_scope_active" ON "activity_sync_rows" USING btree ("server_id","principal_id","filter","window_id","active");--> statement-breakpoint
CREATE INDEX "idx_activity_sync_scopes_principal" ON "activity_sync_scopes" USING btree ("server_id","principal_id");