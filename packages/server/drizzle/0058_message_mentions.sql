CREATE TABLE "message_mentions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"message_seq" bigint NOT NULL,
	"server_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"handle_at_send_time" text NOT NULL,
	"source" text DEFAULT 'send_path' NOT NULL,
	"confidence" text DEFAULT 'exact' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_message_mentions_unique" ON "message_mentions" USING btree ("message_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "idx_message_mentions_target" ON "message_mentions" USING btree ("target_type","target_id","server_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_message_mentions_channel" ON "message_mentions" USING btree ("channel_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_message_mentions_inbox" ON "message_mentions" USING btree ("target_type","target_id","channel_id","message_seq");
