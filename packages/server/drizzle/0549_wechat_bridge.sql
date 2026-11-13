-- WeChat bridge for the personal assistant (design "微信接入 Ottie" v8, behind
-- the assistant_wechat_v0 flag; services/wechatBridgeService.ts):
--   wechat_bridge_bindings          one per person per server, one per WeChat
--                                   account (ilink_user_id); the bot token only
--                                   as an AES-256-GCM envelope. Cursor, lease
--                                   and outbound columns are for the poll and
--                                   mirror worker (not yet written).
--   wechat_bridge_attempts          a QR binding in progress: at most one
--                                   pending per person per server, minutes
--                                   long, single use, bound to the starting
--                                   browser (state_hash).
--   wechat_bridge_inbound_messages  the "came from WeChat" tag, written before
--                                   the message is posted (random_id), read by
--                                   getWeChatTurnRestriction.
--
-- The new tables are empty: their constraints and indexes are instant; each
-- foreign key takes a short SHARE ROW EXCLUSIVE lock on its referenced table
-- (servers, users, agents, channels), no scan of it. Nothing reads or writes
-- them while the flag is off.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "wechat_bridge_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"qrcode" text,
	"qr_base_url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"poll_in_flight_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wechat_bridge_attempts_status_valid" CHECK ("wechat_bridge_attempts"."status" IN ('pending', 'confirmed', 'expired', 'failed')),
	CONSTRAINT "wechat_bridge_attempts_pending_shape" CHECK (("wechat_bridge_attempts"."status" = 'pending') = ("wechat_bridge_attempts"."consumed_at" IS NULL AND "wechat_bridge_attempts"."qrcode" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "wechat_bridge_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"dm_channel_id" uuid NOT NULL,
	"ilink_bot_id" text NOT NULL,
	"ilink_user_id" text NOT NULL,
	"base_url" text NOT NULL,
	"encrypted_bot_token" text NOT NULL,
	"envelope_key_id" text NOT NULL,
	"aad_version" integer NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"get_updates_buf" text,
	"lease_owner" text,
	"lease_generation" bigint DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"outbound_seq" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wechat_bridge_bindings_state_valid" CHECK ("wechat_bridge_bindings"."state" IN ('active', 'reconnect_required'))
);
--> statement-breakpoint
CREATE TABLE "wechat_bridge_inbound_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"binding_id" uuid,
	"owner_user_id" uuid NOT NULL,
	"dm_channel_id" uuid NOT NULL,
	"wechat_message_key" text NOT NULL,
	"random_id" text NOT NULL,
	"message_id" uuid,
	"context_token" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wechat_bridge_attempts" ADD CONSTRAINT "wechat_bridge_attempts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_bridge_attempts" ADD CONSTRAINT "wechat_bridge_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_bridge_bindings" ADD CONSTRAINT "wechat_bridge_bindings_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_bridge_bindings" ADD CONSTRAINT "wechat_bridge_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_bridge_bindings" ADD CONSTRAINT "wechat_bridge_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_bridge_bindings" ADD CONSTRAINT "wechat_bridge_bindings_dm_channel_id_channels_id_fk" FOREIGN KEY ("dm_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_bridge_inbound_messages" ADD CONSTRAINT "wechat_bridge_inbound_messages_binding_id_wechat_bridge_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."wechat_bridge_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_bridge_inbound_messages" ADD CONSTRAINT "wechat_bridge_inbound_messages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_bridge_inbound_messages" ADD CONSTRAINT "wechat_bridge_inbound_messages_dm_channel_id_channels_id_fk" FOREIGN KEY ("dm_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_wechat_bridge_attempts_pending" ON "wechat_bridge_attempts" USING btree ("server_id","user_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_wechat_bridge_attempts_user" ON "wechat_bridge_attempts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_wechat_bridge_bindings_server_user" ON "wechat_bridge_bindings" USING btree ("server_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_wechat_bridge_bindings_ilink_user" ON "wechat_bridge_bindings" USING btree ("ilink_user_id");--> statement-breakpoint
CREATE INDEX "idx_wechat_bridge_bindings_user" ON "wechat_bridge_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_wechat_bridge_bindings_agent" ON "wechat_bridge_bindings" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_wechat_bridge_bindings_dm_channel" ON "wechat_bridge_bindings" USING btree ("dm_channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_wechat_bridge_inbound_random_id" ON "wechat_bridge_inbound_messages" USING btree ("random_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_wechat_bridge_inbound_message_id" ON "wechat_bridge_inbound_messages" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_wechat_bridge_inbound_binding_key" ON "wechat_bridge_inbound_messages" USING btree ("binding_id","wechat_message_key");--> statement-breakpoint
CREATE INDEX "idx_wechat_bridge_inbound_owner" ON "wechat_bridge_inbound_messages" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_wechat_bridge_inbound_dm_channel" ON "wechat_bridge_inbound_messages" USING btree ("dm_channel_id");
