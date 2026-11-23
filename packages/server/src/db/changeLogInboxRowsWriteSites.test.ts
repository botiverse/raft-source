import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_SUPPRESSION_WRITE_SITES } from "../services/inboxSuppressionWriters";

// The change_log trigger on inbox_suppression_states (migration
// change_log_inbox_rows) carries a Done position only for the Done writers,
// named in its SQL. Those names must be the registry's (inboxSuppressionWriters.ts),
// so a rename there cannot silently turn every Done into a plain upsert.

const migrationsDir = join(import.meta.dirname, "../../drizzle");

test("the inbox_row trigger names exactly the Done write sites of INBOX_SUPPRESSION_WRITE_SITES", () => {
  const files = readdirSync(migrationsDir).filter((file) => /^\d{4}_change_log_inbox_rows\.sql$/.test(file));
  assert.equal(files.length, 1, `one change_log_inbox_rows migration: ${JSON.stringify(files)}`);
  const source = readFileSync(join(migrationsDir, files[0]!), "utf8");
  const lists = [...source.matchAll(/write_site\s+IN\s*\(([^)]*)\)/g)];
  assert.equal(lists.length, 1, "one write_site list in the trigger");
  const named = [...lists[0]![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!).sort();
  assert.deepEqual(named, [INBOX_SUPPRESSION_WRITE_SITES.markChannelInboxDone, INBOX_SUPPRESSION_WRITE_SITES.markThreadDone].sort());
  const known = new Set<string>(Object.values(INBOX_SUPPRESSION_WRITE_SITES));
  for (const site of named) assert.ok(known.has(site), `${site} is a registered write site`);
});
