CREATE TABLE "appsumo_license_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid,
	"product_id" text NOT NULL,
	"original_license_key" uuid NOT NULL,
	"current_license_key" uuid NOT NULL,
	"bound_by_user_id" uuid,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appsumo_license_bindings_server_id_unique" UNIQUE("server_id"),
	CONSTRAINT "appsumo_binding_original_unique" UNIQUE("product_id","original_license_key"),
	CONSTRAINT "appsumo_binding_current_unique" UNIQUE("product_id","current_license_key")
);
--> statement-breakpoint
CREATE TABLE "appsumo_licenses" (
	"product_id" text NOT NULL,
	"license_key" uuid NOT NULL,
	"previous_license_key" uuid,
	"tier" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appsumo_licenses_product_id_license_key_pk" PRIMARY KEY("product_id","license_key"),
	CONSTRAINT "appsumo_license_successor_unique" UNIQUE("product_id","previous_license_key"),
	CONSTRAINT "appsumo_license_product_check" CHECK (length("appsumo_licenses"."product_id") between 1 and 80),
	CONSTRAINT "appsumo_license_tier_check" CHECK ("appsumo_licenses"."tier" is null or "appsumo_licenses"."tier" between 1 and 4),
	CONSTRAINT "appsumo_license_status_check" CHECK ("appsumo_licenses"."status" in ('pending', 'inactive', 'active', 'deactivated')),
	CONSTRAINT "appsumo_license_verified_check" CHECK ("appsumo_licenses"."status" <> 'active' or ("appsumo_licenses"."verified_at" is not null and "appsumo_licenses"."tier" is not null)),
	CONSTRAINT "appsumo_license_previous_check" CHECK ("appsumo_licenses"."previous_license_key" is null or "appsumo_licenses"."previous_license_key" <> "appsumo_licenses"."license_key"),
	CONSTRAINT "appsumo_license_revision_check" CHECK ("appsumo_licenses"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "appsumo_license_bindings" ADD CONSTRAINT "appsumo_license_bindings_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appsumo_license_bindings" ADD CONSTRAINT "appsumo_license_bindings_bound_by_user_id_users_id_fk" FOREIGN KEY ("bound_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appsumo_license_bindings" ADD CONSTRAINT "appsumo_binding_original_fk" FOREIGN KEY ("product_id","original_license_key") REFERENCES "public"."appsumo_licenses"("product_id","license_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appsumo_license_bindings" ADD CONSTRAINT "appsumo_binding_current_fk" FOREIGN KEY ("product_id","current_license_key") REFERENCES "public"."appsumo_licenses"("product_id","license_key") ON DELETE no action ON UPDATE no action;