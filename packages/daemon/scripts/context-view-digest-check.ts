/**
 * View Context v0 acceptance check: for each Claude Code session file given,
 * the share of its model requests (`api-request` records) that the daemon's
 * restorer rebuilds exactly, proven by recomputing each request's
 * `requestDigest` (src/agentContextView/claudeSessionRestore.ts).
 *
 * Prints counts only, never content.
 *
 * Run (from packages/daemon):
 *   node --import @oxc-node/core/register scripts/context-view-digest-check.ts ~/.claude/projects/<project>/<session>.jsonl [...]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ClaudeSessionIndex,
  parseClaudeSessionRecords,
  verifyClaudeSessionDigests,
} from "../src/agentContextView/claudeSessionRestore";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: context-view-digest-check.ts <session.jsonl> [...]");
  process.exit(2);
}
let matched = 0;
let total = 0;
for (const file of files) {
  const startedAt = performance.now();
  const buffer = readFileSync(file);
  const index = new ClaudeSessionIndex(parseClaudeSessionRecords(buffer));
  const report = verifyClaudeSessionDigests(index);
  const checked = report.requests - report.noDigest;
  matched += report.matched;
  total += checked;
  const share = checked > 0 ? ((report.matched / checked) * 100).toFixed(2) : "n/a";
  console.log(`${path.basename(file).slice(0, 8)} bytes=${buffer.length} requests=${report.requests} matched=${report.matched} mismatched=${report.mismatched} unresolved=${report.unresolved} no_digest=${report.noDigest} match=${share}% ms=${Math.round(performance.now() - startedAt)}`);
}
console.log(`total matched=${matched}/${total} (${total > 0 ? ((matched / total) * 100).toFixed(2) : "n/a"}%)`);
