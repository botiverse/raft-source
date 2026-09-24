import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { canonicalizeWikiWorkspacePackFiles } from "@botiverse/raft-shared";
import { WIKI_AGENT_WORKSPACE_PACK } from "./generated/wikiAgentWorkspacePack.js";

const serverSourceRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.join(serverSourceRoot, "wikiAgentWorkspacePack");
const packagesRoot = path.resolve(serverSourceRoot, "..", "..");

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function listFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return listFiles(path.join(directory, entry.name), relativePath);
      assert.equal(entry.isFile(), true, `unexpected pack entry: ${relativePath}`);
      return [relativePath];
    })
    .sort(comparePaths);
}

test("generated Wiki workspace pack exactly embeds the readable Server-release sources", () => {
  const sourceFiles = listFiles(sourceRoot).map((relativePath) => {
    const content = readFileSync(path.join(sourceRoot, ...relativePath.split("/")), "utf8");
    return {
      relativePath,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: Buffer.byteLength(content),
    };
  });

  assert.deepEqual(WIKI_AGENT_WORKSPACE_PACK.files, sourceFiles);
  assert.equal(
    WIKI_AGENT_WORKSPACE_PACK.packId,
    createHash("sha256")
      .update(canonicalizeWikiWorkspacePackFiles(sourceFiles))
      .digest("hex"),
  );
  assert.deepEqual(sourceFiles.map((file) => file.relativePath), [
    ".agents/skills/ingest.md",
    ".agents/skills/lint.md",
    ".agents/skills/query.md",
    ".claude/skills/ingest.md",
    ".claude/skills/lint.md",
    ".claude/skills/query.md",
    "AGENTS.md",
    "CLAUDE.md",
  ]);
});

test("Wiki workspace pack retains the reviewed Ingest, Query, and convergent Lint behavior", () => {
  const contentByPath = new Map(
    WIKI_AGENT_WORKSPACE_PACK.files.map((file) => [file.relativePath, file.content]),
  );
  const agents = contentByPath.get("AGENTS.md")!;
  const ingest = contentByPath.get(".agents/skills/ingest.md")!;
  const query = contentByPath.get(".agents/skills/query.md")!;
  const lint = contentByPath.get(".agents/skills/lint.md")!;

  assert.match(agents, /publish immutable document revisions plus one canonical S3 manifest/);
  assert.match(agents, /raft wiki read <artifactId>/);
  // The Reminder section states the Agent's own obligation on wake. It must not
  // promise Server behaviour: the previous wording guaranteed the Server filtered
  // scheduled wakes, an unrelated scheduling change removed that filter, and the
  // instruction the Agent executes silently became false.
  assert.match(agents, /Being woken is not evidence that something changed/);
  // Whitespace-tolerant: these files are hard-wrapped, so a reworded sentence
  // re-wraps and a literal-space regex fails on prose that is still correct.
  assert.match(agents, /end\s+the run without publishing a Manifest/);
  // The run condition is "uncovered", not "recent" -- an unread channel is
  // work, so a cold start cannot be mistaken for "nothing new to do".
  assert.match(agents, /whether anything\s+eligible is uncovered, not whether anything is recent/);
  assert.doesNotMatch(agents, /advances only the reminder schedule and does not wake/);
  assert.match(agents, /apply the claim-freshness and same-publication repair rules/);
  assert.match(ingest, /inventory the eligible channel, thread, task, and attachment boundaries/);
  assert.match(ingest, /stable artifact id plus slug is the topic identity/);
  assert.match(ingest, /successful zero-message result, not a read failure/);
  assert.match(ingest, /Match new evidence against existing claims as well as topic identity/);
  assert.match(ingest, /Until every eligible source\s+channel is covered through the run's frozen boundary/);
  assert.match(ingest, /update every affected Page in\s+this publication/);
  assert.match(ingest, /run-scoped, disposable workspace cache/);
  assert.match(ingest, /second long-lived archive/);
  assert.match(ingest, /boundary is run-local planning state, not a canonical manifest fact/);
  assert.match(ingest, /Freeze a fresh source boundary at the start of every wake/);
  // A thread has no coverage entry of its own, so an unqualified "start from
  // that channel's covered high-water" reads as "start from zero" for a thread
  // and makes every chunk re-read whole threads. The exception must stay in the
  // same sentence as the rule.
  assert.match(ingest, /for\s+a\s+thread\s+that\s+is\s+its\s+parent\s+channel's\s+high-water,\s+not\s+zero/);
  // Replies keep arriving long after their parent, so a chunk that reads only
  // the threads opened inside it silently under-counts. The rule is parent
  // seq <= y, not "parent falls in this chunk" — the defect that produced two
  // real publication rejections.
  assert.match(ingest, /every\s+thread\s+whose\s+parent\s+sits\s+at\s+or\s+below\s+`y`/);
  // #6791 shipped a wrong execution rule because only the start point was
  // pinned. Pin the method too: the remote bound for a thread, the per-chunk
  // slice out of cache, and the fail-closed fallback for an untrusted mark.
  assert.match(ingest, /the\s+run's\s+frozen\s+boundary\s+for\s+a\s+thread,\s+so\s+one\s+read\s+of\s+that\s+thread\s+serves/);
  assert.match(ingest, /counting\s+each\s+chunk\s+from\s+that\s+copy\s+by\s+`seq`/);
  assert.match(ingest, /otherwise\s+discard\s+the\s+mark\s+and\s+re-read\s+from\s+the\s+parent/);
  assert.match(ingest, /input-validation failure is a safe rejected attempt/);
  assert.match(ingest, /Correct the reported fields in one\s+pass and retry the existing payload/);
  assert.match(ingest, /cannot split a merged topic back into its former fragments/);
  assert.match(query, /Answer human questions from the canonical compiled Wiki/);
  assert.match(query, /raft wiki read <artifactId>/);
  assert.match(lint, /canonical weekly Wiki lint reminder/);
  assert.match(lint, /A clean Wiki is a fixed point/);
  assert.match(lint, /archived\s+redirect to the survivor/);
  assert.match(lint, /repairedArtifactIds/);
});

test("daemon release no longer depends on separately packaged Wiki template assets", () => {
  const daemonPackagePath = path.join(packagesRoot, "daemon", "package.json");
  const daemonPackage = readFileSync(daemonPackagePath, "utf8");
  assert.doesNotMatch(daemonPackage, /wikiAgentWorkspace/);
  assert.equal(
    existsSync(path.join(packagesRoot, "daemon", "src", "wikiAgentWorkspace")),
    false,
  );
});
