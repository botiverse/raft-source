CREATE TABLE "app_mcp_profiles" (
	"app_id" uuid PRIMARY KEY NOT NULL,
	"app_kind" text DEFAULT 'mcp' NOT NULL,
	"managed_mcp_server_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_mcp_profiles_managed_mcp_server_id_unique" UNIQUE("managed_mcp_server_id"),
	CONSTRAINT "app_mcp_profiles_app_kind_pinned" CHECK ("app_mcp_profiles"."app_kind" = 'mcp')
);
--> statement-breakpoint
CREATE TABLE "app_oauth_profiles" (
	"app_id" uuid PRIMARY KEY NOT NULL,
	"app_kind" text DEFAULT 'oauth_service' NOT NULL,
	"oauth_client_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_oauth_profiles_oauth_client_id_unique" UNIQUE("oauth_client_id"),
	CONSTRAINT "app_oauth_profiles_app_kind_pinned" CHECK ("app_oauth_profiles"."app_kind" = 'oauth_service')
);
--> statement-breakpoint
CREATE TABLE "raft_apps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"distribution" text NOT NULL,
	"metadata_revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raft_apps_id_kind_unique" UNIQUE("id","kind"),
	CONSTRAINT "raft_apps_kind_valid" CHECK ("raft_apps"."kind" IN ('oauth_service', 'mcp')),
	CONSTRAINT "raft_apps_distribution_valid" CHECK ("raft_apps"."distribution" IN ('server_local', 'slock_builtin', 'third_party_global')),
	CONSTRAINT "raft_apps_metadata_revision_nonnegative" CHECK ("raft_apps"."metadata_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app_mcp_profiles" ADD CONSTRAINT "app_mcp_profiles_managed_mcp_server_id_managed_mcp_servers_id_fk" FOREIGN KEY ("managed_mcp_server_id") REFERENCES "public"."managed_mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_mcp_profiles" ADD CONSTRAINT "app_mcp_profiles_app_id_kind_raft_apps_id_kind_fk" FOREIGN KEY ("app_id","app_kind") REFERENCES "public"."raft_apps"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_oauth_profiles" ADD CONSTRAINT "app_oauth_profiles_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_oauth_profiles" ADD CONSTRAINT "app_oauth_profiles_app_id_kind_raft_apps_id_kind_fk" FOREIGN KEY ("app_id","app_kind") REFERENCES "public"."raft_apps"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raft_apps" ADD CONSTRAINT "raft_apps_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_raft_apps_server" ON "raft_apps" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_raft_apps_kind" ON "raft_apps" USING btree ("kind");--> statement-breakpoint
-- ── App root identity ───────────────────────────────────────────────────────────────
-- `oauth_clients.id` and `managed_mcp_servers.id` are two INDEPENDENT uuid namespaces:
-- nothing prevents the same value from appearing in both. Reusing a source id AS the root
-- id therefore lets one value name two different Apps -- and the collision is silent, so
-- the surviving root carries the wrong kind for one of its profiles.
--
-- The root id is DERIVED from (adapter, source id) instead. Same inputs always give the
-- same root, so backfill stays replayable; different adapters can never give the same
-- root, so the two namespaces cannot collide. md5() is core PostgreSQL (no extension, so
-- this also runs under PGlite), and the version/variant nibbles are pinned so the result
-- is a well-formed name-based UUID rather than something mistakable for a random one.
--
-- The legacy join key is NOT lost: it stays in the profile tables, which is where a later
-- phase resolves App identity from.
--
-- EVERY object below is schema-qualified and every function pins `search_path`. These
-- triggers are the load-bearing surface for the rolling invariant, so they must not be
-- resolvable through the CALLER's path: with `search_path = shadow, public` and a
-- same-named `shadow.raft_apps`, unqualified bodies wrote the root and profile into the
-- shadow tables while `public.raft_apps` silently stayed empty. Qualification is what
-- makes the write target a property of the migration rather than of the session.
-- Invoker rights are kept deliberately -- nothing here needs SECURITY DEFINER.
CREATE FUNCTION public.raft_app_root_id(p_kind text, p_source_id uuid) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.overlay(
           pg_catalog.overlay(
             pg_catalog.md5('raft_app_root:v1:' || p_kind || ':' || p_source_id::text),
             '3', 13
           ),
           '8', 17
         )::uuid;
$$;--> statement-breakpoint
-- An App root may not change execution adapter underneath its profile. Without this, an
-- upsert that "fixes" a row could silently re-point a profile at a different adapter.
CREATE FUNCTION public.raft_apps_kind_is_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'raft_apps.kind is immutable (% -> %) for app %', OLD.kind, NEW.kind, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER raft_apps_kind_immutable
BEFORE UPDATE ON public.raft_apps
FOR EACH ROW EXECUTE FUNCTION public.raft_apps_kind_is_immutable();--> statement-breakpoint
-- ── Legacy lifecycle -> dark root/profile ───────────────────────────────────────────
-- Backfill alone cannot hold the invariants during a ROLLING deploy: old server code is
-- still serving after the migration lands, it writes the legacy tables directly, and it
-- knows nothing about `raft_apps`. A create would then leave no root and a delete would
-- leave an orphan. Owning this in the DATABASE covers the old binary too -- changing only
-- new application code would not.
--
-- `ON CONFLICT (id, kind)` is the load-bearing detail: replaying the same row matches the
-- arbiter and is a no-op, while a row whose id already exists under a DIFFERENT kind does
-- not match it, hits the primary key instead, and RAISES. A kind mismatch aborts the
-- transaction rather than being silently swallowed.
--
-- These triggers maintain the dark root/profile ONLY. They write no legacy column, so no
-- existing response, permission, credential or outbound-notification authority changes.
CREATE FUNCTION public.raft_apps_sync_oauth_root() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.raft_apps
    WHERE "id" = public.raft_app_root_id('oauth_service', OLD."id");
    RETURN OLD;
  END IF;
  INSERT INTO public.raft_apps ("id", "server_id", "kind", "distribution", "created_at", "updated_at")
  VALUES (
    public.raft_app_root_id('oauth_service', NEW."id"), NEW."server_id", 'oauth_service',
    NEW."app_type", NEW."created_at", NEW."updated_at"
  )
  ON CONFLICT ("id", "kind") DO UPDATE SET
    "server_id" = EXCLUDED."server_id",
    "distribution" = EXCLUDED."distribution",
    "updated_at" = EXCLUDED."updated_at";
  INSERT INTO public.app_oauth_profiles ("app_id", "oauth_client_id", "created_at", "updated_at")
  VALUES (public.raft_app_root_id('oauth_service', NEW."id"), NEW."id", NEW."created_at", NEW."updated_at")
  ON CONFLICT ("app_id") DO UPDATE SET "updated_at" = EXCLUDED."updated_at";
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION public.raft_apps_sync_mcp_root() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.raft_apps
    WHERE "id" = public.raft_app_root_id('mcp', OLD."id");
    RETURN OLD;
  END IF;
  INSERT INTO public.raft_apps ("id", "server_id", "kind", "distribution", "created_at", "updated_at")
  VALUES (
    public.raft_app_root_id('mcp', NEW."id"), NEW."server_id", 'mcp',
    'server_local', NEW."created_at", NEW."updated_at"
  )
  ON CONFLICT ("id", "kind") DO UPDATE SET
    "server_id" = EXCLUDED."server_id",
    "distribution" = EXCLUDED."distribution",
    "updated_at" = EXCLUDED."updated_at";
  INSERT INTO public.app_mcp_profiles ("app_id", "managed_mcp_server_id", "created_at", "updated_at")
  VALUES (public.raft_app_root_id('mcp', NEW."id"), NEW."id", NEW."created_at", NEW."updated_at")
  ON CONFLICT ("app_id") DO UPDATE SET "updated_at" = EXCLUDED."updated_at";
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER oauth_clients_app_root_sync
AFTER INSERT OR UPDATE OR DELETE ON public.oauth_clients
FOR EACH ROW EXECUTE FUNCTION public.raft_apps_sync_oauth_root();--> statement-breakpoint
CREATE TRIGGER managed_mcp_servers_app_root_sync
AFTER INSERT OR UPDATE OR DELETE ON public.managed_mcp_servers
FOR EACH ROW EXECUTE FUNCTION public.raft_apps_sync_mcp_root();--> statement-breakpoint
-- ── Backfill ────────────────────────────────────────────────────────────────────────
-- Phase 1A ATTACHES identity; it does not move or copy any live field. No mutable
-- identity column is carried: name/description/icon/category/enabled stay in the legacy
-- tables, which remain authoritative and are where compatibility reads already look. A
-- column that is never copied cannot drift, so root/source divergence is unrepresentable
-- here rather than merely discouraged -- symmetrically for both adapters.
INSERT INTO public.raft_apps ("id", "server_id", "kind", "distribution", "created_at", "updated_at")
SELECT public.raft_app_root_id('oauth_service', "id"), "server_id", 'oauth_service', "app_type", "created_at", "updated_at"
FROM public.oauth_clients
ON CONFLICT ("id", "kind") DO NOTHING;--> statement-breakpoint
INSERT INTO public.app_oauth_profiles ("app_id", "oauth_client_id", "created_at", "updated_at")
SELECT public.raft_app_root_id('oauth_service', "id"), "id", "created_at", "updated_at"
FROM public.oauth_clients
ON CONFLICT ("app_id") DO NOTHING;--> statement-breakpoint
-- `managed_mcp_servers` has no distribution axis of its own, and a Server-scoped MCP
-- record is server-local by construction, so that value is DERIVED rather than invented.
INSERT INTO public.raft_apps ("id", "server_id", "kind", "distribution", "created_at", "updated_at")
SELECT public.raft_app_root_id('mcp', "id"), "server_id", 'mcp', 'server_local', "created_at", "updated_at"
FROM public.managed_mcp_servers
ON CONFLICT ("id", "kind") DO NOTHING;--> statement-breakpoint
INSERT INTO public.app_mcp_profiles ("app_id", "managed_mcp_server_id", "created_at", "updated_at")
SELECT public.raft_app_root_id('mcp', "id"), "id", "created_at", "updated_at"
FROM public.managed_mcp_servers
ON CONFLICT ("app_id") DO NOTHING;
