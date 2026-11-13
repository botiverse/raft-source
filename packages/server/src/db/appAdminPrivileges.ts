// App Admin (botiverse/slock-internal-app-admin) makes Marketplace decisions,
// keeps the official App registry and edits the MCP App template catalog only
// through database functions (#proj-apps tasks #19, #48). Its role,
// app_admin_operator, may use schema public, execute exactly the functions
// below and read exactly the columns below: no write privilege on anything, no
// sequence privilege, no other definer-rights function (Tenny 3b715a22,
// c76c6175). Its connection string writes to no table directly and reads no
// credential, but stays a sensitive credential: the functions trust the actor
// id their caller passes, so a leak means rotating it at once. Review decisions
// go through the gated
// app_admin_* entries only, which check that the actor is a person who is a
// Botiverse owner or admin now; the decision bodies behind them
// (marketplace_decide_*, marketplace_approve_*) stay the owner's. Migrations
// own the grants through
// public.reconcile_app_admin_privileges(), as Feature Flag Admin's do; the
// server deploy runs it and reads the result back with this module
// (scripts/verify-app-admin-privileges.ts). The role itself is created by a
// person with Neon admin; until it exists the reconciler does nothing.

export const APP_ADMIN_OPERATOR_ROLE = "app_admin_operator";

/** Everything app_admin_operator may execute. */
export const APP_ADMIN_EXECUTABLE_FUNCTIONS = [
  "public.app_admin_decide_publish_review(uuid, text, text, text, uuid, text)",
  "public.app_admin_decide_action_endpoint_review(uuid, text, text, text, uuid, text)",
  "public.app_admin_approve_permission_review(uuid, uuid, text, uuid)",
  "public.official_app_registry_register(uuid, text, text, uuid)",
  "public.official_app_registry_update(uuid, integer, text, text, text, uuid)",
  "public.app_admin_create_mcp_app_template(text, text, text, text, text, text, text, text, uuid, text, uuid)",
  "public.app_admin_update_mcp_app_template(uuid, integer, text, text, text, text, text, text, text, uuid, text, uuid)",
  "public.app_admin_retire_mcp_app_template(uuid, integer, uuid, text, uuid)",
  "public.app_admin_change_client_key(uuid, text, text, text, uuid, text)",
  "public.app_admin_create_mcp_app_template_v2(text, text, text, text, text, text, text, text, text, uuid, text, uuid)",
  "public.app_admin_update_mcp_app_template_v2(uuid, integer, text, text, text, text, text, text, text, text, uuid, text, uuid)",
  "public.app_admin_retire_mcp_app_template_v2(uuid, integer, uuid, text, uuid)",
  "public.app_admin_restore_mcp_app_template_v2(uuid, integer, text, uuid, text, uuid)",
  "public.app_admin_can_manage_mcp_templates(text, uuid)",
] as const;

/**
 * Everything app_admin_operator may read: its pages' columns. Granted by
 * column on every table, never by table, so a column added later is unreadable
 * until a contract lists it. Never a credential: no token or code hash, client
 * or webhook secret, password hash, or email. A new App Admin query that needs
 * another column needs a new contract first.
 */
export const APP_ADMIN_READABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  external_app_registrations: ["oauth_client_id"],
  integration_audit_events: ["id", "server_id", "client_id", "event_type", "event_category", "outcome", "source", "actor_type", "actor_id", "requester_type", "requester_id", "subject_type", "subject_id", "target_type", "target_id", "correlation_id", "request_id", "metadata", "diff", "created_at"],
  mcp_app_templates: ["id", "key", "name", "description", "homepage_url", "logo_url", "category", "endpoint_url", "auth_kind", "oauth_client_mode", "status", "revision", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at"],
  oauth_access_requests: ["id", "client_id", "server_id", "principal_type", "user_id", "agent_id", "status", "consumed_at", "created_at"],
  oauth_access_tokens: ["request_id", "created_at"],
  oauth_app_link_previews: ["client_id", "origin", "action_endpoint", "pending_action_endpoint", "pending_action_endpoint_requested_at", "action_endpoint_reject_reason", "verified_at", "suspended_at"],
  oauth_app_permission_revisions: ["id", "client_id", "revision", "requested_groups", "requested_events", "state", "created_by_type", "created_at"],
  oauth_client_installs: ["client_id", "server_id"],
  oauth_clients: ["id", "server_id", "client_id", "app_type", "name", "description", "homepage_url", "return_url", "agent_manifest_url", "logo_url", "logo_storage_key", "category", "enabled", "human_marketplace_visible", "publish_status", "publish_requested_at", "publish_reviewed_at", "publish_reviewed_by_user_id", "publish_rejection_reason", "created_by_user_id", "outbound_pending_revision_id", "outbound_current_groups", "outbound_current_events", "created_at", "updated_at"],
  official_app_registry: ["oauth_client_id", "client_key", "publisher_server_id", "auto_install", "purpose", "status", "revision", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at"],
  server_members: ["server_id", "user_id", "role"],
  servers: ["id", "name", "slug", "deleted_at"],
  users: ["id", "name", "display_name", "retired_at"],
};

/** The receipt the latest reconciler writes: its migration redefines the reconciler in full. */
export const APP_ADMIN_PRIVILEGE_CONTRACT_KEY = "app-admin-functions-v9";
export const APP_ADMIN_PRIVILEGE_MIGRATION_TAG = "0666_app_admin_mcp_manager_probe";

/**
 * App Admin resumes permission approvals once this exists (it looks it up with
 * to_regprocedure, which needs no EXECUTE): the permission body keeps
 * installation.bot_changed and writes its outbox rows. Owner-only, revoked
 * from App Admin's role by name.
 */
export const MARKETPLACE_PERMISSION_REVIEW_MARKER_FUNCTION = "public.marketplace_permission_review_keeps_bot_changed()";

export type AppAdminPrivilegeQuery = (
  text: string,
  values?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export class AppAdminPrivilegeError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "AppAdminPrivilegeError";
  }
}

/** SQL: this ACL grants SELECT to the role ($1) itself or to a role it belongs to; PUBLIC (grantee 0) isn't one. */
const roleHeldSelectIn = (acl: string) => `EXISTS (
  SELECT 1 FROM pg_catalog.aclexplode(${acl}) AS grant_entry
   WHERE grant_entry.privilege_type = 'SELECT' AND grant_entry.grantee <> 0
     AND pg_catalog.pg_has_role($1, grant_entry.grantee, 'MEMBER'))`;

/**
 * SQL, for relation `c`: an extension's object whose SELECT reaches the role
 * only through PUBLIC. Neon grants `pg_stat_statements` and
 * `pg_stat_statements_info` to PUBLIC, has_table_privilege counts that, and the
 * grant isn't ours to revoke (Tenny and cross, #proj-apps:#48). This covers
 * SELECT and nothing else: write privileges are always checked, and an ordinary
 * table granted to PUBLIC, or a SELECT granted to the role or a role it belongs
 * to (on the object or one column), still fails. PUBLIC must really hold the
 * SELECT: a NULL relacl means the default ACL, the owner's alone, so a role that
 * reads such an object does so as the owner or a member of it, and fails.
 */
const RELATION_ACL = "COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))";
const PUBLIC_ONLY_EXTENSION_SELECT = `(EXISTS (
  SELECT 1 FROM pg_catalog.pg_depend d
   WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid AND d.objsubid = 0 AND d.deptype = 'e')
  AND EXISTS (SELECT 1 FROM pg_catalog.aclexplode(${RELATION_ACL}) AS public_entry
               WHERE public_entry.grantee = 0 AND public_entry.privilege_type = 'SELECT')
  AND NOT ${roleHeldSelectIn(RELATION_ACL)})`;

/** Fails unless the role holds exactly the privileges above, inherited ones included. */
export async function verifyAppAdminPrivileges(query: AppAdminPrivilegeQuery): Promise<void> {
  const role = APP_ADMIN_OPERATOR_ROLE;
  const exists = await query("SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS allowed", [role]);
  if (exists.rows[0]?.allowed !== true) throw new AppAdminPrivilegeError("role_missing");

  const schema = await query(
    `SELECT pg_catalog.has_schema_privilege($1, 'public', 'USAGE') AS usage,
            pg_catalog.has_schema_privilege($1, 'public', 'CREATE') AS create_,
            pg_catalog.has_schema_privilege($1, 'public', 'USAGE WITH GRANT OPTION') AS usage_grant`,
    [role],
  );
  if (schema.rows[0]?.usage !== true) throw new AppAdminPrivilegeError("missing:public:USAGE");
  if (schema.rows[0]?.create_ !== false) throw new AppAdminPrivilegeError("unexpected:public:CREATE");
  if (schema.rows[0]?.usage_grant !== false) throw new AppAdminPrivilegeError("unexpected:public:USAGE WITH GRANT OPTION");

  for (const fn of APP_ADMIN_EXECUTABLE_FUNCTIONS) {
    const execute = await query(
      `SELECT pg_catalog.has_function_privilege($1, $2, 'EXECUTE') AS allowed,
              pg_catalog.has_function_privilege($1, $2, 'EXECUTE WITH GRANT OPTION') AS grantable`,
      [role, fn],
    );
    if (execute.rows[0]?.allowed !== true) throw new AppAdminPrivilegeError(`missing:${fn}:EXECUTE`);
    if (execute.rows[0]?.grantable !== false) throw new AppAdminPrivilegeError(`unexpected:${fn}:EXECUTE WITH GRANT OPTION`);
  }

  const relations = await query(
    `SELECT pg_catalog.format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND (
        (c.relkind IN ('r', 'p', 'v', 'm', 'f') AND (
          (pg_catalog.has_table_privilege($1, c.oid, 'SELECT') AND NOT ${PUBLIC_ONLY_EXTENSION_SELECT})
          OR pg_catalog.has_table_privilege($1, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
          OR pg_catalog.has_any_column_privilege($1, c.oid, 'INSERT, UPDATE, REFERENCES')))
        OR (c.relkind = 'S' AND pg_catalog.has_sequence_privilege($1, c.oid, 'USAGE, SELECT, UPDATE'))
      )
      ORDER BY 1
      LIMIT 1`,
    [role],
  );
  const relation = relations.rows[0]?.name;
  if (relation !== undefined) throw new AppAdminPrivilegeError(`unexpected:${String(relation)}`);

  const readable = await query(
    `SELECT c.relname AS relation, a.attname AS column_name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND NOT (${PUBLIC_ONLY_EXTENSION_SELECT} AND NOT ${roleHeldSelectIn("a.attacl")})
        AND pg_catalog.has_column_privilege($1, c.oid, a.attnum, 'SELECT')
      ORDER BY 1, 2`,
    [role],
  );
  const listed = new Set(Object.entries(APP_ADMIN_READABLE_COLUMNS).flatMap(([table, columns]) => columns.map((column) => `public.${table}.${column}`)));
  const held = new Set(readable.rows.map((row) => `public.${String(row.relation)}.${String(row.column_name)}`));
  for (const column of held) {
    if (!listed.has(column)) throw new AppAdminPrivilegeError(`unexpected:${column}:SELECT`);
  }
  for (const column of listed) {
    if (!held.has(column)) throw new AppAdminPrivilegeError(`missing:${column}:SELECT`);
  }

  // EXECUTE on an invoker-rights function needs the table privileges above
  // to do anything; a definer-rights one does not, so only the listed ones.
  const definers = await query(
    `SELECT p.oid::pg_catalog.regprocedure::text AS name
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE')
        AND p.oid <> ALL ($2::text[]::pg_catalog.regprocedure[])
      ORDER BY 1
      LIMIT 1`,
    [role, [...APP_ADMIN_EXECUTABLE_FUNCTIONS]],
  );
  const definer = definers.rows[0]?.name;
  if (definer !== undefined) throw new AppAdminPrivilegeError(`unexpected:${String(definer)}:EXECUTE`);
}

/** The reconciler from this contract's migration ran, as the principal reading it back. */
export async function verifyAppAdminPrivilegeReceipt(query: AppAdminPrivilegeQuery): Promise<void> {
  const result = await query(
    `SELECT migration_tag, applied_by, current_user AS current_user
       FROM public.app_admin_privilege_receipts
      WHERE contract_key = $1`,
    [APP_ADMIN_PRIVILEGE_CONTRACT_KEY],
  );
  const row = result.rows[0];
  if (row?.migration_tag !== APP_ADMIN_PRIVILEGE_MIGRATION_TAG) throw new AppAdminPrivilegeError("privilege_receipt_missing");
  if (typeof row.current_user !== "string" || row.applied_by !== row.current_user) {
    throw new AppAdminPrivilegeError("privilege_receipt_principal_mismatch");
  }
}

export interface AppAdminPrivilegeOptions {
  /**
   * The reconciler must exist: a deploy, whose migrations just created it.
   * Off, a database without it (a migration test's own throwaway journal)
   * answers "reconciler_missing" instead of failing.
   */
  requireReconciler: boolean;
}

/**
 * "role_missing" until a person creates app_admin_operator; then reconciled
 * and verified, or it throws. "reconciler_missing" only when the reconciler
 * is not required and the database has none.
 */
export async function reconcileAndVerifyAppAdminPrivileges(
  query: AppAdminPrivilegeQuery,
  options: AppAdminPrivilegeOptions = { requireReconciler: true },
): Promise<"reconciler_missing" | "role_missing" | "verified"> {
  const present = (await query(
    "SELECT pg_catalog.to_regprocedure('public.reconcile_app_admin_privileges()') IS NOT NULL AS present",
  )).rows[0]?.present;
  if (present !== true) {
    if (options.requireReconciler) throw new AppAdminPrivilegeError("reconciler_missing");
    return "reconciler_missing";
  }
  const reconciled = (await query("SELECT public.reconcile_app_admin_privileges() AS reconciled")).rows[0]?.reconciled;
  if (reconciled === false) return "role_missing";
  if (reconciled !== true) throw new AppAdminPrivilegeError("unreadable:reconcile");
  await verifyAppAdminPrivilegeReceipt(query);
  await verifyAppAdminPrivileges(query);
  return "verified";
}
