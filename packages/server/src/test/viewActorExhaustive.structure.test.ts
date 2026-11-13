// RFC 080 §4.1 (Tenny): every place that branches on a ViewActor's `type`
// handles `delegated` explicitly, with a `switch` ending in
// `assertNeverViewActor`. A two-way `actor.type === "user" ? … : …` would let
// a `delegated` actor fall into the other branch and pass silently, so any
// file that names ViewActor may not compare a `type` with === / !==.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const BINARY_TYPE_CHECK = /\.type\s*[!=]==?\s*["'](user|agent|delegated)["']/;

test("files that use ViewActor branch on its type only through an exhaustive switch", () => {
  const files = sourceFiles(SRC).filter((file) => /\bViewActor\b/.test(readFileSync(file, "utf8")));
  assert.ok(files.some((file) => file.endsWith(path.join("services", "visibilityService.ts"))), "visibilityService must be scanned");
  const offenders: string[] = [];
  for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (BINARY_TYPE_CHECK.test(line)) offenders.push(`${path.relative(SRC, file)}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], "use switch (actor.type) { … default: return assertNeverViewActor(actor); }");
});

test("the scan catches a two-way type check", () => {
  assert.ok(BINARY_TYPE_CHECK.test(`  return actor.type === "user" ? a : b;`));
  assert.ok(BINARY_TYPE_CHECK.test(`if (actor.type !== 'agent') {`));
  assert.ok(!BINARY_TYPE_CHECK.test(`    case "delegated":`));
});
