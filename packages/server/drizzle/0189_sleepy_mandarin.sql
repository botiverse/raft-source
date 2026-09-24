CREATE TABLE "read_mutation_authorities" (
	"server_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"next_authority_seq" bigint DEFAULT 1 NOT NULL,
	"last_terminal_authority_seq" bigint DEFAULT 0 NOT NULL,
	"worker_last_scheduled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "read_mutation_authorities_server_id_principal_id_pk" PRIMARY KEY("server_id","principal_id"),
	CONSTRAINT "read_mutation_authorities_next_positive" CHECK ("read_mutation_authorities"."next_authority_seq" > 0),
	CONSTRAINT "read_mutation_authorities_terminal_nonnegative" CHECK ("read_mutation_authorities"."last_terminal_authority_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "read_mutation_tombstones" (
	"server_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"original_authority_seq" bigint NOT NULL,
	"terminal_state" text NOT NULL,
	"terminal_reason" text NOT NULL,
	"terminal_digest" text NOT NULL,
	"compacted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "read_mutation_tombstones_server_id_principal_id_mutation_id_pk" PRIMARY KEY("server_id","principal_id","mutation_id"),
	CONSTRAINT "read_mutation_tombstones_authority_seq_positive" CHECK ("read_mutation_tombstones"."original_authority_seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "read_mutations" (
	"server_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"authority_seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"scope_id" uuid,
	"requested_through_seq" integer,
	"state" text DEFAULT 'admitted' NOT NULL,
	"lease_owner" text,
	"lease_generation" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"captured_boundary" jsonb,
	"ack" jsonb,
	"terminal_reason" text,
	"terminal_digest" text,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executing_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "read_mutations_server_id_principal_id_mutation_id_pk" PRIMARY KEY("server_id","principal_id","mutation_id"),
	CONSTRAINT "read_mutations_authority_seq_positive" CHECK ("read_mutations"."authority_seq" > 0),
	CONSTRAINT "read_mutations_lease_generation_nonnegative" CHECK ("read_mutations"."lease_generation" >= 0),
	CONSTRAINT "read_mutations_attempt_count_nonnegative" CHECK ("read_mutations"."attempt_count" >= 0),
	CONSTRAINT "read_mutations_scope_shape" CHECK (
    ("read_mutations"."kind" = 'global_read_all' AND "read_mutations"."scope_id" IS NULL AND "read_mutations"."requested_through_seq" IS NULL)
    OR ("read_mutations"."kind" = 'channel_read_all' AND "read_mutations"."scope_id" IS NOT NULL AND "read_mutations"."requested_through_seq" IS NULL)
    OR ("read_mutations"."kind" IN ('row_read', 'row_unread') AND "read_mutations"."scope_id" IS NOT NULL AND "read_mutations"."requested_through_seq" IS NOT NULL AND "read_mutations"."requested_through_seq" >= 0)
  )
);
--> statement-breakpoint
ALTER TABLE "user_channel_read_cursors" ADD COLUMN "last_applied_authority_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "read_mutation_authorities" ADD CONSTRAINT "read_mutation_authorities_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_mutation_authorities" ADD CONSTRAINT "read_mutation_authorities_principal_id_users_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_mutation_tombstones" ADD CONSTRAINT "read_mutation_tombstones_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_mutation_tombstones" ADD CONSTRAINT "read_mutation_tombstones_principal_id_users_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_mutations" ADD CONSTRAINT "read_mutations_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_mutations" ADD CONSTRAINT "read_mutations_principal_id_users_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "read_mutation_authorities_worker_schedule_idx" ON "read_mutation_authorities" USING btree ("worker_last_scheduled_at","server_id","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "read_mutation_tombstones_authority_seq_unique" ON "read_mutation_tombstones" USING btree ("server_id","principal_id","original_authority_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "read_mutations_authority_seq_unique" ON "read_mutations" USING btree ("server_id","principal_id","authority_seq");--> statement-breakpoint
CREATE INDEX "read_mutations_worker_order_idx" ON "read_mutations" USING btree ("server_id","principal_id","authority_seq");--> statement-breakpoint
CREATE INDEX "read_mutations_terminal_retention_idx" ON "read_mutations" USING btree ("state","terminal_at");