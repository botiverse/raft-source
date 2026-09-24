CREATE TABLE "user_retirement_receipts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"terminal_state" text NOT NULL,
	"sessions_revoked" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "retired_reason" text;--> statement-breakpoint
ALTER TABLE "user_retirement_receipts" ADD CONSTRAINT "user_retirement_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_retirement_receipts" ADD CONSTRAINT "user_retirement_receipts_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;