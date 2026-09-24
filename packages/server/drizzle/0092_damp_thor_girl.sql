CREATE TABLE "joint_channel_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"joint_channel_id" uuid NOT NULL,
	"from_server_id" uuid NOT NULL,
	"to_server_id" uuid NOT NULL,
	"invited_user_id" uuid NOT NULL,
	"invited_by_user_id" uuid,
	"accepted_by_user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"token_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "joint_channel_servers" (
	"joint_channel_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"local_channel_id" uuid NOT NULL,
	"role" text DEFAULT 'participant' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"joined_by_user_id" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_by_user_id" uuid,
	"disconnected_at" timestamp with time zone,
	CONSTRAINT "joint_channel_servers_joint_channel_id_server_id_pk" PRIMARY KEY("joint_channel_id","server_id")
);
--> statement-breakpoint
CREATE TABLE "joint_channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"canonical_channel_id" uuid NOT NULL,
	"created_by_server_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "idx_channels_server_name_type";--> statement-breakpoint
ALTER TABLE "joint_channel_invites" ADD CONSTRAINT "joint_channel_invites_joint_channel_id_joint_channels_id_fk" FOREIGN KEY ("joint_channel_id") REFERENCES "public"."joint_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_invites" ADD CONSTRAINT "joint_channel_invites_from_server_id_servers_id_fk" FOREIGN KEY ("from_server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_invites" ADD CONSTRAINT "joint_channel_invites_to_server_id_servers_id_fk" FOREIGN KEY ("to_server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_invites" ADD CONSTRAINT "joint_channel_invites_invited_user_id_users_id_fk" FOREIGN KEY ("invited_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_invites" ADD CONSTRAINT "joint_channel_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_invites" ADD CONSTRAINT "joint_channel_invites_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_servers" ADD CONSTRAINT "joint_channel_servers_joint_channel_id_joint_channels_id_fk" FOREIGN KEY ("joint_channel_id") REFERENCES "public"."joint_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_servers" ADD CONSTRAINT "joint_channel_servers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_servers" ADD CONSTRAINT "joint_channel_servers_local_channel_id_channels_id_fk" FOREIGN KEY ("local_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_servers" ADD CONSTRAINT "joint_channel_servers_joined_by_user_id_users_id_fk" FOREIGN KEY ("joined_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_servers" ADD CONSTRAINT "joint_channel_servers_disconnected_by_user_id_users_id_fk" FOREIGN KEY ("disconnected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channels" ADD CONSTRAINT "joint_channels_canonical_channel_id_channels_id_fk" FOREIGN KEY ("canonical_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channels" ADD CONSTRAINT "joint_channels_created_by_server_id_servers_id_fk" FOREIGN KEY ("created_by_server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channels" ADD CONSTRAINT "joint_channels_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_joint_channel_invites_token_hash" ON "joint_channel_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_joint_channel_invites_pending_target_user" ON "joint_channel_invites" USING btree ("joint_channel_id","to_server_id","invited_user_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_joint_channel_invites_to_server" ON "joint_channel_invites" USING btree ("to_server_id","status");--> statement-breakpoint
CREATE INDEX "idx_joint_channel_invites_invited_user" ON "joint_channel_invites" USING btree ("invited_user_id","status");--> statement-breakpoint
CREATE INDEX "idx_joint_channel_invites_from_server" ON "joint_channel_invites" USING btree ("from_server_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_joint_channel_servers_local_channel" ON "joint_channel_servers" USING btree ("local_channel_id");--> statement-breakpoint
CREATE INDEX "idx_joint_channel_servers_server" ON "joint_channel_servers" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_joint_channels_canonical" ON "joint_channels" USING btree ("canonical_channel_id");--> statement-breakpoint
CREATE INDEX "idx_joint_channels_created_by_server" ON "joint_channels" USING btree ("created_by_server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_channels_server_name_type" ON "channels" USING btree ("server_id","name") WHERE type in ('channel', 'private', 'joint') and deleted_at is null;