/**
 * raft-perf diff: compare the first screen of two builds.
 *
 *   pnpm --filter @botiverse/raft-perf diff --base https://app.raft.build --head https://raft-app-staging.botiverse.dev
 *   pnpm --filter @botiverse/raft-perf diff --base base.json --head head.json
 *
 * Each side is a deployed origin (snapshotted now) or a snapshot file from
 * `raft-perf snapshot`. Reports first-screen growth and the bytes a returning
 * visitor must download again (files whose content hash changed). On demand,
 * not per merge. Exit 0 = ok, 1 = grew past --max-growth-kb, 2 = error.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type FirstScreenSnapshot, diffSnapshots } from "./firstScreen";
import { takeSnapshot } from "./takeSnapshot";
import { cliArgs } from "./args";

const HELP = `raft-perf diff --base <origin|snapshot.json> --head <origin|snapshot.json> [--max-growth-kb 10]

  Prints a JSON diff, then a one-line verdict on stderr.
  Exit 0 = ok, 1 = first-screen brotli bytes grew by more than --max-growth-kb, 2 = error.
`;

async function load(side: string): Promise<FirstScreenSnapshot> {
  if (/^https?:\/\//.test(side)) return takeSnapshot(side);
  const s = JSON.parse(readFileSync(side, "utf8")) as FirstScreenSnapshot;
  if (s.schema !== "raft-perf/first-screen@1") throw new Error(`${side}: not a raft-perf snapshot (schema ${String(s.schema)})`);
  return s;
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

async function main() {
  const { values } = parseArgs({ args: cliArgs(), options: { base: { type: "string" }, head: { type: "string" }, "max-growth-kb": { type: "string", default: "10" }, help: { type: "boolean" } } });
  if (values.help || !values.base || !values.head) {
    process.stdout.write(HELP);
    process.exitCode = values.help ? 0 : 2;
    return;
  }
  const maxKb = Number(values["max-growth-kb"]);
  if (!Number.isFinite(maxKb) || maxKb < 0) throw new Error(`--max-growth-kb must be a number >= 0`);
  const [base, head] = await Promise.all([load(values.base), load(values.head)]);
  const d = diffSnapshots(base, head, Math.round(maxKb * 1024));
  process.stdout.write(JSON.stringify(d, null, 2) + "\n");
  const changed = d.files.filter((f) => f.change !== "unchanged" || f.uncached).map((f) => `${f.name}(${f.uncached ? "no-store" : f.change})`);
  process.stderr.write(
    `${d.verdict}: first screen ${kb(d.base.brBytes)} -> ${kb(d.head.brBytes)} (${d.growthBrBytes >= 0 ? "+" : ""}${kb(d.growthBrBytes)}); ` +
      `returning visitors re-download ${kb(d.invalidatedBrBytes)} (${Math.round(d.invalidatedShare * 100)}%${d.uncachedBrBytes ? `, of which ${kb(d.uncachedBrBytes)} no-store, on every visit` : ""}): ${changed.join(", ") || "nothing"}\n`,
  );
  process.exitCode = d.verdict === "grew" ? 1 : 0;
}

main().catch((e) => {
  process.stderr.write(`raft-perf diff: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
});
