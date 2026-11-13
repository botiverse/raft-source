// The `guide-app:<id>@<version>` client-capability tokens: a client declares
// the first-party app entries it was built with, at their `commandsVersion`,
// and the server shows an app's entry only to a client at that version or
// later, ignoring every other capability token.
import assert from "node:assert/strict";
import { FIRST_PARTY_APP_GUIDE_ENTRIES, buildRaftCliGuideMarkdown, declaredGuideApps, guideAppCapabilities, guideAppsForClient, type FirstPartyAppGuideEntry } from "./raftCliGuide";

const TABLE: readonly FirstPartyAppGuideEntry[] = [
  { appId: "alpha", commands: "**Alpha (test)** — `raft alpha list`.", commandsVersion: 1 },
  { appId: "beta", commands: "**Beta (test)** — `raft beta list`, `raft beta add`.", commandsVersion: 2 },
];

test("a build declares one token per entry it carries, at the entry's version", () => {
  assert.deepEqual(guideAppCapabilities(), FIRST_PARTY_APP_GUIDE_ENTRIES.map((entry) => `guide-app:${entry.appId}@${entry.commandsVersion}`));
  assert.deepEqual(guideAppCapabilities(TABLE), ["guide-app:alpha@1", "guide-app:beta@2"]);
  assert.deepEqual(guideAppCapabilities([]), []);
});

test("the server reads the declared app ids with a whole version from 1, and nothing else", () => {
  assert.deepEqual([...declaredGuideApps("manual-context-v1, guide-app:artifacts@1 ,guide-app:future@3,guide-app:artifacts@2")], [["artifacts", 2], ["future", 3]]);
  for (const header of ["manual-context-v1", "guide-app:artifacts", "guide-app:artifacts@0", "guide-app:artifacts@x", "guide-app:artifacts@1.5", "guide-app:@1", "", undefined]) {
    assert.equal(declaredGuideApps(header).size, 0, String(header));
  }
});

test("an app's entry goes to a client that declared it at the entry's version or later", () => {
  const enabled = ["alpha", "beta", "unknown"];
  assert.deepEqual(guideAppsForClient(enabled, "guide-app:alpha@1,guide-app:beta@2,guide-app:unknown@1", TABLE), ["alpha", "beta"], "an app with no entry adds nothing");
  assert.deepEqual(guideAppsForClient(enabled, "guide-app:alpha@1,guide-app:beta@1", TABLE), ["alpha"], "a client built before beta's commands changed");
  assert.deepEqual(guideAppsForClient(enabled, "guide-app:alpha@4,guide-app:beta@3", TABLE), ["alpha", "beta"], "a newer client");
  assert.deepEqual(guideAppsForClient(["beta"], "guide-app:alpha@1", TABLE), [], "declared but not on");
  assert.deepEqual(guideAppsForClient(enabled, undefined, TABLE), [], "no header");
});

// A version that only removed a subcommand (Sage on #12378) keeps the older
// clients that have every command the entry still names: `minClientVersion`.
test("an entry whose newer version only removed commands still goes to a client at its minClientVersion", () => {
  const table: readonly FirstPartyAppGuideEntry[] = [{ appId: "gamma", commands: "**Gamma (test)** — `raft gamma list`.", commandsVersion: 6, minClientVersion: 5 }];
  assert.deepEqual(guideAppsForClient(["gamma"], "guide-app:gamma@5", table), ["gamma"], "a v5 client has every command v6 names");
  assert.deepEqual(guideAppsForClient(["gamma"], "guide-app:gamma@4", table), [], "an older one still doesn't");
  assert.deepEqual(guideAppCapabilities(table), ["guide-app:gamma@6"], "a build still declares its own version");
  // The real Artifacts entry: a CLI built since 10-28 declares @5 and keeps the entry (entry 6 with the Artifact commands).
  assert.deepEqual(guideAppsForClient(["artifacts"], "guide-app:artifacts@5"), ["artifacts"]);
});

// A CLI that declares @5 (built since 10-28) had entry 18; merging it into
// entry 6 keeps its Artifact commands there. Older (@4) or no token: the plain entry 6.
test("Artifacts: a @5 or newer client gets the Artifact commands in entry 6, an older one the plain entry 6", () => {
  const artifacts = FIRST_PARTY_APP_GUIDE_ENTRIES.find((entry) => entry.appId === "artifacts")!;
  const guideFor = (header: string | undefined) =>
    buildRaftCliGuideMarkdown(undefined, { enabledApps: guideAppsForClient(["artifacts"], header) });
  const entry6 = (guide: string) => /\n6\. [^\n]*/u.exec(guide)![0];
  for (const version of [5, artifacts.commandsVersion, artifacts.commandsVersion + 1]) {
    const guide = guideFor(`guide-app:artifacts@${version}`);
    assert.match(entry6(guide), /^\n6\. \*\*Attachments and Raft Artifacts\*\* — `raft attachment upload`.*`raft artifact list`/u, `@${version}`);
    assert.doesNotMatch(guide, /\n18\. /u, "no Artifacts entry of its own");
  }
  const plain = buildRaftCliGuideMarkdown();
  for (const header of ["guide-app:artifacts@4", undefined]) {
    const guide = guideFor(header);
    assert.equal(guide, plain, String(header));
    // Only the pointer to the CLI's own help: no command an older CLI may lack.
    assert.doesNotMatch(entry6(guide).replaceAll("`raft artifact --help`", ""), /raft artifact/u);
    assert.match(entry6(guide), /`raft artifact --help` lists its commands; if your CLI has none, attach the file/u);
  }
});

test("what a build declares gets every enabled entry of that build", () => {
  const header = ["manual-context-v1", ...guideAppCapabilities()].join(",");
  const ids = FIRST_PARTY_APP_GUIDE_ENTRIES.map((entry) => entry.appId);
  assert.deepEqual(guideAppsForClient(ids, header), ids);
});
