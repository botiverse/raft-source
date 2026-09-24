CREATE TABLE "inbox_suppression_states" (
	"receiver_type" text NOT NULL,
	"receiver_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_channel_id" uuid NOT NULL,
	"source_channel_id" uuid NOT NULL,
	"done_through_seq" bigint,
	"done_at" timestamp with time zone DEFAULT now() NOT NULL,
	"write_site" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_suppression_states_receiver_type_receiver_id_target_kind_target_channel_id_pk" PRIMARY KEY("receiver_type","receiver_id","target_kind","target_channel_id")
);
--> statement-breakpoint
ALTER TABLE "inbox_suppression_states" ADD CONSTRAINT "inbox_suppression_states_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_suppression_states" ADD CONSTRAINT "inbox_suppression_states_target_channel_id_channels_id_fk" FOREIGN KEY ("target_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_suppression_states" ADD CONSTRAINT "inbox_suppression_states_source_channel_id_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_inbox_suppression_states_lookup" ON "inbox_suppression_states" USING btree ("server_id","receiver_type","receiver_id","target_kind","target_channel_id");--> statement-breakpoint
CREATE INDEX "idx_inbox_suppression_states_source" ON "inbox_suppression_states" USING btree ("source_channel_id");--> statement-breakpoint
CREATE INDEX "idx_inbox_suppression_states_updated" ON "inbox_suppression_states" USING btree ("updated_at");