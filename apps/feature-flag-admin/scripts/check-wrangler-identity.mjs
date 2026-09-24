// Production identity guard for the Feature Flag Admin Worker deploy path.
//
// The auto-deploy pipeline (deploy-feature-flag-admin.yml) deploys the
// TOP-LEVEL wrangler.toml configuration. Staging environments must live in
// [env.*] tables and must never change the top-level production identity.
// This check fails the deploy before wrangler runs if any of the four
// identity-bearing values drifts from the reviewed production expectation:
//
//   1. vars.RAFT_API_ORIGIN
//   2. vars.FEATURE_FLAG_ALLOWED_SERVER_IDS
//   3. hyperdrive binding FEATURE_FLAG_PG id
//   4. d1 binding FEATURE_FLAG_AUDIT_DB database_id
//
// A drift is not auto-corrected: changing production identity requires
// changing EXPECTED below in the same reviewed commit.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const EXPECTED = {
  name: "slock-feature-flag-admin",
  raftApiOrigin: "https://api.raft.build",
  allowedServerIds: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
  hyperdriveBinding: "FEATURE_FLAG_PG",
  hyperdriveId: "4d73351671b9464a8cbc37e978002169",
  d1Binding: "FEATURE_FLAG_AUDIT_DB",
  d1DatabaseId: "db117923-c16f-4893-b49e-d3bfbb56fac9",
};

// Minimal TOML reader for the subset this config uses. Only top-level tables
// are inspected; any [env.*] table ends the top-level scope, which is exactly
// the boundary this guard defends.
export function parseTopLevel(tomlText) {
  const result = { root: {}, vars: {}, hyperdrive: [], d1_databases: [] };
  let scope = { kind: "root" };
  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const arrayHeader = line.match(/^\[\[([^\]]+)\]\]$/);
    const tableHeader = line.match(/^\[([^\]]+)\]$/);
    if (arrayHeader || tableHeader) {
      const name = (arrayHeader ?? tableHeader)[1].trim();
      if (name.startsWith("env.")) {
        scope = { kind: "env" };
        continue;
      }
      if (arrayHeader && (name === "hyperdrive" || name === "d1_databases")) {
        const entry = {};
        result[name].push(entry);
        scope = { kind: "arrayEntry", entry };
      } else if (tableHeader && name === "vars") {
        scope = { kind: "vars" };
      } else {
        scope = { kind: "otherTable" };
      }
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv || scope.kind === "env" || scope.kind === "otherTable") continue;
    const key = kv[1];
    let value = kv[2].trim();
    const quoted = value.match(/^"((?:[^"\\]|\\.)*)"$/);
    if (quoted) value = quoted[1];
    if (scope.kind === "root") result.root[key] = value;
    else if (scope.kind === "vars") result.vars[key] = value;
    else if (scope.kind === "arrayEntry") scope.entry[key] = value;
  }
  return result;
}

export function checkIdentity(tomlText, expected = EXPECTED) {
  const parsed = parseTopLevel(tomlText);
  const failures = [];
  const assertEq = (label, actual, want) => {
    if (actual !== want) {
      failures.push(`${label}: expected ${JSON.stringify(want)}, found ${JSON.stringify(actual ?? null)}`);
    }
  };
  assertEq("top-level name", parsed.root.name, expected.name);
  assertEq("vars.RAFT_API_ORIGIN", parsed.vars.RAFT_API_ORIGIN, expected.raftApiOrigin);
  assertEq(
    "vars.FEATURE_FLAG_ALLOWED_SERVER_IDS",
    parsed.vars.FEATURE_FLAG_ALLOWED_SERVER_IDS,
    expected.allowedServerIds,
  );
  const hyperdriveEntries = parsed.hyperdrive.filter((entry) => entry.binding === expected.hyperdriveBinding);
  if (hyperdriveEntries.length !== 1) {
    failures.push(
      `hyperdrive binding ${expected.hyperdriveBinding}: expected exactly 1 top-level entry, found ${hyperdriveEntries.length}`,
    );
  } else {
    assertEq(`hyperdrive ${expected.hyperdriveBinding} id`, hyperdriveEntries[0].id, expected.hyperdriveId);
  }
  const d1Entries = parsed.d1_databases.filter((entry) => entry.binding === expected.d1Binding);
  if (d1Entries.length !== 1) {
    failures.push(
      `d1 binding ${expected.d1Binding}: expected exactly 1 top-level entry, found ${d1Entries.length}`,
    );
  } else {
    assertEq(`d1 ${expected.d1Binding} database_id`, d1Entries[0].database_id, expected.d1DatabaseId);
  }
  return failures;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const configPath = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "wrangler.toml");
  const failures = checkIdentity(readFileSync(configPath, "utf8"));
  if (failures.length > 0) {
    console.error("[check-wrangler-identity] production identity drift detected:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("[check-wrangler-identity] top-level production identity verified (4/4)");
}
