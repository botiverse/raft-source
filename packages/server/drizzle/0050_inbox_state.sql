CREATE TABLE "user_channel_inbox_states" (
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"done_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_channel_inbox_states_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "user_channel_inbox_states" ADD CONSTRAINT "user_channel_inbox_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channel_inbox_states" ADD CONSTRAINT "user_channel_inbox_states_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_channel_inbox_states_channel" ON "user_channel_inbox_states" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_user_channel_inbox_states_done" ON "user_channel_inbox_states" USING btree ("user_id","done_at");
