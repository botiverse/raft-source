import "dotenv/config";
import pg from "pg";
import {
  FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
  FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES,
  REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES,
  reconcileAndVerifyFeatureFlagAdminPrivileges,
} from "../src/db/featureFlagAdminPrivileges.js";

const rawRequired = process.env.FEATURE_FLAG_ADMIN_PRIVILEGE_GUARD_REQUIRED;

async function main(): Promise<void> {
  if (rawRequired !== undefined && rawRequired !== "0" && rawRequired !== "1") {
    throw new Error("invalid_required_mode");
  }
  if (rawRequired !== "1") {
    console.log("[FEATURE_FLAG_ADMIN_PRIVILEGES_SKIPPED] required=0");
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("database_url_missing");

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await reconcileAndVerifyFeatureFlagAdminPrivileges((text, values) => pool.query(text, values));
    console.log(
      `[FEATURE_FLAG_ADMIN_PRIVILEGES_OK] role=${FEATURE_FLAG_ADMIN_OPERATOR_ROLE} `
        + `required=${REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES.length} `
        + `forbidden=${FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES.length}`,
    );
  } finally {
    await pool.end().catch(() => undefined);
  }
}

void main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : "unknown";
  console.error(`[FEATURE_FLAG_ADMIN_PRIVILEGES_FAILED] reason=${reason}`);
  process.exitCode = 1;
});
