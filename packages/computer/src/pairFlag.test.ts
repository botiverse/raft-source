import assert from "node:assert/strict";

import { program } from "./cli";
import { INVALID_PAIR_WARNING, resolvePairFlag } from "./pairFlag";

const ID = "pAiR_0123456789abcdefghijklmnopqrstuvwxyzAB";

test("--pair: a base64url-ish id of 16–128 characters is used (paste whitespace trimmed)", () => {
  const warnings: string[] = [];
  const warn = (line: string) => warnings.push(line);
  assert.equal(resolvePairFlag(ID, warn), ID);
  assert.equal(resolvePairFlag(`  ${ID}\n`, warn), ID);
  assert.equal(resolvePairFlag("a".repeat(16), warn), "a".repeat(16));
  assert.equal(resolvePairFlag("a".repeat(128), warn), "a".repeat(128));
  assert.equal(resolvePairFlag(undefined, warn), undefined);
  assert.deepEqual(warnings, []);
});

test("--pair: a malformed id is dropped with one warning that does not echo it", () => {
  for (const bad of ["", "short", "a".repeat(15), "a".repeat(129), `${ID}!`, "has space in it 0123", "pair/with+slash=0123"]) {
    const warnings: string[] = [];
    assert.equal(resolvePairFlag(bad, (line) => warnings.push(line)), undefined, bad);
    assert.deepEqual(warnings, [INVALID_PAIR_WARNING]);
    if (bad) assert.ok(!warnings[0]!.includes(bad));
  }
});

test("--pair <id> is an option of setup and attach (value required), with help naming the Add Computer window", () => {
  for (const name of ["setup", "attach"]) {
    const command = program.commands.find((c) => c.name() === name);
    assert.ok(command, name);
    const option = command.options.find((o) => o.long === "--pair");
    assert.ok(option, `${name} has --pair`);
    assert.equal(option.required, true);
    assert.match(command.helpInformation(), /--pair <id>\s+added automatically by the Add Computer window/);
  }
  assert.equal(program.commands.find((c) => c.name() === "login")?.options.some((o) => o.long === "--pair"), false);
});
