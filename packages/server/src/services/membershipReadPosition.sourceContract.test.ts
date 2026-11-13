import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * "Unread" is seq > read position, and a member's read position starts where
 * they joined (#8292). Any service code that adds a member must therefore
 * either write that position (startReadPositionAtJoin / raiseReadPositionForJoin)
 * or say why none is needed: a brand-new conversation has no history, and no
 * row means position 0. A role-only projection of an existing J member must
 * instead preserve their existing read positions; it is not another join.
 * Without this, a path that adds a member to a
 * conversation WITH history (as rapRegistryStore's restore once did) silently
 * turns that whole history into unread for the member.
 */
const SERVICES = path.dirname(fileURLToPath(import.meta.url));
const INSERT = /\.insert\((channelAgents|channelHumans)\)/;
const WRITES = /startReadPositionAtJoin\(|raiseReadPositionForJoin\(/;
const MARKER = /\/\/ read-position: (new conversation|test-only mutation|existing member projection)/;
const LOOK_BACK = 6;
const LOOK_AHEAD = 40;

test("every membership insert in services writes a read position or says why none is needed", () => {
  const offenders: string[] = [];
  let sites = 0;
  for (const file of readdirSync(SERVICES)) {
    if (!file.endsWith(".ts") || file.includes(".test.") || file.includes("testkit")) continue;
    const lines = readFileSync(path.join(SERVICES, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!INSERT.test(line)) return;
      sites += 1;
      const before = lines.slice(Math.max(0, index - LOOK_BACK), index + 1).join("\n");
      const after = lines.slice(index, index + LOOK_AHEAD).join("\n");
      if (!MARKER.test(before) && !WRITES.test(after)) offenders.push(`${file}:${index + 1}`);
    });
  }
  assert.ok(sites >= 15, `expected to find the membership insert sites, found ${sites}`);
  assert.deepEqual(offenders, [], "add startReadPositionAtJoin, or a truthful read-position reason for a new conversation or an existing-member role projection");
});
