// The Artifacts app's place in the guide (`FIRST_PARTY_APP_GUIDE_ENTRIES`):
// with `artifacts` in enabledApps its entry is entry 6, the attachment and
// Artifact commands in one entry instead of the plain one, with no Artifacts
// entry after the fixed ones; and
// `artifact-share` leaves the installed-app list; other installed apps stay.
// The managed prompt and the self-hosted guide get the same text. Without it,
// entry 6 and the installed-app list are the historical ones (the snapshots
// pin their bytes).
import { buildRaftCliGuideMarkdown, buildRaftCliGuideSections } from "./raftCliGuide";

const INSTALLED = [
  { name: "Raft Artifacts", description: "Versioned pages with comments.", whenToUse: "Publish a page that gets feedback.", service: "artifact-share" },
  { name: "Sentinel", description: "Watches deploys.", whenToUse: "Check a deploy.", service: "sentinel-abc" },
  // From an older Server, which sends no service id: nothing to match, so it stays.
  { name: "Ledger", description: "Books expenses.", whenToUse: "File an expense." },
];
const identity = { handle: "alice", displayName: "Alice" };

function communication(enabledApps: string[]): string {
  return buildRaftCliGuideSections({ audience: "managed-runner", identity, installedApps: INSTALLED, enabledApps }).communication;
}

test("artifacts on: entry 6 has the attachment and Artifact commands, no entry after the fixed ones, and no artifact-share anywhere", () => {
  const text = communication(["artifacts"]);
  const entry6 = text.match(/\n6\. [^\n]*/u)![0];
  expect(entry6).toMatch(/^\n6\. \*\*Attachments and Raft Artifacts\*\* — `raft attachment upload`, `raft attachment view` /u);
  expect(entry6).toContain("goes in a Raft Artifact instead. `raft artifact push <dir> --target <conversation> --title <title>` makes one");
  expect(entry6).toContain("Other commands: `raft artifact list`, ");
  expect(entry6).toContain("`raft artifact save`");
  expect(text).not.toMatch(/\n18\. /u);
  expect(text).not.toContain("**Artifacts** —");
  expect(text).not.toContain("artifact-share");
  expect(text).not.toContain("Raft Artifacts (service");
  expect(text).toContain("Sentinel (service `sentinel-abc`)");
  expect(text).toContain("- Ledger — Books expenses.");
});

test("artifacts off: entry 6 names only `raft artifact --help` and not the artifact-share App; the installed list keeps it", () => {
  for (const enabledApps of [[], ["future-app"]]) {
    const text = communication(enabledApps);
    const entry6 = text.match(/\n6\. [^\n]*/u)![0];
    expect(text.replaceAll("`raft artifact --help`", "")).not.toContain("raft artifact");
    expect(entry6).toContain("`raft artifact --help` lists its commands; if your CLI has none, attach the file, and each revision as a new attachment in the same thread. Details: the `artifact` and `attachment` Manual topics.");
    expect(entry6).not.toContain("artifact-share");
    expect(text).toContain("Raft Artifacts (service `artifact-share`)");
  }
});

test("the self-hosted guide gets the same Artifacts text", () => {
  const managed = communication(["artifacts"]);
  const selfHosted = buildRaftCliGuideMarkdown(undefined, { enabledApps: ["artifacts"] });
  const entry6 = managed.match(/\n6\. \*\*Attachments and Raft Artifacts\*\*[^\n]*/u)![0];
  expect(entry6).toContain("raft artifact list");
  expect(selfHosted).toContain(entry6);
  expect(selfHosted).not.toMatch(/\n18\. /u);
});
