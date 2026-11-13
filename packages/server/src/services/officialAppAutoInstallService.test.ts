import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseOfficialPublisherServerIds } from "./officialAppAutoInstallService";

// RAFT_OFFICIAL_PUBLISHER_SERVER_IDS is all or nothing: a list is either every
// item a Server id, or it trusts no extra publisher (null).
test("the extra official publisher list parses strictly, all or nothing", () => {
  const a = randomUUID();
  const b = randomUUID();
  assert.deepEqual(parseOfficialPublisherServerIds(`${a},${b}`), [a, b]);
  assert.deepEqual(parseOfficialPublisherServerIds(` ${a} ,\t${b}\n`), [a, b], "items are trimmed");
  assert.deepEqual(parseOfficialPublisherServerIds(`${a},${a}`), [a, a], "a duplicate is not an error");
  assert.deepEqual(parseOfficialPublisherServerIds(`${a.toUpperCase()},${b}`), [a, b], "ids are lower-cased, as stored");
  for (const unset of [undefined, "", "  "]) {
    assert.deepEqual(parseOfficialPublisherServerIds(unset), [], `unset: ${JSON.stringify(unset)}`);
  }
  for (const invalid of [`${a},not-a-uuid`, `${a},,${b}`, `${a},`, `,${a}`, `${a};${b}`, `${a} ${b}`]) {
    assert.equal(parseOfficialPublisherServerIds(invalid), null, `invalid: ${JSON.stringify(invalid)}`);
  }
});
