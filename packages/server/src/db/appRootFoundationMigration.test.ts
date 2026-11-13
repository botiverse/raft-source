import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const migration = readFileSync(
  new URL("../../drizzle/0407_generic_app_root_foundation.sql", import.meta.url),
  "utf8",
);

const journal = JSON.parse(
  readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"),
) as { entries: { idx: number; tag: string }[] };

test("0407 creates the three new tables and nothing else structural", () => {
  assert.match(migration, /CREATE TABLE "raft_apps"/);
  assert.match(migration, /CREATE TABLE "app_oauth_profiles"/);
  assert.match(migration, /CREATE TABLE "app_mcp_profiles"/);
});

// The acceptance criterion for Phase 1A is zero behavioural drift. That is only
// credible if the migration cannot touch an existing row at all -- so assert the
// ABSENCE of the dangerous forms, not just the presence of the intended ones. A
// migration that merely "looks additive" is not the same as one that cannot mutate.
const NEW_TABLES = ["app_mcp_profiles", "app_oauth_profiles", "raft_apps"];
const LEGACY_SOURCES = ["managed_mcp_servers", "oauth_clients"];

test("0407 writes only the three new tables, in DDL and in trigger bodies alike", () => {
  // This started life as a blanket "0407 contains no UPDATE and no DELETE". That form
  // died honestly: the lifecycle triggers DO delete and DO upsert. Relaxing the
  // assertion to match would have thrown away the guarantee, so it is restated as the
  // thing actually worth protecting -- every write target, wherever it appears in the
  // file, must be one of the three NEW tables. That is strictly stronger than the old
  // blanket check, which said nothing about WHICH table an insert targeted.
  // The target must be a real relation reference -- `public.x` or `"x"` -- so that the
  // `DO UPDATE SET` of an upsert is not mistaken for an UPDATE against a table named SET.
  const writeTargets = [...migration.matchAll(
    /\b(?:INSERT INTO|DELETE FROM|UPDATE|ALTER TABLE)\s+(?:public\.([a-z_]+)|"([a-z_]+)")/gi,
  )].map((match) => match[1] ?? match[2]);
  assert.ok(writeTargets.length > 0, "the scan must actually find write statements");
  assert.deepEqual(
    [...new Set(writeTargets)].sort(),
    NEW_TABLES,
    "0407 must not write any pre-existing table -- not from DDL, and not from a trigger body",
  );
  assert.doesNotMatch(migration, /\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b/i, "0407 must not DROP anything");
});

test("0407 touches the legacy tables only by attaching lifecycle triggers to them", () => {
  // The triggers are the one place 0407 reaches a pre-existing table at all, so name that
  // reach exactly rather than letting it hide inside "additive".
  const triggerTargets = [...migration.matchAll(/CREATE TRIGGER\s+\w+\s+(?:BEFORE|AFTER)[\s\S]*?\sON\s+public\.([a-z_]+)/g)]
    .map((match) => match[1]);
  assert.deepEqual(
    [...new Set(triggerTargets)].sort(),
    [...LEGACY_SOURCES, "raft_apps"].sort(),
    "triggers may attach only to the two legacy sources and to the root itself",
  );
  // A trigger that could rewrite its own source row would not be dark. Each source-side
  // function must read NEW/OLD and write only the root side.
  for (const legacy of LEGACY_SOURCES) {
    assert.doesNotMatch(
      migration,
      new RegExp(`(?:INSERT INTO|UPDATE|DELETE FROM)\\s+(?:public\\.)?"?${legacy}"?`, "i"),
      `0407 must never write ${legacy}; the legacy row stays authoritative and untouched`,
    );
  }
});

// Every function here is reachable from an ordinary legacy write, so an unqualified name
// inside one resolves through the CALLER's search_path. Measured before this was fixed:
// with `search_path = shadow, public` and a same-named `shadow.raft_apps`, a legal insert
// into `public.oauth_clients` succeeded and the root/profile landed in the shadow tables
// while `public.raft_apps` stayed empty -- no error. The executing proof lives in
// `appRootFoundation.pglite.test.ts`; this is the structural guard that a FIFTH function
// added later cannot quietly skip. Convention matches 0240 / 0247 / 0260 / 0267.
test("0407 pins schema and search_path on every function it defines", () => {
  const definitions = [...migration.matchAll(/CREATE (?:OR REPLACE )?FUNCTION\s+(\S+?)\s*\(([\s\S]*?)\bAS \$\$/g)];
  assert.equal(definitions.length, 4, "expected exactly the four functions 0407 owns");

  for (const [, name, header] of definitions) {
    assert.match(name, /^public\./, `${name} must be created in an explicit schema`);
    assert.match(
      header,
      /SET search_path = pg_catalog, pg_temp/,
      `${name} must pin search_path; otherwise its body resolves through the caller's path`,
    );
    assert.doesNotMatch(
      header,
      /SECURITY DEFINER/i,
      `${name} must keep invoker rights -- nothing here needs to escalate`,
    );
  }

  // Inside the bodies, every reference to our own objects carries its schema.
  const bodies = migration.slice(migration.indexOf("CREATE FUNCTION public.raft_app_root_id"));
  for (const relation of [...NEW_TABLES, ...LEGACY_SOURCES]) {
    const unqualified = new RegExp(`(?<!public\\.)\\b${relation}\\b(?!["']?\\s*(?:\\.|_))`, "g");
    for (const match of bodies.matchAll(unqualified)) {
      const line = bodies.slice(0, match.index).split("\n").length;
      const text = bodies.split("\n")[line - 1];
      assert.ok(
        text.trimStart().startsWith("--"),
        `${relation} appears unqualified outside a comment: ${text.trim()}`,
      );
    }
  }
  assert.match(migration, /public\.raft_app_root_id\('oauth_service'/, "helper calls must be qualified too");
  assert.match(migration, /public\.raft_app_root_id\('mcp'/, "helper calls must be qualified too");
  assert.match(migration, /pg_catalog\.md5\(/, "built-ins must not rely on the caller's path either");
});

// The five outbound_* columns are App Notifications state. They stay on oauth_clients:
// "the MCP adapter does not declare notifications" is a fact about today's adapter, not
// a claim that notifications belong to OAuth execution permanently. Moving them would
// also have touched 9 files / 68 call sites in a zero-drift PR.
test("0407 does not relocate App Notifications or any credential authority", () => {
  for (const column of [
    "outbound_request_revision",
    "outbound_current_revision_id",
    "outbound_pending_revision_id",
    "outbound_current_groups",
    "outbound_current_events",
    "client_secret_hash",
    "client_secret",
    "return_url",
    "allowed_scopes",
  ]) {
    assert.doesNotMatch(
      migration,
      new RegExp(column),
      `0407 must not move or copy ${column}; the legacy table stays authoritative`,
    );
  }
});

// No mutable identity on the root => root/source divergence is unrepresentable rather
// than merely discouraged, and symmetrically for both adapters.
test("0407 copies no mutable identity column onto the App root", () => {
  for (const column of ["name", "description", "logo_url", "category", "enabled", "icon"]) {
    assert.doesNotMatch(
      migration,
      new RegExp(`"${column}"`),
      `0407 must not copy ${column} onto raft_apps; a column never copied cannot drift`,
    );
  }
});

// Backfill must be total (no WHERE narrowing) so the count invariants hold, and
// re-runnable so a rolling deploy can apply it twice without diverging.
test("0407 backfill is total, and its conflict arbiter is the one that fails closed", () => {
  const backfill = migration.slice(migration.indexOf('-- ── Backfill ─'));
  assert.ok(backfill.length > 0, "the backfill section must be locatable by its marker");

  // (id, kind) rather than (id) is the whole fix. Replaying the same row matches the
  // arbiter and is a no-op; a row whose id already exists under a DIFFERENT kind does not
  // match it, hits the primary key, and raises. `ON CONFLICT ("id")` would instead swallow
  // that mismatch and leave a profile bound to the wrong adapter.
  assert.match(backfill, /INSERT INTO public\.raft_apps[\s\S]*?FROM public\.oauth_clients\s*\nON CONFLICT \("id", "kind"\) DO NOTHING/);
  assert.match(backfill, /INSERT INTO public\.raft_apps[\s\S]*?FROM public\.managed_mcp_servers\s*\nON CONFLICT \("id", "kind"\) DO NOTHING/);
  assert.match(backfill, /INSERT INTO public\.app_oauth_profiles[\s\S]*?ON CONFLICT \("app_id"\) DO NOTHING/);
  assert.match(backfill, /INSERT INTO public\.app_mcp_profiles[\s\S]*?ON CONFLICT \("app_id"\) DO NOTHING/);
  assert.doesNotMatch(
    backfill,
    /ON CONFLICT \("id"\)/,
    'the bare ("id") arbiter is the defect: it makes a cross-adapter collision silent',
  );

  const backfills = backfill.split("INSERT INTO").slice(1);
  assert.equal(backfills.length, 4, "expected exactly four backfill statements");
  for (const statement of backfills) {
    const body = statement.split("ON CONFLICT")[0];
    assert.doesNotMatch(
      body,
      /\bWHERE\b/i,
      "backfill must not filter rows: a partial backfill breaks the 1:1 count invariant",
    );
  }
});

// The root id may never be a raw legacy id again: `oauth_clients.id` and
// `managed_mcp_servers.id` are independent namespaces, so a shared value would name two
// Apps at once. Derivation is per-adapter, so the two can never collide.
test("0407 derives the App root id per adapter instead of reusing a legacy id", () => {
  assert.match(migration, /CREATE FUNCTION public\.raft_app_root_id\(p_kind text, p_source_id uuid\) RETURNS uuid/);
  assert.match(migration, /IMMUTABLE/, "the derivation must be deterministic and replayable");
  assert.match(migration, /public\.raft_app_root_id\('oauth_service', "id"\)/);
  assert.match(migration, /public\.raft_app_root_id\('mcp', "id"\)/);
  assert.doesNotMatch(
    migration.slice(migration.indexOf('-- ── Backfill ─')),
    /SELECT "id", "server_id"/,
    "the backfill must not select a legacy id straight into raft_apps.id",
  );
});

// distribution is DERIVED, never invented: OAuth Apps carry their existing app_type,
// and a Server-scoped MCP record is server-local by construction.
test("0407 derives distribution rather than defaulting it", () => {
  assert.match(migration, /'oauth_service', "app_type"/);
  assert.match(migration, /'mcp', 'server_local'/);
});

test("0407 is registered in the journal under its own tag", () => {
  const entry = journal.entries.find((e) => e.idx === 407);
  assert.ok(entry, "journal must contain entry 407");
  assert.equal(entry.tag, "0407_generic_app_root_foundation");
  // Was "0407 must be the journal tail". 0408 has since landed, so the invariant that actually
  // matters is restated: 0407 keeps its own slot and nothing has been inserted before it, which is
  // what makes the applied-prefix in the executing teeth reproducible.
  assert.equal(journal.entries.findIndex((e) => e.idx === 407), 407 - journal.entries[0].idx,
    "0407 must keep its position; entries may be appended after it but never inserted before it");
});
