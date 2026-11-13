import assert from "node:assert/strict";

import {
  FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
  FEATURE_FLAG_ADMIN_PRIVILEGE_CONTRACT_KEY,
  FEATURE_FLAG_ADMIN_PRIVILEGE_MIGRATION_TAG,
  FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES,
  REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES,
  reconcileAndVerifyFeatureFlagAdminPrivileges,
  verifyFeatureFlagAdminPrivileges,
  verifyFeatureFlagAdminPrivilegeReceipt,
} from "./featureFlagAdminPrivileges";
import { verifyFeatureFlagAdminPrivileges as verifySharedFeatureFlagAdminPrivileges } from "@botiverse/raft-shared";

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
        "announcement_image_assets",
        "feature_flag_audiences",
        "feature_flag_audience_members",
        "users",
        "servers",
        "server_members",
        "subscriptions",
        "server_lab_enrollments",
        "server_lab_access",
        "lab_definitions",
        "agents",
        "official_app_registry",
        "oauth_clients",
        "integration_audit_events",
        "link_card_operations",
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
    const answer = (key: string) => {
      const required = key === "public:USAGE"
        || REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES.some(
          (entry) => entry.kind === "column"
            ? `${entry.object}:${entry.column}:${entry.privilege}` === key
            : `${entry.object}:${entry.privilege}` === key,
        );
      return key === options.unexpected ? true : key === options.missing ? false : required;
    };
    if (text.includes("WITH ORDINALITY")) {
      // Batched matrix oracle: $1 role, $2 kinds, $3 objects, $4 columns, $5 privileges.
      assert.equal(values[0], FEATURE_FLAG_ADMIN_OPERATOR_ROLE);
      assert.match(text, /has_schema_privilege\(\$1, checks\.object, checks\.privilege\)/);
      assert.match(text, /has_table_privilege\(\$1, checks\.object, checks\.privilege\)/);
      assert.match(text, /has_function_privilege\(\$1, checks\.object, checks\.privilege\)/);
      assert.match(text, /has_column_privilege\(\$1, checks\.object, checks\.column_name, checks\.privilege\)/);
      const kinds = values[1] as string[];
      const objects = values[2] as string[];
      const columns = values[3] as string[];
      const privileges = values[4] as string[];
      assert.equal(objects.length, kinds.length);
      assert.equal(columns.length, kinds.length);
      assert.equal(privileges.length, kinds.length);
      return {
        rows: kinds.map((kind, index) => ({
          idx: index + 1,
          allowed: answer(
            kind === "column"
              ? `${objects[index]}:${columns[index]}:${privileges[index]}`
              : `${objects[index]}:${privileges[index]}`,
          ),
        })),
      };
    }
    const key = text.includes("has_column_privilege")
      ? `${String(values[1])}:${String(values[2])}:${String(values[3])}`
      : `${String(values[1])}:${String(values[2])}`;
    return { rows: [{ allowed: answer(key) }] };
  };
}

// Function signatures carry ( ) [ ], which RegExp would read as syntax.
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("privilege verifier accepts only the complete operator route matrix", async () => {
  await verifyFeatureFlagAdminPrivileges(oracle());
});

test("announcement image routes receive exactly their four table operations", () => {
  const object = "public.announcement_image_assets";
  assert.deepEqual(
    REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES.filter((entry) => entry.object === object),
    ["SELECT", "INSERT", "UPDATE", "DELETE"].map((privilege) => ({
      kind: "table",
      object,
      privilege,
    })),
  );
  assert.deepEqual(
    FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES
      .filter((entry) => entry.object === object)
      .map((entry) => entry.privilege),
    [
      "SELECT WITH GRANT OPTION",
      "INSERT WITH GRANT OPTION",
      "UPDATE WITH GRANT OPTION",
      "DELETE WITH GRANT OPTION",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
    ],
  );
});

// Regression tooth for the batched matrix: the readiness probe's latency is
// the number of sequential round trips (~100 ms each through Hyperdrive).
// Before batching this path issued 118 queries (139 through the server
// wrapper); a per-check loop creeping back in would keep every answer test
// green while quietly restoring the 11-12 s probe.
test("privilege verifier issues at most four round trips per path", async () => {
  const worker = { queries: 0 };
  const workerOracle = oracle();
  await verifySharedFeatureFlagAdminPrivileges(async (text, values) => {
    worker.queries += 1;
    return workerOracle(text, values);
  }, { requireAuthenticatedUser: true });
  assert.equal(worker.queries, 4, "identity + role + privilege matrix + column census");

  const server = { queries: 0 };
  const serverOracle = oracle();
  await verifyFeatureFlagAdminPrivileges(async (text, values) => {
    server.queries += 1;
    return serverOracle(text, values);
  });
  assert.equal(server.queries, 4, "role + shared matrix + column census + delete-route matrix");
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
      new RegExp(`missing:${escapeRegExp(key)}`),
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
      new RegExp(`unexpected:${escapeRegExp(key)}`),
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
