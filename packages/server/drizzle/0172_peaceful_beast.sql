CREATE TABLE "message_reaction_discussion_versions" (
	"message_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reaction_discussion_versions_message_id_emoji_pk" PRIMARY KEY("message_id","emoji"),
	CONSTRAINT "message_reaction_discussion_versions_nonnegative" CHECK ("message_reaction_discussion_versions"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "message_reaction_viewer_versions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reaction_viewer_versions_message_id_user_id_pk" PRIMARY KEY("message_id","user_id"),
	CONSTRAINT "message_reaction_viewer_versions_nonnegative" CHECK ("message_reaction_viewer_versions"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "message_reaction_discussion_versions" ADD CONSTRAINT "message_reaction_discussion_versions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reaction_viewer_versions" ADD CONSTRAINT "message_reaction_viewer_versions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reaction_viewer_versions" ADD CONSTRAINT "message_reaction_viewer_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_reaction_viewer_versions_user" ON "message_reaction_viewer_versions" USING btree ("user_id");