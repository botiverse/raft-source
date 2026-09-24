CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"task_number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"claimed_by_type" text,
	"claimed_by_id" text,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tasks_channel_number" ON "tasks" USING btree ("channel_id","task_number");--> statement-breakpoint
CREATE INDEX "idx_tasks_channel_status" ON "tasks" USING btree ("channel_id","status");