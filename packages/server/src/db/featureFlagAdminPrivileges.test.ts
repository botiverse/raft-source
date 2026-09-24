import assert from "node:assert/strict";
import { test } from "vitest";

import {
  FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
  FEATURE_FLAG_ADMIN_PRIVILEGE_CONTRACT_KEY,
  FEATURE_FLAG_ADMIN_PRIVILEGE_MIGRATION_TAG,
  FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES,
  REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES,
  reconcileAndVerifyFeatureFlagAdminPrivileges,
  verifyFeatureFlagAdminPrivileges,
  verifyFeatureFlagAdminPrivilegeReceipt,
} from "./featureFlagAdminPrivileges.js";

function oracle(options: {
  role?: boolean;
  systemUser?: string | null;
  omitSystemUser?: boolean;
  backendUser?: string;
  sessionUser?: string;
  currentUser?: string;
  missing?: string;
  unexpected?: string;
  unexpectedColumn?: string;
  unexpectedColumnPrivilege?: {
    object: string;
    column: string;
    privilege: string;
  };
  receipt?: boolean;
} = {}) {
  return async (text: string, values: unknown[] = []) => {
    if (text.includes("session_user AS session_user")) {
      const identity: Record<string, unknown> = {
        ...(options.omitSystemUser ? {} : {
          system_user: options.systemUser === undefined
            ? `scram-sha-256:${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`
            : options.systemUser,
        }),
        session_user: options.sessionUser ?? FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
        current_user: options.currentUser ?? FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
        backend_user: options.backendUser ?? FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
      };
      return { rows: [identity] };
    }
    if (text.includes("privilege_receipts")) {
      assert.equal(values[0], FEATURE_FLAG_ADMIN_PRIVILEGE_CONTRACT_KEY);
      return {
        rows: options.receipt === false ? [] : [{
          migration_tag: FEATURE_FLAG_ADMIN_PRIVILEGE_MIGRATION_TAG,
          applied_by: "migration_principal",
          current_user: "migration_principal",
        }],
      };
    }
    if (text.includes("reconcile_feature_flag_admin_privileges")) {
      return { rows: [{}] };
    }
    if (text.includes("pg_catalog.pg_roles")) {
      assert.equal(values[0], FEATURE_FLAG_ADMIN_OPERATOR_ROLE);
      return { rows: [{ allowed: options.role ?? true }] };
    }
    if (text.includes("pg_catalog.pg_attribute")) {
      assert.match(text, /AS column_name/);
      assert.match(text, /AS privilege_name/);
      assert.doesNotMatch(text, /AS column(?:\s|$)/);
      assert.deepEqual(values[1], [
        "announcements",
        "announcement_audit_events",
        "feature_flag_audiences",
        "feature_flag_audience_members",
        "users",
        "servers",
      ]);
      assert.deepEqual(values[2], [
        "SELECT",
        "INSERT",
        "UPDATE",
        "REFERENCES",
        "SELECT WITH GRANT OPTION",
        "INSERT WITH GRANT OPTION",
        "UPDATE WITH GRANT OPTION",
        "REFERENCES WITH GRANT OPTION",
      ]);
      const rows: Array<{
        object_name: string;
        column_name: string;
        privilege_name: string;
      }> = [];
      if (options.unexpectedColumn) {
        const separator = options.unexpectedColumn.lastIndexOf(":");
        rows.push({
          object_name: options.unexpectedColumn.slice(0, separator),
          column_name: options.unexpectedColumn.slice(separator + 1),
          privilege_name: "SELECT",
        });
      }
      if (options.unexpectedColumnPrivilege) {
        rows.push({
          object_name: options.unexpectedColumnPrivilege.object,
          column_name: options.unexpectedColumnPrivilege.column,
          privilege_name: options.unexpectedColumnPrivilege.privilege,
        });
      }
      return { rows };
    }
    const key = text.includes("has_column_privilege")
      ? `${String(values[1])}:${String(values[2])}:${String(values[3])}`
      : `${String(values[1])}:${String(values[2])}`;
    const required = key === "public:USAGE"
      || REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES.some(
        (entry) => entry.kind === "column"
          ? `${entry.object}:${entry.column}:${entry.privilege}` === key
          : `${entry.object}:${entry.privilege}` === key,
      );
    return {
      rows: [{
        allowed: key === options.unexpected ? true : key === options.missing ? false : required,
      }],
    };
  };
}

test("privilege verifier accepts only the complete operator route matrix", async () => {
  await verifyFeatureFlagAdminPrivileges(oracle());
});

test("privilege verifier fails closed when the role is absent", async () => {
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges(oracle({ role: false })),
    /role_missing/,
  );
});

test("Worker-facing privilege verifier rejects a misbound authenticated user", async () => {
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges(
      oracle({ sessionUser: "broad_hyperdrive_login" }),
      { requireAuthenticatedUser: true },
    ),
    /session_user_mismatch/,
  );

  await assert.rejects(
    verifyFeatureFlagAdminPrivileges(
      oracle({ currentUser: "wrong_hyperdrive_login" }),
      { requireAuthenticatedUser: true },
    ),
    /current_user_mismatch/,
  );

  await assert.rejects(
    verifyFeatureFlagAdminPrivileges(
      oracle({ systemUser: "scram-sha-256:broad_hyperdrive_login" }),
      { requireAuthenticatedUser: true },
    ),
    /system_user_mismatch/,
  );

  await assert.rejects(
    verifyFeatureFlagAdminPrivileges(
      oracle({ systemUser: null, backendUser: "broad_hyperdrive_login" }),
      { requireAuthenticatedUser: true },
    ),
    /authenticated_principal_mismatch/,
  );

  await assert.rejects(
    verifyFeatureFlagAdminPrivileges(
      oracle({ omitSystemUser: true }),
      { requireAuthenticatedUser: true },
    ),
    /system_user_unreadable/,
  );

  await assert.rejects(
    verifyFeatureFlagAdminPrivileges(
      oracle({ systemUser: `scram-sha-256:broad:${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}` }),
      { requireAuthenticatedUser: true },
    ),
    /system_user_mismatch/,
  );
});

test("Worker-facing verifier accepts a proxy connection with no system_user", async () => {
  await verifyFeatureFlagAdminPrivileges(
    oracle({ systemUser: null }),
    { requireAuthenticatedUser: true },
  );

  await verifyFeatureFlagAdminPrivileges(
    oracle({ systemUser: "" }),
    { requireAuthenticatedUser: true },
  );
});

for (const entry of REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES) {
  const key = entry.kind === "column"
    ? `${entry.object}:${entry.column}:${entry.privilege}`
    : `${entry.object}:${entry.privilege}`;
  test(`privilege verifier rejects missing ${key}`, async () => {
    await assert.rejects(
      verifyFeatureFlagAdminPrivileges(oracle({ missing: key })),
      new RegExp(`missing:${key}`),
    );
  });
}

test("deploy receipt rejects a journaled migration that never reconciled the role", async () => {
  await assert.rejects(
    verifyFeatureFlagAdminPrivilegeReceipt(oracle({ receipt: false })),
    /privilege_receipt_missing/,
  );
});

test("deploy helper invokes the migration-owned reconciler before receipt and grants readback", async () => {
  const queries: string[] = [];
  const query = oracle();
  await reconcileAndVerifyFeatureFlagAdminPrivileges(async (text, values) => {
    queries.push(text);
    return query(text, values);
  });
  assert.match(queries[0] ?? "", /reconcile_feature_flag_admin_privileges/);
  assert.match(queries[1] ?? "", /feature_flag_admin_privilege_receipts/);
  assert.match(queries[2] ?? "", /pg_catalog\.pg_roles/);
});

for (const entry of FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES) {
  const key = entry.kind === "column"
    ? `${entry.object}:${entry.column}:${entry.privilege}`
    : `${entry.object}:${entry.privilege}`;
  test(`privilege verifier rejects unexpected ${key}`, async () => {
    await assert.rejects(
      verifyFeatureFlagAdminPrivileges(oracle({ unexpected: key })),
      new RegExp(`unexpected:${key}`),
    );
  });
}

test("privilege verifier rejects any user/server column outside the bounded projection", async () => {
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges(oracle({ unexpectedColumn: "public.users:email" })),
    /unexpected:public\.users:email:SELECT/,
  );
});

test("privilege verifier rejects column-level non-SELECT rights", async () => {
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges(oracle({
      unexpectedColumnPrivilege: {
        object: "public.users",
        column: "email",
        privilege: "UPDATE",
      },
    })),
    /unexpected:public\.users:email:UPDATE/,
  );
});

test("privilege verifier rejects column-level grant options on an otherwise allowed table", async () => {
  await assert.rejects(
    verifyFeatureFlagAdminPrivileges(oracle({
      unexpectedColumnPrivilege: {
        object: "public.feature_flag_audiences",
        column: "name",
        privilege: "SELECT WITH GRANT OPTION",
      },
    })),
    /unexpected:public\.feature_flag_audiences:name:SELECT WITH GRANT OPTION/,
  );
});
