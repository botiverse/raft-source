CREATE TABLE "slack_usergroup_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"install_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"recovery_ref" text NOT NULL,
	"provider_usergroup_id" text,
	CONSTRAINT "slack_usergroup_kind_valid" CHECK ("slack_usergroup_identities"."principal_kind" IN ('agent', 'user'))
);
--> statement-breakpoint
ALTER TABLE "slack_usergroup_identities" ADD CONSTRAINT "slack_usergroup_identities_install_id_external_app_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."external_app_installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_usergroup_identities" ADD CONSTRAINT "slack_usergroup_identities_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_usergroup_principal" ON "slack_usergroup_identities" USING btree ("install_id","server_id","principal_kind","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_usergroup_provider" ON "slack_usergroup_identities" USING btree ("install_id","provider_usergroup_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_usergroup_recovery" ON "slack_usergroup_identities" USING btree ("recovery_ref");