ALTER TABLE "agent_channel_read_cursors" ADD COLUMN "read_state_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_channel_read_cursors" ADD COLUMN "last_applied_authority_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "read_mutation_authorities" ADD COLUMN "principal_type" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "read_mutation_tombstones" ADD COLUMN "principal_type" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "read_mutations" ADD COLUMN "principal_type" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "read_mutation_authorities" DROP CONSTRAINT "read_mutation_authorities_principal_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "read_mutation_tombstones" DROP CONSTRAINT "read_mutation_tombstones_principal_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "read_mutations" DROP CONSTRAINT "read_mutations_principal_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "read_mutation_authorities_worker_schedule_idx";--> statement-breakpoint
DROP INDEX "read_mutation_tombstones_authority_seq_unique";--> statement-breakpoint
DROP INDEX "read_mutations_authority_seq_unique";--> statement-breakpoint
DROP INDEX "read_mutations_worker_order_idx";--> statement-breakpoint
ALTER TABLE "read_mutation_authorities" DROP CONSTRAINT "read_mutation_authorities_server_id_principal_id_pk";--> statement-breakpoint
ALTER TABLE "read_mutation_tombstones" DROP CONSTRAINT "read_mutation_tombstones_server_id_principal_id_mutation_id_pk";--> statement-breakpoint
ALTER TABLE "read_mutations" DROP CONSTRAINT "read_mutations_server_id_principal_id_mutation_id_pk";--> statement-breakpoint
ALTER TABLE "read_mutation_authorities" ADD CONSTRAINT "read_mutation_authorities_server_id_principal_type_principal_id_pk" PRIMARY KEY("server_id","principal_type","principal_id");--> statement-breakpoint
ALTER TABLE "read_mutation_tombstones" ADD CONSTRAINT "read_mutation_tombstones_server_id_principal_type_principal_id_mutation_id_pk" PRIMARY KEY("server_id","principal_type","principal_id","mutation_id");--> statement-breakpoint
ALTER TABLE "read_mutations" ADD CONSTRAINT "read_mutations_server_id_principal_type_principal_id_mutation_id_pk" PRIMARY KEY("server_id","principal_type","principal_id","mutation_id");--> statement-breakpoint
CREATE INDEX "read_mutation_authorities_worker_schedule_idx" ON "read_mutation_authorities" USING btree ("worker_last_scheduled_at","server_id","principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "read_mutation_tombstones_authority_seq_unique" ON "read_mutation_tombstones" USING btree ("server_id","principal_type","principal_id","original_authority_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "read_mutations_authority_seq_unique" ON "read_mutations" USING btree ("server_id","principal_type","principal_id","authority_seq");--> statement-breakpoint
CREATE INDEX "read_mutations_worker_order_idx" ON "read_mutations" USING btree ("server_id","principal_type","principal_id","authority_seq");
