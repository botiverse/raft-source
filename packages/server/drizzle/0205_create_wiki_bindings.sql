CREATE TABLE "wiki_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"wiki_agent_id" uuid NOT NULL,
	"wiki_channel_id" uuid NOT NULL,
	"status" text DEFAULT 'ready_uninitialized' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_bindings" ADD CONSTRAINT "wiki_bindings_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_bindings" ADD CONSTRAINT "wiki_bindings_wiki_agent_id_agents_id_fk" FOREIGN KEY ("wiki_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_bindings" ADD CONSTRAINT "wiki_bindings_wiki_channel_id_channels_id_fk" FOREIGN KEY ("wiki_channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_bindings" ADD CONSTRAINT "wiki_bindings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_wiki_bindings_server" ON "wiki_bindings" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_wiki_bindings_agent" ON "wiki_bindings" USING btree ("wiki_agent_id");--> statement-breakpoint
CREATE INDEX "idx_wiki_bindings_channel" ON "wiki_bindings" USING btree ("wiki_channel_id");
