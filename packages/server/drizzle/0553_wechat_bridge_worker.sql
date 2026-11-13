-- WeChat bridge poll and mirror worker (services/wechatBridgeWorker.ts; design
-- "微信接入 Ottie" v8-v11, behind the assistant_wechat_v0 flag):
--   wechat_bridge_outbound_messages  what the outbound mirror did with each of
--                                    the assistant's top-level DM messages,
--                                    recorded before anything is sent (never a
--                                    second send); goes with its binding.
--   wechat_bridge_bindings           outbound_seq is set at bind time (the
--                                    connected notice's seq) and now NOT NULL;
--                                    the outbound read horizon (late commits),
--                                    the first-inbound greeting, the count of
--                                    replies left in Raft, and the no-reply
--                                    notice's batch boundary.
--   wechat_bridge_inbound_messages   sent_at (iLink's send time, for the
--                                    24-hour reply window only), and indexes
--                                    for the worker's per-binding reads and the
--                                    context token sweep.
--
-- The tables are tiny (the bridge is behind a flag no one has yet): a binding
-- made before this migration (outbound_seq NULL) starts its outbound cursor at
-- its DM's newest message, then the column is NOT NULL (a scan of the tiny
-- table under its lock); the new columns are nullable or a constant default
-- (metadata only), the indexes build at once, and the foreign key takes a
-- short lock on wechat_bridge_bindings only.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "wechat_bridge_outbound_messages" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"binding_id" uuid NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wechat_bridge_outbound_messages_state_valid" CHECK ("wechat_bridge_outbound_messages"."state" IN ('sending', 'sent', 'failed', 'not_mirrored'))
);
--> statement-breakpoint
UPDATE "wechat_bridge_bindings" b
SET "outbound_seq" = COALESCE((SELECT max(m."seq") FROM "messages" m WHERE m."channel_id" = b."dm_channel_id"), 0)
WHERE b."outbound_seq" IS NULL;--> statement-breakpoint
-- The default exists only for the image still serving during a deploy (or after a rollback), whose binding insert names no outbound_seq; this code always sets it.
ALTER TABLE "wechat_bridge_bindings" ALTER COLUMN "outbound_seq" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "wechat_bridge_bindings" ALTER COLUMN "outbound_seq" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wechat_bridge_bindings" ADD COLUMN "outbound_horizon" text;--> statement-breakpoint
ALTER TABLE "wechat_bridge_bindings" ADD COLUMN "greeted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wechat_bridge_bindings" ADD COLUMN "unmirrored_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wechat_bridge_bindings" ADD COLUMN "last_mirrored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wechat_bridge_bindings" ADD COLUMN "no_reply_notice_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wechat_bridge_inbound_messages" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wechat_bridge_outbound_messages" ADD CONSTRAINT "wechat_bridge_outbound_messages_binding_id_wechat_bridge_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."wechat_bridge_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_wechat_bridge_outbound_binding" ON "wechat_bridge_outbound_messages" USING btree ("binding_id");--> statement-breakpoint
CREATE INDEX "idx_wechat_bridge_outbound_created" ON "wechat_bridge_outbound_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_wechat_bridge_inbound_binding_received" ON "wechat_bridge_inbound_messages" USING btree ("binding_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_wechat_bridge_inbound_live_token" ON "wechat_bridge_inbound_messages" USING btree ("received_at") WHERE context_token IS NOT NULL;
