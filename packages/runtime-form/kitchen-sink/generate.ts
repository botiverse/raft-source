#!/usr/bin/env node
// Generates the runtime form visual fixtures from src/kitchenSink.ts:
//   fixtures/kitchen-sink-<page>.form.v3.json               one kitchen-sink v3 create form per page
//   fixtures/kitchen-sink-<page>.option-source.<id>.v3.json one per option source it names
//   fixtures/kitchen-sink-<page>.state.v3.json              values, retried sources, the row table
//   fixtures/visual-cases.v3.json                          every visual case: the kitchen sink pages and each real v3 create form
// The case list follows the fixture directory's contents: an untracked
// `<runtime>.form.v3.json` left in fixtures/ (e.g. from a server fixture
// update on another branch) joins it locally; CI sees only tracked files.
// `--check` fails when a generated file is stale (or a stale kitchen-sink
// source file is left over) instead of writing.
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { kitchenSinkOutputs } from "./outputs";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const check = process.argv.includes("--check");
const { outputs, stale: leftovers } = kitchenSinkOutputs(readdirSync(fixtures), (name) => JSON.parse(readFileSync(resolve(fixtures, name), "utf8")));
let stale = false;
for (const [name, content] of Object.entries(outputs)) {
  const path = resolve(fixtures, name);
  let current: string | null = null;
  try { current = readFileSync(path, "utf8"); } catch { /* missing */ }
  if (current === content) continue;
  if (check) {
    process.stderr.write(`stale: fixtures/${name} (run pnpm --filter @botiverse/raft-runtime-form kitchen-sink:generate)\n`);
    stale = true;
  } else {
    writeFileSync(path, content);
  }
}
for (const name of leftovers) {
  if (check) {
    process.stderr.write(`stale: fixtures/${name} is no longer generated (run pnpm --filter @botiverse/raft-runtime-form kitchen-sink:generate)\n`);
    stale = true;
  } else {
    unlinkSync(resolve(fixtures, name));
  }
}
process.exit(stale ? 1 : 0);
