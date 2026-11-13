import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeTemplateKey,
  currentTemplateKey,
  decideTemplateSource,
  pruneTemplateDir,
  templateFileName,
  templateMode,
} from "./pgliteTemplate";

const base = {
  journal: '{"entries":[]}',
  migrations: [{ tag: "0000_a", sql: "CREATE TABLE a (id int);" }],
  compatibilityStatements: ["CREATE INDEX IF NOT EXISTS i ON a (id)"],
  pgliteVersion: "0.4.4",
};

test("the template key changes with every input it covers", () => {
  const key = computeTemplateKey(base);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(computeTemplateKey({ ...base }), key);
  const variants = [
    { ...base, journal: '{"entries":[1]}' },
    { ...base, migrations: [{ tag: "0000_a", sql: "CREATE TABLE a (id bigint);" }] },
    { ...base, migrations: [{ tag: "0000_b", sql: "CREATE TABLE a (id int);" }] },
    { ...base, migrations: [...base.migrations, { tag: "0001_b", sql: "" }] },
    { ...base, compatibilityStatements: [] },
    { ...base, pgliteVersion: "0.4.5" },
    { ...base, formatVersion: 999 },
  ];
  for (const variant of variants) assert.notEqual(computeTemplateKey(variant), key);
});

test("the current key is computed from the real migrations", async () => {
  assert.match(templateFileName(await currentTemplateKey()), /^pglite-template-[0-9a-f]{32}\.tar$/);
});

test("RAFT_TEST_PGLITE_TEMPLATE selects reuse, rebuild or off", () => {
  assert.equal(templateMode({}), "reuse");
  assert.equal(templateMode({ RAFT_TEST_PGLITE_TEMPLATE: "" }), "reuse");
  assert.equal(templateMode({ RAFT_TEST_PGLITE_TEMPLATE: "rebuild" }), "rebuild");
  assert.equal(templateMode({ RAFT_TEST_PGLITE_TEMPLATE: "off" }), "off");
  assert.throws(() => templateMode({ RAFT_TEST_PGLITE_TEMPLATE: "yes" }), /must be unset/);
});

test("a missing template warns locally, fails in CI, and is silent outside Vitest", () => {
  assert.deepEqual(decideTemplateSource({ underVitest: true, templatePath: "/t.tar", ci: true }), { kind: "file", path: "/t.tar" });
  assert.deepEqual(decideTemplateSource({ underVitest: true, ci: false }), { kind: "processLocal", warn: true });
  assert.throws(() => decideTemplateSource({ underVitest: true, ci: true }), /PGlite test template missing/);
  assert.deepEqual(decideTemplateSource({ underVitest: false, ci: true }), { kind: "processLocal", warn: false });
});

test("pruning keeps three templates (current first, then newest) and drops stale temp files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pglite-template-prune-"));
  try {
    const now = Date.now();
    const files: Array<[string, number]> = [
      ["pglite-template-a.tar", 1], ["pglite-template-b.tar", 2], ["pglite-template-c.tar", 3],
      ["pglite-template-d.tar", 4], ["pglite-template-old-current.tar", 50],
      ["pglite-template-x.tar.123.tmp", 120], ["pglite-template-y.tar.456.tmp", 10],
      ["unrelated.tar", 500],
    ];
    for (const [name, ageMinutes] of files) {
      const file = path.join(dir, name);
      await writeFile(file, "");
      const time = new Date(now - ageMinutes * 60_000);
      await utimes(file, time, time);
    }
    const removed = await pruneTemplateDir(dir, { current: "pglite-template-old-current.tar", now });
    assert.deepEqual(removed.sort(), ["pglite-template-c.tar", "pglite-template-d.tar", "pglite-template-x.tar.123.tmp"]);
    assert.deepEqual((await readdir(dir)).sort(), [
      "pglite-template-a.tar", "pglite-template-b.tar", "pglite-template-old-current.tar",
      "pglite-template-y.tar.456.tmp", "unrelated.tar",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
