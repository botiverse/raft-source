export const FEATURE_FLAG_ADMIN_OPERATOR_ROLE = "feature_flag_admin_operator";
export const FEATURE_FLAG_ADMIN_ANNOUNCEMENT_RULES_REACH_FUNCTION = "public.announcement_rules_reach(jsonb, text, uuid[], uuid[], timestamptz)";

export const REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES = [
  { kind: "schema", object: "public", privilege: "USAGE" },
  { kind: "table", object: "public.announcements", privilege: "SELECT" },
  { kind: "table", object: "public.announcements", privilege: "INSERT" },
  { kind: "table", object: "public.announcements", privilege: "UPDATE" },
  { kind: "table", object: "public.announcement_audit_events", privilege: "SELECT" },
  { kind: "table", object: "public.announcement_audit_events", privilege: "INSERT" },
  { kind: "table", object: "public.announcement_image_assets", privilege: "SELECT" },
  { kind: "table", object: "public.announcement_image_assets", privilege: "INSERT" },
  { kind: "table", object: "public.announcement_image_assets", privilege: "UPDATE" },
  { kind: "table", object: "public.announcement_image_assets", privilege: "DELETE" },
  { kind: "table", object: "public.feature_flag_audiences", privilege: "SELECT" },
  { kind: "table", object: "public.feature_flag_audiences", privilege: "INSERT" },
  { kind: "table", object: "public.feature_flag_audiences", privilege: "UPDATE" },
  { kind: "table", object: "public.feature_flag_audience_members", privilege: "SELECT" },
  { kind: "table", object: "public.feature_flag_audience_members", privilege: "INSERT" },
  { kind: "table", object: "public.feature_flag_audience_members", privilege: "DELETE" },
  { kind: "column", object: "public.users", column: "id", privilege: "SELECT" },
  { kind: "column", object: "public.servers", column: "id", privilege: "SELECT" },
  { kind: "column", object: "public.servers", column: "kind", privilege: "SELECT" },
  { kind: "column", object: "public.server_members", column: "server_id", privilege: "SELECT" },
  { kind: "column", object: "public.server_members", column: "user_id", privilege: "SELECT" },
  { kind: "column", object: "public.server_members", column: "role", privilege: "SELECT" },
  { kind: "column", object: "public.servers", column: "slug", privilege: "SELECT" },
  { kind: "column", object: "public.servers", column: "deleted_at", privilege: "SELECT" },
  { kind: "column", object: "public.servers", column: "plan", privilege: "SELECT" },
  { kind: "column", object: "public.subscriptions", column: "server_id", privilege: "SELECT" },
  { kind: "column", object: "public.subscriptions", column: "plan", privilege: "SELECT" },
  { kind: "column", object: "public.subscriptions", column: "status", privilege: "SELECT" },
  { kind: "column", object: "public.server_lab_enrollments", column: "server_id", privilege: "SELECT" },
  { kind: "column", object: "public.server_lab_enrollments", column: "lab_key", privilege: "SELECT" },
  { kind: "column", object: "public.server_lab_enrollments", column: "enabled", privilege: "SELECT" },
  { kind: "column", object: "public.server_lab_access", column: "server_id", privilege: "SELECT" },
  { kind: "column", object: "public.server_lab_access", column: "enabled", privilege: "SELECT" },
  { kind: "column", object: "public.lab_definitions", column: "key", privilege: "SELECT" },
  { kind: "column", object: "public.lab_definitions", column: "state", privilege: "SELECT" },
  // Labs catalog admin (list/get/create-lab/set-lab-state), 0303: exact columns used by the Worker's Labs SQL.
  { kind: "column", object: "public.lab_definitions", column: "name", privilege: "SELECT" },
  { kind: "column", object: "public.lab_definitions", column: "description", privilege: "SELECT" },
  { kind: "column", object: "public.lab_definitions", column: "created_at", privilege: "SELECT" },
  { kind: "column", object: "public.lab_definitions", column: "updated_at", privilege: "SELECT" },
  { kind: "column", object: "public.lab_definitions", column: "key", privilege: "INSERT" },
  { kind: "column", object: "public.lab_definitions", column: "name", privilege: "INSERT" },
  { kind: "column", object: "public.lab_definitions", column: "description", privilege: "INSERT" },
  { kind: "column", object: "public.lab_definitions", column: "state", privilege: "INSERT" },
  { kind: "column", object: "public.lab_definitions", column: "created_at", privilege: "INSERT" },
  { kind: "column", object: "public.lab_definitions", column: "updated_at", privilege: "INSERT" },
  { kind: "column", object: "public.lab_definitions", column: "name", privilege: "UPDATE" },
  { kind: "column", object: "public.lab_definitions", column: "description", privilege: "UPDATE" },
  { kind: "column", object: "public.lab_definitions", column: "state", privilege: "UPDATE" },
  { kind: "column", object: "public.lab_definitions", column: "updated_at", privilege: "UPDATE" },
  // Trace identity lookup (agent_id_hash / server_id_hash -> agent), 0312: the Worker HMACs agent and
  // server ids itself, so it reads exactly these agents columns and nothing else (no name, no prompt).
  { kind: "column", object: "public.agents", column: "id", privilege: "SELECT" },
  { kind: "column", object: "public.agents", column: "server_id", privilege: "SELECT" },
  { kind: "column", object: "public.agents", column: "deleted_at", privilege: "SELECT" },
  // Official app registry (#proj-apps task #5), 0384: list/register/approve/disable entries;
  // no DELETE. Updates touch only the reviewable fields and bump revision.
  { kind: "column", object: "public.official_app_registry", column: "oauth_client_id", privilege: "SELECT" },
  { kind: "column", object: "public.official_app_registry", column: "client_key", privilege: "SELECT" },
  { kind: "column", object: "public.official_app_registry", column: "publisher_server_id", privilege: "SELECT" },
  { kind: "column", object: "public.official_app_registry", column: "auto_install", privilege: "SELECT" },
  { kind: "column", object: "public.official_app_registry", column: "purpose", privilege: "SELECT" },
  { kind: "column", object: "public.official_app_registry", column: "status", privilege: "SELECT" },
  { kind: "column", object: "public.official_app_registry", column: "revision", privilege: "SELECT" },
  { kind: "column", object: "public.official_app_registry", column: "created_by_user_id", privilege: "SELECT" },
  { kind: "column", object: "public.official_app_registry", column: "updated_by_user_id", privilege: "SELECT" },
  { kind: "column", object: "public.official_app_registry", column: "created_at", privilege: "SELECT" },
  { kind: "column", object: "public.official_app_registry", column: "updated_at", privilege: "SELECT" },
  { kind: "column", object: "public.official_app_registry", column: "oauth_client_id", privilege: "INSERT" },
  { kind: "column", object: "public.official_app_registry", column: "client_key", privilege: "INSERT" },
  { kind: "column", object: "public.official_app_registry", column: "publisher_server_id", privilege: "INSERT" },
  { kind: "column", object: "public.official_app_registry", column: "auto_install", privilege: "INSERT" },
  { kind: "column", object: "public.official_app_registry", column: "purpose", privilege: "INSERT" },
  { kind: "column", object: "public.official_app_registry", column: "status", privilege: "INSERT" },
  { kind: "column", object: "public.official_app_registry", column: "revision", privilege: "INSERT" },
  { kind: "column", object: "public.official_app_registry", column: "created_by_user_id", privilege: "INSERT" },
  { kind: "column", object: "public.official_app_registry", column: "updated_by_user_id", privilege: "INSERT" },
  { kind: "column", object: "public.official_app_registry", column: "created_at", privilege: "INSERT" },
  { kind: "column", object: "public.official_app_registry", column: "updated_at", privilege: "INSERT" },
  { kind: "column", object: "public.official_app_registry", column: "auto_install", privilege: "UPDATE" },
  { kind: "column", object: "public.official_app_registry", column: "purpose", privilege: "UPDATE" },
  { kind: "column", object: "public.official_app_registry", column: "status", privilege: "UPDATE" },
  { kind: "column", object: "public.official_app_registry", column: "revision", privilege: "UPDATE" },
  { kind: "column", object: "public.official_app_registry", column: "updated_by_user_id", privilege: "UPDATE" },
  { kind: "column", object: "public.official_app_registry", column: "updated_at", privilege: "UPDATE" },
  // The app an entry names, and that its identity matches oauth_clients (0384).
  { kind: "column", object: "public.oauth_clients", column: "id", privilege: "SELECT" },
  { kind: "column", object: "public.oauth_clients", column: "client_id", privilege: "SELECT" },
  { kind: "column", object: "public.oauth_clients", column: "server_id", privilege: "SELECT" },
  { kind: "column", object: "public.oauth_clients", column: "name", privilege: "SELECT" },
  { kind: "column", object: "public.oauth_clients", column: "app_type", privilege: "SELECT" },
  { kind: "column", object: "public.oauth_clients", column: "publish_status", privilege: "SELECT" },
  { kind: "column", object: "public.oauth_clients", column: "enabled", privilege: "SELECT" },
  // Append-only Raft-side audit of every registry write, in the same transaction (0384).
  { kind: "column", object: "public.integration_audit_events", column: "id", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "server_id", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "client_id", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "event_type", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "event_category", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "outcome", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "source", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "actor_type", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "actor_id", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "subject_type", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "subject_id", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "target_type", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "target_id", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "request_id", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "metadata", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "diff", privilege: "INSERT" },
  { kind: "column", object: "public.integration_audit_events", column: "created_at", privilege: "INSERT" },
  // Stuck interactive link card operations (RFC 076 §5.2), 0387: list them and mark one
  // resolved_manually. No INSERT/DELETE; the trigger allows this role only that one transition
  // and bumps receipt_revision itself.
  { kind: "column", object: "public.link_card_operations", column: "operation_id", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "viewer_id", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "server_id", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "provider_kind", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "provider_key", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "installation_key", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "message_id", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "action_id", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "state", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "receipt_revision", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "last_status_at", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "resolved_by_user_id", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "resolution_reason", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "resolved_at", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "created_at", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "updated_at", privilege: "SELECT" },
  { kind: "column", object: "public.link_card_operations", column: "state", privilege: "UPDATE" },
  { kind: "column", object: "public.link_card_operations", column: "resolved_by_user_id", privilege: "UPDATE" },
  { kind: "column", object: "public.link_card_operations", column: "resolution_reason", privilege: "UPDATE" },
  { kind: "column", object: "public.link_card_operations", column: "resolved_at", privilege: "UPDATE" },
  { kind: "column", object: "public.link_card_operations", column: "updated_at", privilege: "UPDATE" },
  // Announcement reach with audience rules, 0617: a count-only SECURITY DEFINER function, so the
  // role still cannot read users.created_at / display_language or servers.created_at itself.
  { kind: "function", object: FEATURE_FLAG_ADMIN_ANNOUNCEMENT_RULES_REACH_FUNCTION, privilege: "EXECUTE" },
] as const;

// Column-level writes the operator may hold on lab_definitions (0303). Anything else stays unexpected.
const FEATURE_FLAG_ADMIN_LAB_DEFINITION_INSERT_COLUMNS = ["created_at", "description", "key", "name", "state", "updated_at"] as const;
const FEATURE_FLAG_ADMIN_LAB_DEFINITION_UPDATE_COLUMNS = ["description", "name", "state", "updated_at"] as const;
// Column-level writes the operator may hold on official_app_registry and integration_audit_events (0384).
const FEATURE_FLAG_ADMIN_OFFICIAL_APP_REGISTRY_INSERT_COLUMNS = ["auto_install", "client_key", "created_at", "created_by_user_id", "oauth_client_id", "publisher_server_id", "purpose", "revision", "status", "updated_at", "updated_by_user_id"] as const;
const FEATURE_FLAG_ADMIN_OFFICIAL_APP_REGISTRY_UPDATE_COLUMNS = ["auto_install", "purpose", "revision", "status", "updated_at", "updated_by_user_id"] as const;
// Column-level writes the operator may hold on link_card_operations (0387).
const FEATURE_FLAG_ADMIN_LINK_CARD_OPERATION_UPDATE_COLUMNS = ["resolution_reason", "resolved_at", "resolved_by_user_id", "state", "updated_at"] as const;
const FEATURE_FLAG_ADMIN_INTEGRATION_AUDIT_INSERT_COLUMNS = ["actor_id", "actor_type", "client_id", "created_at", "diff", "event_category", "event_type", "id", "metadata", "outcome", "request_id", "server_id", "source", "subject_id", "subject_type", "target_id", "target_type"] as const;

export const FEATURE_FLAG_ADMIN_COLUMN_PROJECTIONS = [
  { object: "public.users", columns: ["id"] },
  { object: "public.server_members", columns: ["role", "server_id", "user_id"] },
  { object: "public.servers", columns: ["deleted_at", "id", "kind", "plan", "slug"] },
  { object: "public.subscriptions", columns: ["plan", "server_id", "status"] },
  { object: "public.server_lab_enrollments", columns: ["enabled", "lab_key", "server_id"] },
  { object: "public.server_lab_access", columns: ["enabled", "server_id"] },
  { object: "public.lab_definitions", columns: ["created_at", "description", "key", "name", "state", "updated_at"] },
  { object: "public.agents", columns: ["deleted_at", "id", "server_id"] },
  { object: "public.official_app_registry", columns: ["auto_install", "client_key", "created_at", "created_by_user_id", "oauth_client_id", "publisher_server_id", "purpose", "revision", "status", "updated_at", "updated_by_user_id"] },
  { object: "public.oauth_clients", columns: ["app_type", "client_id", "enabled", "id", "name", "publish_status", "server_id"] },
  { object: "public.link_card_operations", columns: ["action_id", "created_at", "installation_key", "last_status_at", "message_id", "operation_id", "provider_key", "provider_kind", "receipt_revision", "resolution_reason", "resolved_at", "resolved_by_user_id", "server_id", "state", "updated_at", "viewer_id"] },
] as const;

const FEATURE_FLAG_ADMIN_COLUMN_PRIVILEGE_OBJECTS = [
  "public.announcements",
  "public.announcement_audit_events",
  "public.announcement_image_assets",
  "public.feature_flag_audiences",
  "public.feature_flag_audience_members",
  "public.users",
  "public.servers",
  "public.server_members",
  "public.subscriptions",
  "public.server_lab_enrollments",
  "public.server_lab_access",
  "public.lab_definitions",
  "public.agents",
  "public.official_app_registry",
  "public.oauth_clients",
  "public.integration_audit_events",
  "public.link_card_operations",
] as const;

const FEATURE_FLAG_ADMIN_COLUMN_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "REFERENCES",
  "SELECT WITH GRANT OPTION",
  "INSERT WITH GRANT OPTION",
  "UPDATE WITH GRANT OPTION",
  "REFERENCES WITH GRANT OPTION",
] as const;

function isExpectedEffectiveColumnPrivilege(
  object: string,
  columnName: string,
  privilege: string,
): boolean {
  if (privilege.includes("WITH GRANT OPTION")) return false;
  if (object === "public.announcements") {
    return privilege === "SELECT" || privilege === "INSERT" || privilege === "UPDATE";
  }
  if (object === "public.announcement_audit_events") {
    return privilege === "SELECT" || privilege === "INSERT";
  }
  if (object === "public.announcement_image_assets") {
    return privilege === "SELECT" || privilege === "INSERT" || privilege === "UPDATE";
  }
  if (object === "public.feature_flag_audiences") {
    return privilege === "SELECT" || privilege === "INSERT" || privilege === "UPDATE";
  }
  if (object === "public.feature_flag_audience_members") {
    return privilege === "SELECT" || privilege === "INSERT";
  }
  if (object === "public.lab_definitions") {
    if (privilege === "INSERT") {
      return (FEATURE_FLAG_ADMIN_LAB_DEFINITION_INSERT_COLUMNS as readonly string[]).includes(columnName);
    }
    if (privilege === "UPDATE") {
      return (FEATURE_FLAG_ADMIN_LAB_DEFINITION_UPDATE_COLUMNS as readonly string[]).includes(columnName);
    }
  }
  if (object === "public.official_app_registry") {
    if (privilege === "INSERT") {
      return (FEATURE_FLAG_ADMIN_OFFICIAL_APP_REGISTRY_INSERT_COLUMNS as readonly string[]).includes(columnName);
    }
    if (privilege === "UPDATE") {
      return (FEATURE_FLAG_ADMIN_OFFICIAL_APP_REGISTRY_UPDATE_COLUMNS as readonly string[]).includes(columnName);
    }
  }
  if (object === "public.link_card_operations" && privilege === "UPDATE") {
    return (FEATURE_FLAG_ADMIN_LINK_CARD_OPERATION_UPDATE_COLUMNS as readonly string[]).includes(columnName);
  }
  if (object === "public.integration_audit_events") {
    return privilege === "INSERT"
      && (FEATURE_FLAG_ADMIN_INTEGRATION_AUDIT_INSERT_COLUMNS as readonly string[]).includes(columnName);
  }
  return FEATURE_FLAG_ADMIN_COLUMN_PROJECTIONS.some(
    (entry) => entry.object === object
      && privilege === "SELECT"
      && (entry.columns as readonly string[]).includes(columnName),
  );
}

export const FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES = [
  { kind: "schema", object: "public", privilege: "CREATE" },
  { kind: "function", object: FEATURE_FLAG_ADMIN_ANNOUNCEMENT_RULES_REACH_FUNCTION, privilege: "EXECUTE WITH GRANT OPTION" },
  { kind: "schema", object: "public", privilege: "USAGE WITH GRANT OPTION" },
  { kind: "schema", object: "public", privilege: "CREATE WITH GRANT OPTION" },
  { kind: "table", object: "public.announcements", privilege: "SELECT WITH GRANT OPTION" },
  { kind: "table", object: "public.announcements", privilege: "INSERT WITH GRANT OPTION" },
  { kind: "table", object: "public.announcements", privilege: "UPDATE WITH GRANT OPTION" },
  { kind: "table", object: "public.announcements", privilege: "DELETE" },
  { kind: "table", object: "public.announcements", privilege: "TRUNCATE" },
  { kind: "table", object: "public.announcements", privilege: "REFERENCES" },
  { kind: "table", object: "public.announcements", privilege: "TRIGGER" },
  { kind: "table", object: "public.announcement_audit_events", privilege: "SELECT WITH GRANT OPTION" },
  { kind: "table", object: "public.announcement_audit_events", privilege: "INSERT WITH GRANT OPTION" },
  { kind: "table", object: "public.announcement_audit_events", privilege: "UPDATE" },
  { kind: "table", object: "public.announcement_audit_events", privilege: "DELETE" },
  { kind: "table", object: "public.announcement_audit_events", privilege: "TRUNCATE" },
  { kind: "table", object: "public.announcement_audit_events", privilege: "REFERENCES" },
  { kind: "table", object: "public.announcement_audit_events", privilege: "TRIGGER" },
  { kind: "table", object: "public.announcement_image_assets", privilege: "SELECT WITH GRANT OPTION" },
  { kind: "table", object: "public.announcement_image_assets", privilege: "INSERT WITH GRANT OPTION" },
  { kind: "table", object: "public.announcement_image_assets", privilege: "UPDATE WITH GRANT OPTION" },
  { kind: "table", object: "public.announcement_image_assets", privilege: "DELETE WITH GRANT OPTION" },
  { kind: "table", object: "public.announcement_image_assets", privilege: "TRUNCATE" },
  { kind: "table", object: "public.announcement_image_assets", privilege: "REFERENCES" },
  { kind: "table", object: "public.announcement_image_assets", privilege: "TRIGGER" },
  { kind: "table", object: "public.feature_flag_audiences", privilege: "SELECT WITH GRANT OPTION" },
  { kind: "table", object: "public.feature_flag_audiences", privilege: "INSERT WITH GRANT OPTION" },
  { kind: "table", object: "public.feature_flag_audiences", privilege: "UPDATE WITH GRANT OPTION" },
  { kind: "table", object: "public.feature_flag_audiences", privilege: "DELETE" },
  { kind: "table", object: "public.feature_flag_audiences", privilege: "TRUNCATE" },
  { kind: "table", object: "public.feature_flag_audiences", privilege: "REFERENCES" },
  { kind: "table", object: "public.feature_flag_audiences", privilege: "TRIGGER" },
  { kind: "table", object: "public.feature_flag_audience_members", privilege: "SELECT WITH GRANT OPTION" },
  { kind: "table", object: "public.feature_flag_audience_members", privilege: "INSERT WITH GRANT OPTION" },
  { kind: "table", object: "public.feature_flag_audience_members", privilege: "DELETE WITH GRANT OPTION" },
  { kind: "table", object: "public.feature_flag_audience_members", privilege: "UPDATE" },
  { kind: "table", object: "public.feature_flag_audience_members", privilege: "TRUNCATE" },
  { kind: "table", object: "public.feature_flag_audience_members", privilege: "REFERENCES" },
  { kind: "table", object: "public.feature_flag_audience_members", privilege: "TRIGGER" },
  // Append-only, column-level: no table-level privilege of any kind (0384).
  ...["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].map((privilege) => ({
    kind: "table" as const,
    object: "public.integration_audit_events",
    privilege,
  })),
  ...FEATURE_FLAG_ADMIN_COLUMN_PROJECTIONS.flatMap((projection) => [
    { kind: "table" as const, object: projection.object, privilege: "SELECT" },
    { kind: "table" as const, object: projection.object, privilege: "INSERT" },
    { kind: "table" as const, object: projection.object, privilege: "UPDATE" },
    { kind: "table" as const, object: projection.object, privilege: "DELETE" },
    { kind: "table" as const, object: projection.object, privilege: "TRUNCATE" },
    { kind: "table" as const, object: projection.object, privilege: "REFERENCES" },
    { kind: "table" as const, object: projection.object, privilege: "TRIGGER" },
    ...projection.columns.map((column) => ({
      kind: "column" as const,
      object: projection.object,
      column,
      privilege: "SELECT WITH GRANT OPTION" as const,
    })),
  ]),
] as const;

type QueryResult = { rows: Array<Record<string, unknown>> };
export type FeatureFlagAdminPrivilegeQuery = (
  text: string,
  values?: unknown[],
) => Promise<QueryResult>;

export type FeatureFlagAdminPrivilegeCheck =
  | { readonly kind: "schema"; readonly object: string; readonly privilege: string }
  | { readonly kind: "table"; readonly object: string; readonly privilege: string }
  | { readonly kind: "function"; readonly object: string; readonly privilege: string }
  | {
    readonly kind: "column";
    readonly object: string;
    readonly column: string;
    readonly privilege: string;
  };

export function featureFlagAdminPrivilegeLabel(check: FeatureFlagAdminPrivilegeCheck): string {
  return check.kind === "column"
    ? `${check.object}:${check.column}:${check.privilege}`
    : `${check.object}:${check.privilege}`;
}

// One round trip for the whole privilege matrix. Each row evaluates exactly the
// same oracle the per-check loop used (has_schema_privilege / has_table_privilege
// / has_column_privilege with the same arguments); only the number of round
// trips changes. CASE evaluates only the branch matching `kind`, so column-only
// arguments are never passed to the schema/table oracles. Row order is pinned by
// WITH ORDINALITY so results line up with `checks` by index.
const FEATURE_FLAG_ADMIN_PRIVILEGE_MATRIX_ORACLE = `SELECT
       checks.ordinality AS idx,
       CASE checks.kind
         WHEN 'schema' THEN has_schema_privilege($1, checks.object, checks.privilege)
         WHEN 'table' THEN has_table_privilege($1, checks.object, checks.privilege)
         WHEN 'function' THEN has_function_privilege($1, checks.object, checks.privilege)
         ELSE has_column_privilege($1, checks.object, checks.column_name, checks.privilege)
       END AS allowed
     FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
       WITH ORDINALITY AS checks(kind, object, column_name, privilege, ordinality)
     ORDER BY checks.ordinality ASC`;

export async function readFeatureFlagAdminPrivilegeMatrix(
  query: FeatureFlagAdminPrivilegeQuery,
  checks: readonly FeatureFlagAdminPrivilegeCheck[],
): Promise<boolean[]> {
  if (checks.length === 0) return [];
  const result = await query(FEATURE_FLAG_ADMIN_PRIVILEGE_MATRIX_ORACLE, [
    FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
    checks.map((check) => check.kind),
    checks.map((check) => check.object),
    checks.map((check) => (check.kind === "column" ? check.column : "")),
    checks.map((check) => check.privilege),
  ]);
  const byIndex = new Map<number, unknown>();
  for (const row of result.rows) {
    byIndex.set(Number(row.idx), row.allowed);
  }
  return checks.map((check, index) => {
    const value = byIndex.get(index + 1);
    if (typeof value !== "boolean") {
      throw new FeatureFlagAdminPrivilegeError(
        `unreadable:${featureFlagAdminPrivilegeLabel(check)}`,
      );
    }
    return value;
  });
}

export class FeatureFlagAdminPrivilegeError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

function readBoolean(result: QueryResult, label: string): boolean {
  const value = result.rows[0]?.allowed;
  if (typeof value !== "boolean") {
    throw new FeatureFlagAdminPrivilegeError(`unreadable:${label}`);
  }
  return value;
}

export async function verifyFeatureFlagAdminPrivileges(
  query: FeatureFlagAdminPrivilegeQuery,
  options: { requireAuthenticatedUser?: boolean } = {},
): Promise<void> {
  if (options.requireAuthenticatedUser) {
    const identity = await query(
      "SELECT system_user AS system_user, session_user AS session_user, current_user AS current_user, "
      + "(SELECT usename FROM pg_catalog.pg_stat_activity WHERE pid = pg_backend_pid()) AS backend_user",
    );
    if (identity.rows[0]?.session_user !== FEATURE_FLAG_ADMIN_OPERATOR_ROLE) {
      throw new FeatureFlagAdminPrivilegeError("session_user_mismatch");
    }
    if (identity.rows[0]?.current_user !== FEATURE_FLAG_ADMIN_OPERATOR_ROLE) {
      throw new FeatureFlagAdminPrivilegeError("current_user_mismatch");
    }
    // `pg_stat_activity.usename` is the role authenticated for this backend,
    // unlike session_user/current_user which a privileged login can rewrite
    // with SET SESSION AUTHORIZATION. All users can inspect their own row.
    if (identity.rows[0]?.backend_user !== FEATURE_FLAG_ADMIN_OPERATOR_ROLE) {
      throw new FeatureFlagAdminPrivilegeError("authenticated_principal_mismatch");
    }
    // Neon/Hyperdrive may legitimately expose SQL NULL/empty `system_user`
    // even when the authenticated and effective roles are both the operator.
    // The backend_user check above is the non-rewritable authenticated
    // principal proof; system_user is only an additional proxy hint.
    const systemUser = identity.rows[0]?.system_user;
    if (systemUser === undefined) {
      throw new FeatureFlagAdminPrivilegeError("system_user_unreadable");
    }
    if (systemUser !== null && systemUser !== "") {
      const identitySeparator = typeof systemUser === "string" ? systemUser.indexOf(":") : -1;
      if (
        typeof systemUser !== "string"
        || identitySeparator <= 0
        || systemUser.slice(identitySeparator + 1) !== FEATURE_FLAG_ADMIN_OPERATOR_ROLE
      ) {
        throw new FeatureFlagAdminPrivilegeError("system_user_mismatch");
      }
    }
  }

  const role = await query(
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS allowed",
    [FEATURE_FLAG_ADMIN_OPERATOR_ROLE],
  );
  if (!readBoolean(role, "role")) {
    throw new FeatureFlagAdminPrivilegeError("role_missing");
  }

  const required: readonly FeatureFlagAdminPrivilegeCheck[] = REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES;
  const forbidden: readonly FeatureFlagAdminPrivilegeCheck[] = FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES;
  const allowed = await readFeatureFlagAdminPrivilegeMatrix(query, [...required, ...forbidden]);
  required.forEach((expected, index) => {
    if (!allowed[index]) {
      throw new FeatureFlagAdminPrivilegeError(
        `missing:${featureFlagAdminPrivilegeLabel(expected)}`,
      );
    }
  });
  forbidden.forEach((check, index) => {
    if (allowed[required.length + index]) {
      throw new FeatureFlagAdminPrivilegeError(
        `unexpected:${featureFlagAdminPrivilegeLabel(check)}`,
      );
    }
  });

  const effectiveColumnPrivileges = await query(
    `SELECT
       format('%I.%I', namespace.nspname, relation.relname) AS object_name,
       attribute.attname AS column_name,
       requested.privilege_name AS privilege_name
     FROM pg_catalog.pg_attribute AS attribute
     INNER JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
     INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     CROSS JOIN unnest($3::text[]) AS requested(privilege_name)
     WHERE namespace.nspname = 'public'
       AND relation.relname = ANY($2::text[])
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND has_column_privilege($1, relation.oid, attribute.attnum, requested.privilege_name)
     ORDER BY object_name ASC, column_name ASC, privilege_name ASC`,
    [
      FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
      FEATURE_FLAG_ADMIN_COLUMN_PRIVILEGE_OBJECTS.map((object) => object.slice("public.".length)),
      FEATURE_FLAG_ADMIN_COLUMN_PRIVILEGES,
    ],
  );
  for (const row of effectiveColumnPrivileges.rows) {
    const object = String(row.object_name);
    const columnName = String(row.column_name);
    const privilege = String(row.privilege_name);
    if (!isExpectedEffectiveColumnPrivilege(object, columnName, privilege)) {
      throw new FeatureFlagAdminPrivilegeError(
        `unexpected:${object}:${columnName}:${privilege}`,
      );
    }
  }

}
