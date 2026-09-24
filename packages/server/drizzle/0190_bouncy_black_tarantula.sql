CREATE TABLE "lab_definitions" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_definitions_key_valid" CHECK ("lab_definitions"."key" ~ '^[a-z0-9][a-z0-9_.-]{0,127}$'),
	CONSTRAINT "lab_definitions_name_nonempty" CHECK (length(btrim("lab_definitions"."name")) > 0),
	CONSTRAINT "lab_definitions_description_nonempty" CHECK (length(btrim("lab_definitions"."description")) > 0),
	CONSTRAINT "lab_definitions_state_valid" CHECK ("lab_definitions"."state" IN ('draft', 'open', 'paused', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "server_lab_access" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_by_actor_type" text,
	"updated_by_actor_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_lab_access_version_nonnegative" CHECK ("server_lab_access"."version" >= 0),
	CONSTRAINT "server_lab_access_actor_complete" CHECK (("server_lab_access"."updated_by_actor_type" IS NULL) = ("server_lab_access"."updated_by_actor_id" IS NULL)),
	CONSTRAINT "server_lab_access_actor_type_valid" CHECK ("server_lab_access"."updated_by_actor_type" IS NULL OR "server_lab_access"."updated_by_actor_type" IN ('human', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "server_lab_audit_events" (
	"server_id" uuid NOT NULL,
	"version_after" bigint NOT NULL,
	"id" uuid NOT NULL,
	"operation" text NOT NULL,
	"lab_key" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" text NOT NULL,
	"version_before" bigint NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_lab_audit_events_server_id_version_after_pk" PRIMARY KEY("server_id","version_after"),
	CONSTRAINT "server_lab_audit_events_actor_type_valid" CHECK ("server_lab_audit_events"."actor_type" IN ('human', 'agent')),
	CONSTRAINT "server_lab_audit_events_operation_valid" CHECK ("server_lab_audit_events"."operation" IN ('master_access_set', 'enrollment_set')),
	CONSTRAINT "server_lab_audit_events_lab_key_matches_operation" CHECK (("server_lab_audit_events"."operation" = 'master_access_set' AND "server_lab_audit_events"."lab_key" IS NULL) OR ("server_lab_audit_events"."operation" = 'enrollment_set' AND "server_lab_audit_events"."lab_key" IS NOT NULL)),
	CONSTRAINT "server_lab_audit_events_version_step" CHECK ("server_lab_audit_events"."version_before" >= 0 AND "server_lab_audit_events"."version_after" = "server_lab_audit_events"."version_before" + 1)
);
--> statement-breakpoint
CREATE TABLE "server_lab_enrollments" (
	"server_id" uuid NOT NULL,
	"lab_key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_by_actor_type" text,
	"updated_by_actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_lab_enrollments_server_id_lab_key_pk" PRIMARY KEY("server_id","lab_key"),
	CONSTRAINT "server_lab_enrollments_version_nonnegative" CHECK ("server_lab_enrollments"."version" >= 0),
	CONSTRAINT "server_lab_enrollments_actor_complete" CHECK (("server_lab_enrollments"."updated_by_actor_type" IS NULL) = ("server_lab_enrollments"."updated_by_actor_id" IS NULL)),
	CONSTRAINT "server_lab_enrollments_actor_type_valid" CHECK ("server_lab_enrollments"."updated_by_actor_type" IS NULL OR "server_lab_enrollments"."updated_by_actor_type" IN ('human', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "feature_flag_rules" DROP CONSTRAINT "feature_flag_rules_stage_valid";--> statement-breakpoint
ALTER TABLE "server_lab_access" ADD CONSTRAINT "server_lab_access_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_lab_audit_events" ADD CONSTRAINT "server_lab_audit_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_lab_audit_events" ADD CONSTRAINT "server_lab_audit_events_lab_key_lab_definitions_key_fk" FOREIGN KEY ("lab_key") REFERENCES "public"."lab_definitions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_lab_enrollments" ADD CONSTRAINT "server_lab_enrollments_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_lab_enrollments" ADD CONSTRAINT "server_lab_enrollments_lab_key_lab_definitions_key_fk" FOREIGN KEY ("lab_key") REFERENCES "public"."lab_definitions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_server_lab_audit_events_id" ON "server_lab_audit_events" USING btree ("id");--> statement-breakpoint
CREATE INDEX "idx_server_lab_audit_events_request" ON "server_lab_audit_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_server_lab_enrollments_lab" ON "server_lab_enrollments" USING btree ("lab_key","server_id");--> statement-breakpoint
ALTER TABLE "feature_flag_rules" ADD CONSTRAINT "feature_flag_rules_lab_shape_valid" CHECK ("feature_flag_rules"."stage" <> 'lab' OR ("feature_flag_rules"."percentage_basis_points" IS NULL AND "feature_flag_rules"."variant" IS NULL AND jsonb_array_length("feature_flag_rules"."values") > 0));--> statement-breakpoint
ALTER TABLE "feature_flag_rules" ADD CONSTRAINT "feature_flag_rules_stage_valid" CHECK ("feature_flag_rules"."stage" IN ('user', 'platform', 'server', 'lab', 'plan', 'percentage'));