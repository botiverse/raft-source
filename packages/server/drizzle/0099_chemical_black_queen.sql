ALTER TABLE "servers" ADD COLUMN "kind" text DEFAULT 'normal' NOT NULL;
ALTER TABLE "servers"
  ADD CONSTRAINT "servers_kind_check"
  CHECK ("kind" IN ('normal', 'joint_storage'));
