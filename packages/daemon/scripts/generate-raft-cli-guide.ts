/**
 * Generate `manual/agent-knowledge/raft-cli-overview.md` from the canonical builder in
 * `packages/daemon/src/drivers/raftCliGuide.ts`.
 *
 * `systemPrompt.ts` (managed-runner audience) and this script
 * (manual topic / self-hosted-runner audience) consume the same builder, so shared
 * CLI operating semantics stay in sync while audience-specific setup/runtime
 * wording remains explicit. Freshness is guarded by
 * `src/drivers/raftCliGuideFreshness.test.ts` in the always-run daemon suite
 * (byte-compare of builder output vs the committed file), not a dedicated CI job.
 *
 * Contract: @xxchan #wg-self-hosted-agent msg=1ae6ffd3 / msg=b61ef197.
 * Factoring: @Hao msg=c807d610.
 *
 * Run:
 *   pnpm --filter @botiverse/raft-daemon generate:raft-cli-guide
 *
 * Do not edit `manual/agent-knowledge/raft-cli-overview.md` directly — edit
 * `packages/daemon/src/drivers/raftCliGuide.ts` and rerun this script.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRaftCliOverviewMdx } from "../src/drivers/raftCliGuide.js";

const SCRIPT_DIR = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const OUTPUT_PATH = resolve(REPO_ROOT, "manual", "agent-knowledge", "raft-cli-overview.md");

const body = buildRaftCliOverviewMdx();

writeFileSync(OUTPUT_PATH, body, { encoding: "utf-8" });

process.stdout.write(`wrote ${OUTPUT_PATH} (${body.length} bytes)\n`);
