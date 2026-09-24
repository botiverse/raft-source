import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const PRODUCTION_SERVER_ID = "95f993fa-2a68-4797-b8ae-7beb7d984ada";
export const PRODUCTION_HYPERDRIVE_ID = "4d73351671b9464a8cbc37e978002169";
export const PRODUCTION_D1_ID = "db117923-c16f-4893-b49e-d3bfbb56fac9";
export const STAGING_WORKER_NAME = "slock-feature-flag-admin-staging";
// Staging Admin controls staging data, but authenticates humans against the
// same online Raft identity plane as production Admin.
export const STAGING_RAFT_ORIGIN = "https://app.raft.build";
export const STAGING_RAFT_API_ORIGIN = "https://api.raft.build";
export const STAGING_CLIENT_ID = "slock-feature-flag-admin-staging";
// Update only through the documented production-config review procedure in DEPLOY.md.
export const PRODUCTION_CONFIG_SHA256 = "2719f661bbe50ce4a499bc16c2b9be48888e39d8e0a5106d2ed5fc9ac41ffec6";

const placeholders = {
  FEATURE_FLAG_ADMIN_STAGING_ALLOWED_SERVER_IDS:
    "__FEATURE_FLAG_ADMIN_STAGING_ALLOWED_SERVER_IDS__",
  FEATURE_FLAG_ADMIN_STAGING_HYPERDRIVE_ID:
    "__FEATURE_FLAG_ADMIN_STAGING_HYPERDRIVE_ID__",
  FEATURE_FLAG_ADMIN_STAGING_AUDIT_DATABASE_ID:
    "__FEATURE_FLAG_ADMIN_STAGING_AUDIT_DATABASE_ID__",
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hexIdPattern = /^[0-9a-f]{32}$/;

function requiredInput(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function replaceExactlyOnce(source, token, value) {
  const pieces = source.split(token);
  if (pieces.length !== 2) throw new Error(`${token} must occur exactly once`);
  return `${pieces[0]}${value}${pieces[1]}`;
}

function requireLiteral(source, literal, label) {
  if (!source.includes(literal)) throw new Error(`${label} contract drift`);
}

function validateTemplate(source) {
  const production = `${source.split("\n\n# Staging is rendered")[0]}\n`;
  const staging = source.slice(source.indexOf("[env.staging]"));
  const productionSha = createHash("sha256").update(production).digest("hex");
  if (productionSha !== PRODUCTION_CONFIG_SHA256) {
    throw new Error("production Wrangler configuration bytes changed");
  }
  requireLiteral(source, 'name = "slock-feature-flag-admin"', "production Worker name");
  requireLiteral(source, 'RAFT_API_ORIGIN = "https://api.raft.build"', "production API origin");
  requireLiteral(source, `FEATURE_FLAG_ALLOWED_SERVER_IDS = "${PRODUCTION_SERVER_ID}"`, "production server id");
  requireLiteral(source, `id = "${PRODUCTION_HYPERDRIVE_ID}"`, "production Hyperdrive id");
  requireLiteral(source, `database_id = "${PRODUCTION_D1_ID}"`, "production D1 id");
  requireLiteral(source, "[env.staging]", "staging environment");
  requireLiteral(staging, `name = "${STAGING_WORKER_NAME}"`, "staging Worker name");
  requireLiteral(staging, "[env.staging.observability]", "staging observability");
  requireLiteral(staging, "[env.staging.observability.logs]", "staging persisted logs");
  requireLiteral(staging, "invocation_logs = true", "staging invocation logs");
  requireLiteral(staging, "persist = true", "staging log persistence");
  requireLiteral(staging, `RAFT_ORIGIN = "${STAGING_RAFT_ORIGIN}"`, "staging Raft origin");
  requireLiteral(staging, `RAFT_API_ORIGIN = "${STAGING_RAFT_API_ORIGIN}"`, "staging API origin");
  requireLiteral(staging, `RAFT_CLIENT_ID = "${STAGING_CLIENT_ID}"`, "staging client id");
  requireLiteral(staging, 'binding = "FEATURE_FLAG_PG"', "staging Hyperdrive binding");
  requireLiteral(staging, 'binding = "FEATURE_FLAG_AUDIT_DB"', "staging D1 binding");
}

export function renderStagingWrangler(source, env) {
  validateTemplate(source);

  const serverIds = requiredInput(env, "FEATURE_FLAG_ADMIN_STAGING_ALLOWED_SERVER_IDS")
    .split(",")
    .map((value) => value.trim());
  if (serverIds.some((value) => !uuidPattern.test(value))) {
    throw new Error("staging allowed server ids must be comma-separated UUIDs");
  }
  if (new Set(serverIds).size !== serverIds.length) {
    throw new Error("staging allowed server ids must be unique");
  }
  if (serverIds.length !== 1 || serverIds[0] !== PRODUCTION_SERVER_ID) {
    throw new Error("staging allowed server ids must equal the online Botiverse server id");
  }

  const hyperdriveId = requiredInput(env, "FEATURE_FLAG_ADMIN_STAGING_HYPERDRIVE_ID");
  if (!hexIdPattern.test(hyperdriveId)) throw new Error("invalid staging Hyperdrive id");
  if (hyperdriveId === PRODUCTION_HYPERDRIVE_ID) {
    throw new Error("staging Hyperdrive id must differ from production");
  }

  const d1Id = requiredInput(env, "FEATURE_FLAG_ADMIN_STAGING_AUDIT_DATABASE_ID");
  if (!uuidPattern.test(d1Id)) throw new Error("invalid staging D1 database id");
  if (d1Id === PRODUCTION_D1_ID) {
    throw new Error("staging D1 database id must differ from production");
  }

  let rendered = source;
  rendered = replaceExactlyOnce(
    rendered,
    placeholders.FEATURE_FLAG_ADMIN_STAGING_ALLOWED_SERVER_IDS,
    serverIds.join(","),
  );
  rendered = replaceExactlyOnce(
    rendered,
    placeholders.FEATURE_FLAG_ADMIN_STAGING_HYPERDRIVE_ID,
    hyperdriveId,
  );
  rendered = replaceExactlyOnce(
    rendered,
    placeholders.FEATURE_FLAG_ADMIN_STAGING_AUDIT_DATABASE_ID,
    d1Id,
  );
  if (rendered.includes("__FEATURE_FLAG_ADMIN_STAGING_")) {
    throw new Error("unrendered staging identity placeholder");
  }
  return rendered;
}

async function main() {
  const [sourcePath, outputPath] = process.argv.slice(2);
  if (!sourcePath || !outputPath) {
    throw new Error("usage: render-staging-wrangler.mjs <source> <output>");
  }
  const source = await readFile(sourcePath, "utf8");
  const rendered = renderStagingWrangler(source, process.env);
  await writeFile(outputPath, rendered, { flag: "wx", mode: 0o600 });
  process.stdout.write(`rendered staging Wrangler config: ${outputPath}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
