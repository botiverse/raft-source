CREATE TABLE "inbox_target_mute_states" (
	"receiver_type" text NOT NULL,
	"receiver_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"source_channel_id" uuid NOT NULL,
	"mute_from_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_target_mute_states_receiver_type_receiver_id_source_channel_id_pk" PRIMARY KEY("receiver_type","receiver_id","source_channel_id")
);
--> statement-breakpoint
ALTER TABLE "inbox_target_mute_states" ADD CONSTRAINT "inbox_target_mute_states_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_target_mute_states" ADD CONSTRAINT "inbox_target_mute_states_source_channel_id_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_inbox_target_mute_states_receiver" ON "inbox_target_mute_states" USING btree ("server_id","receiver_type","receiver_id");--> statement-breakpoint
CREATE INDEX "idx_inbox_target_mute_states_source" ON "inbox_target_mute_states" USING btree ("source_channel_id");--> statement-breakpoint
INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt"
) VALUES (
	'human_activity_mute_v0',
	'Temporary #3398 two-stage release gate for human Activity mute and Inbox serving selector',
	true,
	false,
	'server',
	false,
	NULL,
	'human_activity_mute_v0'
) ON CONFLICT ("key") DO NOTHING;
