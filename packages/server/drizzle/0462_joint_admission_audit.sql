-- Audit references follow durable entities, not current membership/connection.
-- Contended deploys fail without waiting behind a long membership transaction.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "joint_channel_admissions" DROP CONSTRAINT "joint_channel_admissions_joint_channel_id_user_id_joint_channel_members_joint_channel_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "joint_channel_admissions" DROP CONSTRAINT "joint_channel_admissions_joint_channel_id_server_id_joint_channel_servers_joint_channel_id_server_id_fk";
--> statement-breakpoint
ALTER TABLE "joint_channel_admissions" ADD CONSTRAINT "joint_channel_admissions_joint_channel_id_joint_channels_id_fk" FOREIGN KEY ("joint_channel_id") REFERENCES "public"."joint_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_admissions" ADD CONSTRAINT "joint_channel_admissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_admissions" ADD CONSTRAINT "joint_channel_admissions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_joint_channel_admissions_user" ON "joint_channel_admissions" USING btree ("user_id","joint_channel_id");