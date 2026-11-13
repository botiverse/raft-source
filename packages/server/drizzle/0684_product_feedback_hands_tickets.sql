-- Hands ticket(s) filed for an agent issue report (product_feedback_hands_tickets).
-- Add-only: a new empty table; the FKs lock servers/users only briefly.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "product_feedback_hands_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"hands_ticket_id" text NOT NULL,
	"hands_reference" text,
	"submitted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_feedback_hands_tickets" ADD CONSTRAINT "product_feedback_hands_tickets_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_feedback_hands_tickets" ADD CONSTRAINT "product_feedback_hands_tickets_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_product_feedback_hands_tickets_report_ticket" ON "product_feedback_hands_tickets" USING btree ("report_id","hands_ticket_id");--> statement-breakpoint
CREATE INDEX "idx_product_feedback_hands_tickets_server" ON "product_feedback_hands_tickets" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_product_feedback_hands_tickets_submitter" ON "product_feedback_hands_tickets" USING btree ("submitted_by_user_id");