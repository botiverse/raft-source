CREATE TABLE "inbox_notification_facts" (
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_serving_rows" (
	"receiver_type" text NOT NULL,
	"receiver_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_channel_id" uuid NOT NULL,
	"latest_notified_message_id" uuid NOT NULL,
	"latest_notified_seq" bigint NOT NULL,
	"latest_notified_at" timestamp with time zone NOT NULL,
	"first_unread_message_id" uuid,
	"first_unread_seq" bigint,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"latest_personal_mention_message_id" uuid,
	"latest_personal_mention_seq" bigint,
	"unread_mention_count" integer DEFAULT 0 NOT NULL,
	"has_any_mention" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_serving_rows_receiver_type_receiver_id_source_channel_id_pk" PRIMARY KEY("receiver_type","receiver_id","source_channel_id")
);
--> statement-breakpoint
ALTER TABLE "inbox_notification_facts" ADD CONSTRAINT "inbox_notification_facts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_notification_facts" ADD CONSTRAINT "inbox_notification_facts_source_channel_id_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_notification_facts" ADD CONSTRAINT "inbox_notification_facts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_serving_rows" ADD CONSTRAINT "inbox_serving_rows_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_serving_rows" ADD CONSTRAINT "inbox_serving_rows_source_channel_id_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_serving_rows" ADD CONSTRAINT "inbox_serving_rows_latest_notified_message_id_messages_id_fk" FOREIGN KEY ("latest_notified_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_serving_rows" ADD CONSTRAINT "inbox_serving_rows_first_unread_message_id_messages_id_fk" FOREIGN KEY ("first_unread_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_serving_rows" ADD CONSTRAINT "inbox_serving_rows_latest_personal_mention_message_id_messages_id_fk" FOREIGN KEY ("latest_personal_mention_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_inbox_notification_facts_unique" ON "inbox_notification_facts" USING btree ("receiver_type","receiver_id","source_channel_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_inbox_notification_facts_receiver_target" ON "inbox_notification_facts" USING btree ("receiver_type","receiver_id","source_channel_id","message_seq");--> statement-breakpoint
CREATE INDEX "idx_inbox_notification_facts_message" ON "inbox_notification_facts" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_inbox_serving_rows_receiver_activity" ON "inbox_serving_rows" USING btree ("receiver_type","receiver_id","latest_notified_at");--> statement-breakpoint
CREATE INDEX "idx_inbox_serving_rows_server" ON "inbox_serving_rows" USING btree ("server_id");