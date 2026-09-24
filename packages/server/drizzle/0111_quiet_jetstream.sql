CREATE TABLE "attachment_comment_refs" (
	"comment_message_id" uuid PRIMARY KEY NOT NULL,
	"attachment_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachment_comment_refs" ADD CONSTRAINT "attachment_comment_refs_comment_message_id_messages_id_fk" FOREIGN KEY ("comment_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_comment_refs" ADD CONSTRAINT "attachment_comment_refs_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_attachment_comment_refs_attachment" ON "attachment_comment_refs" USING btree ("attachment_id");