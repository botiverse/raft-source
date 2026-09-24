CREATE TABLE "session_families" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"revoke_capability_nonce" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"capability_retain_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_registrations" ADD COLUMN "session_family_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "family_id" uuid;--> statement-breakpoint
INSERT INTO "session_families" ("id", "user_id", "created_at")
SELECT "id", "user_id", "created_at" FROM "sessions";--> statement-breakpoint
UPDATE "sessions" SET "family_id" = "id";--> statement-breakpoint
ALTER TABLE "session_families" ADD CONSTRAINT "session_families_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_session_families_user_active" ON "session_families" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "idx_session_families_capability_retention" ON "session_families" USING btree ("capability_retain_until");--> statement-breakpoint
ALTER TABLE "push_registrations" ADD CONSTRAINT "push_registrations_session_family_id_session_families_id_fk" FOREIGN KEY ("session_family_id") REFERENCES "public"."session_families"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_family_id_session_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."session_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_push_registrations_family" ON "push_registrations" USING btree ("session_family_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_family_active" ON "sessions" USING btree ("family_id","expires_at");
