// The prompt's Artifacts entry (shared `apps/artifacts/guide.ts`; while the app is on it is entry 6, "Attachments and
// Raft Artifacts", whose `raft attachment` commands every CLI has) lists the `raft artifact` subcommands, so the list must
// be exactly the subcommands this CLI has: a renamed or added one fails here.
// A Computer ships the prompt and this CLI from one build. A self-hosted
// agent's guide comes from the server, which renders the entry only when
// this CLI declares the entry's `commandsVersion` (`guide-app:artifacts@<n>`
// in X-Raft-Client-Capabilities). So each version's subcommand list is pinned
// below: changing the subcommands means bumping `commandsVersion` and adding
// a row, never editing an old one, or an older CLI would be told about a
// command it lacks. Rewording or moving the text (as merging it into entry 6
// did) changes no subcommand and keeps the version.
import assert from "node:assert/strict";
import { FIRST_PARTY_APP_GUIDE_ENTRIES } from "@botiverse/raft-shared";

import { buildRaftProgram } from "../../program";

/** Each `commandsVersion` of the Artifacts entry and the subcommands it names. Append only. */
const ARTIFACT_SUBCOMMANDS_BY_VERSION: Record<number, readonly string[]> = {
  1: ["comment", "comments", "download", "follow", "import", "list", "publish", "pull", "read", "unfollow"],
  2: ["comment", "comments", "delete", "download", "follow", "import", "list", "move", "publish", "pull", "read", "unfollow"],
  3: ["comment", "comments", "delete", "download", "follow", "import", "list", "move", "publish", "pull", "read", "save", "unfollow"],
  4: ["comment", "comments", "delete", "download", "follow", "import", "list", "move", "publish", "pull", "read", "review", "save", "unfollow"],
  5: ["comment", "comments", "delete", "download", "follow", "import", "list", "move", "pull", "push", "read", "review", "save", "unfollow"],
  // `import` dropped (xxchan 2026-11-01): every server moves from raft-artifacts.com as a whole (legacyBulkImport).
  6: ["comment", "comments", "delete", "download", "follow", "list", "move", "pull", "push", "read", "review", "save", "unfollow"],
};

/**
 * Subcommands the entry leaves out on purpose: another command's output names
 * them when they apply, so the prompt needn't (and an older CLI keeps the
 * entry). `check`: `raft artifact push` prints it whenever there is a check
 * result to read (the new version's, or the previous one's when nothing changed).
 * `resolve` and `reopen` (#249): `raft artifact comments` names them under the
 * threads it lists (open ones and resolved ones), and a resolve notice names
 * `reopen`; the `artifact` Manual topic says when to resolve.
 */
const NAMED_BY_OTHER_OUTPUT = new Set(["check", "resolve", "reopen"]);

test("the prompt's Artifacts entry names every `raft artifact` subcommand, and only those", () => {
  const entry = FIRST_PARTY_APP_GUIDE_ENTRIES.find((candidate) => candidate.appId === "artifacts");
  assert.ok(entry, "no artifacts entry in FIRST_PARTY_APP_GUIDE_ENTRIES");
  const named = [...entry.commands.matchAll(/`raft artifact ([a-z-]+)/gu)].map((match) => match[1]);
  const program = buildRaftProgram();
  const artifact = program.commands.find((command) => command.name() === "artifact");
  assert.ok(artifact, "the CLI has no `raft artifact`");
  assert.deepEqual(
    [...new Set(named)].sort(),
    artifact.commands.map((command) => command.name()).filter((name) => !NAMED_BY_OTHER_OUTPUT.has(name)).sort(),
  );
  assert.deepEqual(
    [...new Set(named)].sort(),
    ARTIFACT_SUBCOMMANDS_BY_VERSION[entry.commandsVersion],
    `commandsVersion ${entry.commandsVersion}: a changed subcommand list needs a new commandsVersion and a new row above`,
  );
});
