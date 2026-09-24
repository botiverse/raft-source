CREATE TABLE "mention_delivery_occurrences" (
	"occurrence_id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"delivery_payload" jsonb,
	"state" text DEFAULT 'recorded' NOT NULL,
	"delivery_path" text DEFAULT 'unknown' NOT NULL,
	"machine_id_snapshot" uuid,
	"launch_id_snapshot" text,
	"session_id_snapshot" text,
	"mention_recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"server_decided_at" timestamp with time zone,
	"daemon_received_at" timestamp with time zone,
	"daemon_pending_at" timestamp with time zone,
	"daemon_drained_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	"terminal_error_at" timestamp with time zone,
	"terminal_error_code" text,
	"pending_coalesced_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"redrive_count" integer DEFAULT 0 NOT NULL,
	"last_redrive_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mention_delivery_occurrences_terminal_error_shape" CHECK (("mention_delivery_occurrences"."state" = 'terminal_error') = ("mention_delivery_occurrences"."terminal_error_at" IS NOT NULL AND "mention_delivery_occurrences"."terminal_error_code" IS NOT NULL) AND (("mention_delivery_occurrences"."terminal_error_at" IS NULL) = ("mention_delivery_occurrences"."terminal_error_code" IS NULL))),
	CONSTRAINT "mention_delivery_occurrences_ack_shape" CHECK (("mention_delivery_occurrences"."state" = 'acked') = ("mention_delivery_occurrences"."acked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "mention_delivery_occurrences" ADD CONSTRAINT "mention_delivery_occurrences_occurrence_id_message_mentions_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."message_mentions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mention_delivery_occurrences" ADD CONSTRAINT "mention_delivery_occurrences_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mention_delivery_occurrences" ADD CONSTRAINT "mention_delivery_occurrences_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mention_delivery_occurrences" ADD CONSTRAINT "mention_delivery_occurrences_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_mention_delivery_occurrences_message_agent" ON "mention_delivery_occurrences" USING btree ("message_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_mention_delivery_occurrences_machine_state" ON "mention_delivery_occurrences" USING btree ("machine_id_snapshot","state");