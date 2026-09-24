export const FEATURE_FLAG_ADMIN_OPERATOR_ROLE = "feature_flag_admin_operator";

export const REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES = [
  { kind: "schema", object: "public", privilege: "USAGE" },
  { kind: "table", object: "public.announcements", privilege: "SELECT" },
  { kind: "table", object: "public.announcements", privilege: "INSERT" },
  { kind: "table", object: "public.announcements", privilege: "UPDATE" },
  { kind: "table", object: "public.announcement_audit_events", privilege: "SELECT" },
  { kind: "table", object: "public.announcement_audit_events", privilege: "INSERT" },
  { kind: "table", object: "public.feature_flag_audiences", privilege: "SELECT" },
  { kind: "table", object: "public.feature_flag_audiences", privilege: "INSERT" },
  { kind: "table", object: "public.feature_flag_audiences", privilege: "UPDATE" },
  { kind: "table", object: "public.feature_flag_audience_members", privilege: "SELECT" },
  { kind: "table", object: "public.feature_flag_audience_members", privilege: "INSERT" },
  { kind: "table", object: "public.feature_flag_audience_members", privilege: "DELETE" },
  { kind: "column", object: "public.users", column: "id", privilege: "SELECT" },
  { kind: "column", object: "public.servers", column: "id", privilege: "SELECT" },
  { kind: "column", object: "public.servers", column: "slug", privilege: "SELECT" },
  { kind: "column", object: "public.servers", column: "deleted_at", privilege: "SELECT" },
] as const;

export const FEATURE_FLAG_ADMIN_COLUMN_PROJECTIONS = [
  { object: "public.users", columns: ["id"] },
  { object: "public.servers", columns: ["deleted_at", "id", "slug"] },
] as const;

const FEATURE_FLAG_ADMIN_COLUMN_PRIVILEGE_OBJECTS = [
  "public.announcements",
  "public.announcement_audit_events",
  "public.feature_flag_audiences",
  "public.feature_flag_audience_members",
  "public.users",
  "public.servers",
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
  if (object === "public.feature_flag_audiences") {
    return privilege === "SELECT" || privilege === "INSERT" || privilege === "UPDATE";
  }
  if (object === "public.feature_flag_audience_members") {
    return privilege === "SELECT" || privilege === "INSERT";
  }
  return FEATURE_FLAG_ADMIN_COLUMN_PROJECTIONS.some(
    (entry) => entry.object === object
      && privilege === "SELECT"
      && (entry.columns as readonly string[]).includes(columnName),
  );
}

export const FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES = [
  { kind: "schema", object: "public", privilege: "CREATE" },
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
  { kind: "table", object: "public.users", privilege: "SELECT" },
  { kind: "table", object: "public.users", privilege: "INSERT" },
  { kind: "table", object: "public.users", privilege: "UPDATE" },
  { kind: "table", object: "public.users", privilege: "DELETE" },
  { kind: "table", object: "public.users", privilege: "TRUNCATE" },
  { kind: "table", object: "public.users", privilege: "REFERENCES" },
  { kind: "table", object: "public.users", privilege: "TRIGGER" },
  { kind: "table", object: "public.servers", privilege: "SELECT" },
  { kind: "table", object: "public.servers", privilege: "INSERT" },
  { kind: "table", object: "public.servers", privilege: "UPDATE" },
  { kind: "table", object: "public.servers", privilege: "DELETE" },
  { kind: "table", object: "public.servers", privilege: "TRUNCATE" },
  { kind: "table", object: "public.servers", privilege: "REFERENCES" },
  { kind: "table", object: "public.servers", privilege: "TRIGGER" },
  { kind: "column", object: "public.users", column: "id", privilege: "SELECT WITH GRANT OPTION" },
  { kind: "column", object: "public.servers", column: "id", privilege: "SELECT WITH GRANT OPTION" },
  { kind: "column", object: "public.servers", column: "slug", privilege: "SELECT WITH GRANT OPTION" },
  { kind: "column", object: "public.servers", column: "deleted_at", privilege: "SELECT WITH GRANT OPTION" },
] as const;

type QueryResult = { rows: Array<Record<string, unknown>> };
export type FeatureFlagAdminPrivilegeQuery = (
  text: string,
  values?: unknown[],
) => Promise<QueryResult>;

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

  for (const expected of REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES) {
    const oracle = expected.kind === "schema"
      ? "SELECT has_schema_privilege($1, $2, $3) AS allowed"
      : expected.kind === "table"
        ? "SELECT has_table_privilege($1, $2, $3) AS allowed"
        : "SELECT has_column_privilege($1, $2, $3, $4) AS allowed";
    const label = expected.kind === "column"
      ? `${expected.object}:${expected.column}:${expected.privilege}`
      : `${expected.object}:${expected.privilege}`;
    const result = await query(
      oracle,
      expected.kind === "column"
        ? [FEATURE_FLAG_ADMIN_OPERATOR_ROLE, expected.object, expected.column, expected.privilege]
        : [FEATURE_FLAG_ADMIN_OPERATOR_ROLE, expected.object, expected.privilege],
    );
    if (!readBoolean(result, label)) {
      throw new FeatureFlagAdminPrivilegeError(
        `missing:${label}`,
      );
    }
  }

  for (const forbidden of FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES) {
    const oracle = forbidden.kind === "schema"
      ? "SELECT has_schema_privilege($1, $2, $3) AS allowed"
      : forbidden.kind === "table"
        ? "SELECT has_table_privilege($1, $2, $3) AS allowed"
        : "SELECT has_column_privilege($1, $2, $3, $4) AS allowed";
    const label = forbidden.kind === "column"
      ? `${forbidden.object}:${forbidden.column}:${forbidden.privilege}`
      : `${forbidden.object}:${forbidden.privilege}`;
    const result = await query(
      oracle,
      forbidden.kind === "column"
        ? [FEATURE_FLAG_ADMIN_OPERATOR_ROLE, forbidden.object, forbidden.column, forbidden.privilege]
        : [FEATURE_FLAG_ADMIN_OPERATOR_ROLE, forbidden.object, forbidden.privilege],
    );
    if (readBoolean(result, label)) {
      throw new FeatureFlagAdminPrivilegeError(
        `unexpected:${label}`,
      );
    }
  }

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
