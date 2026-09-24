CREATE TABLE "thread_follows" (
	"user_id" uuid NOT NULL,
	"thread_channel_id" uuid NOT NULL,
	"parent_message_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_follows_user_id_thread_channel_id_pk" PRIMARY KEY("user_id","thread_channel_id")
);
--> statement-breakpoint
ALTER TABLE "thread_follows" ADD CONSTRAINT "thread_follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_follows" ADD CONSTRAINT "thread_follows_thread_channel_id_channels_id_fk" FOREIGN KEY ("thread_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_thread_follows_user" ON "thread_follows" USING btree ("user_id");
