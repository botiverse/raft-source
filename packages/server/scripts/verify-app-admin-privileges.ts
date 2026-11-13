import "dotenv/config";
import pg from "pg";
import {
  APP_ADMIN_EXECUTABLE_FUNCTIONS,
  APP_ADMIN_OPERATOR_ROLE,
  reconcileAndVerifyAppAdminPrivileges,
} from "../src/db/appAdminPrivileges";
import { withTransientConnectRetry } from "../src/db/transientConnectRetry";

// Runs in db:migrate:deploy after the migrations. Until a person creates
// app_admin_operator there is nothing to grant and this only says so; once it
// exists every deploy reconciles its grants and fails on any privilege beyond
// them (src/db/appAdminPrivileges.ts).
//
// The staging and production deploys set FEATURE_FLAG_ADMIN_PRIVILEGE_GUARD_REQUIRED=1
// (scripts/deploy/aws-run-server-migrations.sh requires it to be set), and
// there the reconciler must exist. Anywhere else, a database without it, such
// as a migration test's throwaway journal, is skipped rather than failed.
const reconcilerRequired = process.env.FEATURE_FLAG_ADMIN_PRIVILEGE_GUARD_REQUIRED === "1";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("database_url_missing");

  // Reconcile-and-verify is idempotent, so a transient connect refusal is
  // retried with a fresh pool.
  const outcome = await withTransientConnectRetry(async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      return await reconcileAndVerifyAppAdminPrivileges((text, values) => pool.query(text, values), { requireReconciler: reconcilerRequired });
    } finally {
      await pool.end().catch(() => undefined);
    }
  }, {
    onRetry: (attempt, error) => {
      const reason = error instanceof Error ? error.message : "unknown";
      console.warn(`[APP_ADMIN_PRIVILEGES_RETRY] attempt=${attempt} reason=${reason}`);
    },
  });
  if (outcome === "reconciler_missing") {
    console.log(`[APP_ADMIN_PRIVILEGES_SKIPPED] role=${APP_ADMIN_OPERATOR_ROLE} reason=reconciler_missing`);
    return;
  }
  if (outcome === "role_missing") {
    console.log(`[APP_ADMIN_PRIVILEGES_SKIPPED] role=${APP_ADMIN_OPERATOR_ROLE} reason=role_missing`);
    return;
  }
  console.log(`[APP_ADMIN_PRIVILEGES_OK] role=${APP_ADMIN_OPERATOR_ROLE} functions=${APP_ADMIN_EXECUTABLE_FUNCTIONS.length}`);
}

void main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : "unknown";
  console.error(`[APP_ADMIN_PRIVILEGES_FAILED] reason=${reason}`);
  process.exitCode = 1;
});
