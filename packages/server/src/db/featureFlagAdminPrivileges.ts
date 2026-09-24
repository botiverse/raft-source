import {
  FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
  FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES as SHARED_FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES,
  REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES as SHARED_REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES,
  FeatureFlagAdminPrivilegeError,
  verifyFeatureFlagAdminPrivileges as verifySharedFeatureFlagAdminPrivileges,
  type FeatureFlagAdminPrivilegeQuery,
} from "@botiverse/raft-shared";

export {
  FEATURE_FLAG_ADMIN_COLUMN_PROJECTIONS,
  FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
  FeatureFlagAdminPrivilegeError,
  type FeatureFlagAdminPrivilegeQuery,
} from "@botiverse/raft-shared";

const DELETE_ROUTE_REQUIRED_PRIVILEGES = [
  { kind: "table", object: "public.feature_flags", privilege: "SELECT" },
  { kind: "table", object: "public.feature_flags", privilege: "INSERT" },
  { kind: "table", object: "public.feature_flags", privilege: "UPDATE" },
  { kind: "table", object: "public.feature_flags", privilege: "DELETE" },
  { kind: "table", object: "public.feature_flag_rules", privilege: "SELECT" },
  { kind: "table", object: "public.feature_flag_rules", privilege: "INSERT" },
  { kind: "table", object: "public.feature_flag_rules", privilege: "UPDATE" },
  { kind: "table", object: "public.feature_flag_rules", privilege: "DELETE" },
] as const;

const DELETE_ROUTE_FORBIDDEN_PRIVILEGES = [
  ...["feature_flags", "feature_flag_rules"].flatMap((table) => [
    { kind: "table" as const, object: `public.${table}`, privilege: "SELECT WITH GRANT OPTION" },
    { kind: "table" as const, object: `public.${table}`, privilege: "INSERT WITH GRANT OPTION" },
    { kind: "table" as const, object: `public.${table}`, privilege: "UPDATE WITH GRANT OPTION" },
    { kind: "table" as const, object: `public.${table}`, privilege: "DELETE WITH GRANT OPTION" },
    { kind: "table" as const, object: `public.${table}`, privilege: "TRUNCATE" },
    { kind: "table" as const, object: `public.${table}`, privilege: "REFERENCES" },
    { kind: "table" as const, object: `public.${table}`, privilege: "TRIGGER" },
  ]),
] as const;

export const REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES = [
  ...SHARED_REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES,
  ...DELETE_ROUTE_REQUIRED_PRIVILEGES,
] as const;

export const FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES = [
  ...SHARED_FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES,
  ...DELETE_ROUTE_FORBIDDEN_PRIVILEGES,
] as const;

export async function verifyFeatureFlagAdminPrivileges(
  query: FeatureFlagAdminPrivilegeQuery,
  options: { requireAuthenticatedUser?: boolean } = {},
): Promise<void> {
  await verifySharedFeatureFlagAdminPrivileges(query, options);
  for (const expected of DELETE_ROUTE_REQUIRED_PRIVILEGES) {
    const result = await query(
      "SELECT has_table_privilege($1, $2, $3) AS allowed",
      [FEATURE_FLAG_ADMIN_OPERATOR_ROLE, expected.object, expected.privilege],
    );
    if (result.rows[0]?.allowed !== true) {
      throw new FeatureFlagAdminPrivilegeError(`missing:${expected.object}:${expected.privilege}`);
    }
  }
  for (const forbidden of DELETE_ROUTE_FORBIDDEN_PRIVILEGES) {
    const result = await query(
      "SELECT has_table_privilege($1, $2, $3) AS allowed",
      [FEATURE_FLAG_ADMIN_OPERATOR_ROLE, forbidden.object, forbidden.privilege],
    );
    if (result.rows[0]?.allowed !== false) {
      throw new FeatureFlagAdminPrivilegeError(`unexpected:${forbidden.object}:${forbidden.privilege}`);
    }
  }
}

export const FEATURE_FLAG_ADMIN_PRIVILEGE_CONTRACT_KEY = "operator-surfaces-v2";
export const FEATURE_FLAG_ADMIN_PRIVILEGE_MIGRATION_TAG =
  "0260_feature_flag_admin_delete_privileges";

export async function verifyFeatureFlagAdminPrivilegeReceipt(
  query: FeatureFlagAdminPrivilegeQuery,
): Promise<void> {
  const result = await query(
    `SELECT migration_tag, applied_by, current_user AS current_user
     FROM public.feature_flag_admin_privilege_receipts
     WHERE contract_key = $1`,
    [FEATURE_FLAG_ADMIN_PRIVILEGE_CONTRACT_KEY],
  );
  const row = result.rows[0];
  if (row?.migration_tag !== FEATURE_FLAG_ADMIN_PRIVILEGE_MIGRATION_TAG) {
    throw new Error("privilege_receipt_missing");
  }
  if (typeof row.current_user !== "string" || row.applied_by !== row.current_user) {
    throw new Error("privilege_receipt_principal_mismatch");
  }
}

export async function reconcileAndVerifyFeatureFlagAdminPrivileges(
  query: FeatureFlagAdminPrivilegeQuery,
): Promise<void> {
  await query("SELECT public.reconcile_feature_flag_admin_privileges()");
  await verifyFeatureFlagAdminPrivilegeReceipt(query);
  await verifyFeatureFlagAdminPrivileges(query);
}
