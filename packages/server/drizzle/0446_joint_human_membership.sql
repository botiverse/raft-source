CREATE TABLE "joint_channel_admissions" (
	"joint_channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"admitted_by" uuid,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "joint_channel_admissions_joint_channel_id_user_id_server_id_pk" PRIMARY KEY("joint_channel_id","user_id","server_id")
);
--> statement-breakpoint
CREATE TABLE "joint_channel_members" (
	"joint_channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "joint_channel_members_joint_channel_id_user_id_pk" PRIMARY KEY("joint_channel_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "joint_channel_admissions" ADD CONSTRAINT "joint_channel_admissions_admitted_by_users_id_fk" FOREIGN KEY ("admitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_admissions" ADD CONSTRAINT "joint_channel_admissions_joint_channel_id_user_id_joint_channel_members_joint_channel_id_user_id_fk" FOREIGN KEY ("joint_channel_id","user_id") REFERENCES "public"."joint_channel_members"("joint_channel_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_admissions" ADD CONSTRAINT "joint_channel_admissions_joint_channel_id_server_id_joint_channel_servers_joint_channel_id_server_id_fk" FOREIGN KEY ("joint_channel_id","server_id") REFERENCES "public"."joint_channel_servers"("joint_channel_id","server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_members" ADD CONSTRAINT "joint_channel_members_joint_channel_id_joint_channels_id_fk" FOREIGN KEY ("joint_channel_id") REFERENCES "public"."joint_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "joint_channel_members" ADD CONSTRAINT "joint_channel_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_joint_channel_admissions_source" ON "joint_channel_admissions" USING btree ("server_id","joint_channel_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_joint_channel_members_user" ON "joint_channel_members" USING btree ("user_id","joint_channel_id");