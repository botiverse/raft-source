CREATE TABLE "computer_outage_occurrences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"connection_epoch_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"offline_event_id" uuid NOT NULL,
	"online_event_id" uuid NOT NULL,
	"first_offline_at" timestamp with time zone NOT NULL,
	"notify_after" timestamp with time zone NOT NULL,
	"offline_notified_at" timestamp with time zone,
	"recovered_at" timestamp with time zone,
	"suppressed_at" timestamp with time zone,
	"suppress_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computer_outage_occurrences_state_check" CHECK ("computer_outage_occurrences"."state" IN ('pending', 'notified', 'recovered', 'suppressed'))
);
--> statement-breakpoint
ALTER TABLE "computer_outage_occurrences" ADD CONSTRAINT "computer_outage_occurrences_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_outage_occurrences" ADD CONSTRAINT "computer_outage_occurrences_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_outage_occurrences" ADD CONSTRAINT "computer_outage_occurrences_machine_id_daemons_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."daemons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_computer_outage_occurrences_epoch" ON "computer_outage_occurrences" USING btree ("server_id","machine_id","connection_epoch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_computer_outage_occurrences_open_machine" ON "computer_outage_occurrences" USING btree ("server_id","machine_id") WHERE "computer_outage_occurrences"."state" IN ('pending', 'notified');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_computer_outage_occurrences_offline_event" ON "computer_outage_occurrences" USING btree ("offline_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_computer_outage_occurrences_online_event" ON "computer_outage_occurrences" USING btree ("online_event_id");--> statement-breakpoint
CREATE INDEX "idx_computer_outage_occurrences_due" ON "computer_outage_occurrences" USING btree ("state","notify_after");--> statement-breakpoint
CREATE INDEX "idx_computer_outage_occurrences_computer" ON "computer_outage_occurrences" USING btree ("computer_id","created_at");