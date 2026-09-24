CREATE TABLE "mobile_push_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"receiver_type" text NOT NULL,
	"receiver_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_channel_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"message_seq" bigint NOT NULL,
	"activity_at" timestamp with time zone NOT NULL,
	"personal_mention" boolean DEFAULT false NOT NULL,
	"unread_eligible" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"attempted_count" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"revoked_count" integer DEFAULT 0 NOT NULL,
	"dropped_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"locked_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mobile_push_outbox_receiver_type_check" CHECK ("mobile_push_outbox"."receiver_type" IN ('user')),
	CONSTRAINT "mobile_push_outbox_kind_check" CHECK ("mobile_push_outbox"."kind" IN ('channel', 'dm', 'thread')),
	CONSTRAINT "mobile_push_outbox_status_check" CHECK ("mobile_push_outbox"."status" IN ('pending', 'processing', 'sent', 'skipped', 'revoked', 'dropped'))
);
--> statement-breakpoint
ALTER TABLE "mobile_push_outbox" ADD CONSTRAINT "mobile_push_outbox_receiver_id_users_id_fk" FOREIGN KEY ("receiver_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_push_outbox" ADD CONSTRAINT "mobile_push_outbox_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_push_outbox" ADD CONSTRAINT "mobile_push_outbox_source_channel_id_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_push_outbox" ADD CONSTRAINT "mobile_push_outbox_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_mobile_push_outbox_unique_fact" ON "mobile_push_outbox" USING btree ("receiver_type","receiver_id","source_channel_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_mobile_push_outbox_pending" ON "mobile_push_outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_mobile_push_outbox_message" ON "mobile_push_outbox" USING btree ("message_id");