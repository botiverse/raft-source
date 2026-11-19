#!/usr/bin/env node
/**
 * raft-perf deploy-record: one deploy's first-screen record against the one
 * before it, as Markdown for a CI run summary.
 *
 *   node --import @oxc-node/core/register src/deployRecord.ts --graph g.json --snapshot s.json \
 *     [--base-graph prev-g.json] [--base-snapshot prev-s.json] [--note-kb 5] [--out summary.md]
 *
 * Two sources, named in the output. Bytes a visitor downloads come from the
 * deployed files (`snapshot`: brotli sizes of the live first screen). What is
 * inside them comes from the build graph (`graph --build`, a second build of
 * the same commit). The graph has to be a graph of the deployed build: the
 * same commit when the caller names it, the same first-screen files, and
 * sizes that differ by no more than a build timestamp. Otherwise the record
 * says so and gives no module breakdown: numbers from another build would be
 * wrong with confidence. A previous record of the same commit is a re-run,
 * not an earlier deploy, and is not compared with.
 *
 * It reports; it never fails anything. Exit 0, or 2 on unreadable input.
 * The Markdown goes to --out (or stdout); one JSON line with the headline
 * numbers goes to stderr for logs. Pure part: `recordMarkdown`, pinned by
 * deployRecord.test.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cliArgs } from "./args";
import { type BuildGraph, initialFiles } from "./buildGraph";
import { type GraphDiff, diffGraphs } from "./buildGraphDiff";
import { type FirstScreenDiff, type FirstScreenSnapshot, diffSnapshots, stableName } from "./firstScreen";

export interface RecordInput {
  graph: BuildGraph;
  snapshot: FirstScreenSnapshot;
  baseGraph?: BuildGraph;
  baseSnapshot?: FirstScreenSnapshot;
  /** Growth in brotli bytes from which the record is marked for attention. */
  noteBytes: number;
  /** The commit the graph was built from, and the one the previous record's graph was built from, when known. */
  graphCommit?: string;
  baseGraphCommit?: string;
}

export interface DeployRecord {
  markdown: string;
  /** The graph's first-visit JS files are the deployed first screen's JS files. */
  consistent: boolean;
  growthBrBytes: number | null;
  /** The growth reached `noteBytes`. */
  noteworthy: boolean;
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;
const signed = (bytes: number): string => `${bytes > 0 ? "+" : ""}${Math.abs(bytes) < 100 ? `${bytes} B` : kb(bytes)}`;
const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 8) : "unknown commit");

export interface Agreement {
  /** Names (without content hash) only one side has, JS and, when the graph records them, stylesheets. */
  onlyGraph: string[];
  onlyDeployed: string[];
  /** Of the files both have: how many have the very same hashed name, and how many the same uncompressed size. */
  shared: number;
  sameName: number;
  sameSize: number;
  /** The largest difference in uncompressed bytes among the shared files. */
  largestSizeGap: number;
  /** Why the graph cannot be the deployed build, or null when nothing says so. */
  mismatch: string | null;
}

/** A second build of the same commit differs from the deployed one by a build timestamp at most: sizes within this many bytes per file. */
export const SAME_BUILD_SIZE_GAP = 256;

/**
 * Is the graph a graph of the deployed build? File names without their hash
 * never change, so they cannot tell: the commit, the hashed names and the
 * sizes can. A different commit, a file on one side only, or a file whose
 * size is off by more than a build timestamp's worth is a mismatch.
 */
export function agreement(graph: BuildGraph, snapshot: FirstScreenSnapshot, graphCommit?: string): Agreement {
  const initial = initialFiles(graph);
  const built = new Map<string, { file: string; bytes: number }>();
  for (const chunk of graph.chunks) if (initial.has(chunk.file)) built.set(stableName(chunk.file), { file: chunk.file.split("/").pop()!, bytes: chunk.bytes });
  const assetBytes = new Map(graph.assets.map((a) => [a.file, a.bytes]));
  const cssKnown = graph.chunks.some((c) => c.css !== undefined);
  if (cssKnown) for (const chunk of graph.chunks) if (initial.has(chunk.file)) for (const css of chunk.css ?? []) built.set(stableName(css), { file: css.split("/").pop()!, bytes: assetBytes.get(css) ?? 0 });
  const deployed = new Map(snapshot.files.filter((f) => f.kind === "js" || cssKnown).map((f) => [f.name, { file: f.url.split("/").pop()!, bytes: f.bytes }]));
  const onlyGraph = [...built.keys()].filter((n) => !deployed.has(n)).sort();
  const onlyDeployed = [...deployed.keys()].filter((n) => !built.has(n)).sort();
  let shared = 0;
  let sameName = 0;
  let sameSize = 0;
  let largestSizeGap = 0;
  for (const [name, mine] of built) {
    const theirs = deployed.get(name);
    if (!theirs) continue;
    shared++;
    if (mine.file === theirs.file) sameName++;
    if (mine.bytes === theirs.bytes) sameSize++;
    largestSizeGap = Math.max(largestSizeGap, Math.abs(mine.bytes - theirs.bytes));
  }
  const deployedCommit = snapshot.release.commitSha;
  const mismatch =
    graphCommit && deployedCommit && graphCommit !== deployedCommit
      ? `the graph was built from ${short(graphCommit)}, the deploy is ${short(deployedCommit)}`
      : onlyGraph.length || onlyDeployed.length
        ? "the two do not have the same first-screen files"
        : largestSizeGap > SAME_BUILD_SIZE_GAP
          ? `a first-screen file differs by ${largestSizeGap} bytes between the graph's build and the deployed one`
          : null;
  return { onlyGraph, onlyDeployed, shared, sameName, sameSize, largestSizeGap, mismatch };
}

export function recordMarkdown(input: RecordInput): DeployRecord {
  const { graph, snapshot, baseGraph, baseSnapshot, noteBytes } = input;
  const lines: string[] = [];
  const agree = agreement(graph, snapshot, input.graphCommit);
  const consistent = agree.mismatch === null;
  // the same commit as the record before is a re-run of this deploy, not an earlier one: nothing to compare with
  const rerun = !!baseSnapshot && !!snapshot.release.commitSha && baseSnapshot.release.commitSha === snapshot.release.commitSha;
  const deployed: FirstScreenDiff | null = baseSnapshot && !rerun ? diffSnapshots(baseSnapshot, snapshot, noteBytes) : null;
  const growth = deployed ? deployed.growthBrBytes : null;
  const noteworthy = growth !== null && growth >= noteBytes;

  lines.push(`## First screen of this deploy (${short(snapshot.release.commitSha)})`, "");
  lines.push("Bytes are brotli sizes of the files this deploy serves (read from the live origin). What is inside them comes from a second build of the same commit with the build-graph plugin; nothing from that build is published.", "");
  if (!deployed) {
    lines.push(`- First screen: **${kb(snapshot.totals.brBytes)}** over the wire in ${snapshot.files.length} files. ${rerun ? "The record before this one is of the same commit (a re-run): nothing to compare with." : "No earlier record to compare with."}`);
  } else {
    lines.push(`- First screen: ${kb(deployed.base.brBytes)} → **${kb(deployed.head.brBytes)}** over the wire (**${signed(deployed.growthBrBytes)}**) against the deploy before it (${short(deployed.base.commitSha)}).${noteworthy ? ` **This is ${kb(noteBytes)} or more: worth a look.**` : ""}`);
    lines.push(`- A returning visitor downloads ${kb(deployed.invalidatedBrBytes)} again (${Math.round(deployed.invalidatedShare * 100)}% of the first screen).`);
    const changed = deployed.files.filter((f) => f.change !== "unchanged");
    if (changed.length) lines.push(`- Files that changed: ${changed.map((f) => `\`${f.name}\` (${f.change})`).join(", ")}.`);
  }
  lines.push("");

  if (!consistent) {
    lines.push("### The build graph is not the deployed build", "");
    lines.push(`No module breakdown is given: ${agree.mismatch}.`);
    if (agree.onlyGraph.length) lines.push(`- In the graph, not deployed: ${agree.onlyGraph.map((n) => `\`${n}\``).join(", ")}`);
    if (agree.onlyDeployed.length) lines.push(`- Deployed, not in the graph: ${agree.onlyDeployed.map((n) => `\`${n}\``).join(", ")}`);
    return { markdown: `${lines.join("\n")}\n`, consistent, growthBrBytes: growth, noteworthy };
  }
  lines.push(`The graph matches the deployed build: of ${agree.shared} first-screen files, ${agree.sameName} have the very same hashed name and ${agree.sameSize} the same size (largest difference ${agree.largestSizeGap} bytes).`, "");
  if (rerun) return { markdown: `${lines.join("\n")}\n`, consistent, growthBrBytes: growth, noteworthy };
  if (baseGraph && baseSnapshot && input.baseGraphCommit && baseSnapshot.release.commitSha && input.baseGraphCommit !== baseSnapshot.release.commitSha) {
    lines.push(`The previous record's graph (${short(input.baseGraphCommit)}) and its deployed files (${short(baseSnapshot.release.commitSha)}) are of different commits: no module comparison this time.`);
    return { markdown: `${lines.join("\n")}\n`, consistent, growthBrBytes: growth, noteworthy };
  }
  if (!baseGraph) {
    lines.push("No earlier build graph to compare with: the next deploy will say what entered and left the first screen.");
    return { markdown: `${lines.join("\n")}\n`, consistent, growthBrBytes: growth, noteworthy };
  }
  const d: GraphDiff = diffGraphs(baseGraph, graph);
  lines.push("### What changed inside the first screen", "");
  lines.push("From the build graph: files in bytes on disk (uncompressed), modules in the bundler's sizes before minification.", "");
  if (!d.files.length && !d.modules.entered.length && !d.modules.left.length && !d.modules.resized.length) lines.push("Nothing of 1 KB or more.");
  if (d.files.length) lines.push(...d.files.slice(0, 12).map((f) => `- file \`${f.name}\`: ${f.status === "changed" ? signed(f.delta) : `${f.status}, ${kb(f.status === "added" ? f.head : f.base)}`}`));
  const list = (title: string, rows: string[]): void => {
    if (rows.length) lines.push("", `**${title}**`, "", ...rows.slice(0, 15), ...(rows.length > 15 ? [`- … and ${rows.length - 15} more`] : []));
  };
  list("Entered the first screen", d.modules.entered.map((m) => `- \`${m.id}\` ${kb(m.bytes)} (${m.other === "later" ? "was loaded later" : "new"})`));
  list("Left the first screen", d.modules.left.map((m) => `- \`${m.id}\` ${kb(m.bytes)} (${m.other === "later" ? "now loaded later" : "gone"})`));
  list("Changed size there", d.modules.resized.map((m) => `- \`${m.name}\` ${signed(m.delta)}`));
  return { markdown: `${lines.join("\n")}\n`, consistent, growthBrBytes: growth, noteworthy };
}

const HELP = `raft-perf deploy-record --graph <build-graph.json> --snapshot <first-screen.json> [--base-graph <file>] [--base-snapshot <file>] [--graph-commit <sha>] [--base-graph-commit <sha>] [--note-kb 5] [--out <summary.md>]

  --graph, --snapshot            this deploy: from \`graph --build\` and from \`snapshot --origin\` of the live web
  --base-graph, --base-snapshot  the deploy before it (either may be missing: the record says what it cannot compare)
  --graph-commit, --base-graph-commit  the commits the two graphs were built from: a graph of another commit than the deployed files is refused
  --note-kb                      growth over the wire, in KB of brotli, from which the record asks for a look (default 5)
  --out                          write the Markdown here instead of stdout
`;

function main(): number {
  const { values: args } = parseArgs({ args: cliArgs(), options: { graph: { type: "string" }, snapshot: { type: "string" }, "base-graph": { type: "string" }, "base-snapshot": { type: "string" }, "graph-commit": { type: "string" }, "base-graph-commit": { type: "string" }, "note-kb": { type: "string", default: "5" }, out: { type: "string" }, help: { type: "boolean" } } });
  if (args.help || !args.graph || !args.snapshot) {
    process.stdout.write(HELP);
    return args.help ? 0 : 2;
  }
  const noteKb = Number(args["note-kb"]);
  if (!Number.isFinite(noteKb) || noteKb <= 0) throw new Error("--note-kb takes a number above 0");
  const read = <T extends { schema: string }>(path: string, schema: string): T => {
    const value = JSON.parse(readFileSync(path, "utf8")) as T;
    if (value.schema !== schema) throw new Error(`${path}: expected ${schema}, found ${String(value.schema)}`);
    return value;
  };
  const record = recordMarkdown({
    graph: read<BuildGraph>(args.graph, "raft-perf/build-graph@1"),
    snapshot: read<FirstScreenSnapshot>(args.snapshot, "raft-perf/first-screen@1"),
    baseGraph: args["base-graph"] ? read<BuildGraph>(args["base-graph"], "raft-perf/build-graph@1") : undefined,
    baseSnapshot: args["base-snapshot"] ? read<FirstScreenSnapshot>(args["base-snapshot"], "raft-perf/first-screen@1") : undefined,
    noteBytes: Math.round(noteKb * 1024),
    graphCommit: args["graph-commit"],
    baseGraphCommit: args["base-graph-commit"],
  });
  if (args.out) writeFileSync(args.out, record.markdown);
  else process.stdout.write(record.markdown);
  process.stderr.write(`${JSON.stringify({ tool: "raft-perf deploy-record", consistent: record.consistent, growthBrBytes: record.growthBrBytes, noteworthy: record.noteworthy })}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`raft-perf deploy-record: ${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}
