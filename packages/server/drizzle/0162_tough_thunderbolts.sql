CREATE TABLE "computer_lifecycle_operation_targets" (
	"operation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"machine_id_at_intent" uuid NOT NULL,
	"projection_status" text DEFAULT 'pending' NOT NULL,
	"projection_skip_reason" text,
	"projected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computer_lifecycle_operation_targets_operation_id_agent_id_pk" PRIMARY KEY("operation_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "computer_lifecycle_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parent_operation_id" uuid,
	"server_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"action" text NOT NULL,
	"cause" text DEFAULT 'user_action' NOT NULL,
	"actor_user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"dispatch_mode" text NOT NULL,
	"dispatch_status" text DEFAULT 'pending' NOT NULL,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"dispatch_lease_at" timestamp with time zone,
	"command_sent_at" timestamp with time zone,
	"target_version" text,
	"connection_epoch_before" text,
	"shutdown_ack_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"ready_ack_at" timestamp with time zone,
	"ready_connection_epoch" text,
	"loaded_computer_version" text,
	"shutdown_deadline_at" timestamp with time zone,
	"ready_deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone,
	"terminal_reason" text
);
--> statement-breakpoint
ALTER TABLE "computer_lifecycle_operation_targets" ADD CONSTRAINT "computer_lifecycle_operation_targets_operation_id_computer_lifecycle_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."computer_lifecycle_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_lifecycle_operations" ADD CONSTRAINT "computer_lifecycle_operations_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_lifecycle_operations" ADD CONSTRAINT "computer_lifecycle_operations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_computer_lifecycle_operation_targets_machine" ON "computer_lifecycle_operation_targets" USING btree ("machine_id_at_intent");--> statement-breakpoint
CREATE INDEX "idx_computer_lifecycle_operations_machine_status" ON "computer_lifecycle_operations" USING btree ("machine_id","status");--> statement-breakpoint
CREATE INDEX "idx_computer_lifecycle_operations_actor" ON "computer_lifecycle_operations" USING btree ("actor_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_computer_lifecycle_operations_one_pending_action" ON "computer_lifecycle_operations" USING btree ("server_id","machine_id","action") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_computer_lifecycle_operations_parent_scope" ON "computer_lifecycle_operations" USING btree ("parent_operation_id","server_id","machine_id","action");