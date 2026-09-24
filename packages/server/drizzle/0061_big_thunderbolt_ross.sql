CREATE TABLE "message_reactions" (
	"message_id" uuid NOT NULL,
	"reactor_type" text NOT NULL,
	"reactor_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reactions_message_id_reactor_type_reactor_id_emoji_pk" PRIMARY KEY("message_id","reactor_type","reactor_id","emoji")
);
--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_reactions_message" ON "message_reactions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_message_reactions_reactor" ON "message_reactions" USING btree ("reactor_type","reactor_id");