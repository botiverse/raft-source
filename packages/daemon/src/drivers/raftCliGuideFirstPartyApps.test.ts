// First-party apps' command-list entries (first-party app mechanism §七):
// rendered from `enabledApps` in the guide's own table order, unknown ids
// skipped, and nothing at all for an absent or empty list. The ordering and
// skip rules run against a test-only table (the shipped one carries product
// text); the byte-identity checks run against the shipped table.
import {
  FIRST_PARTY_APP_GUIDE_ENTRIES,
  buildRaftCliGuideMarkdown,
  buildRaftCliGuideSections,
  enabledFirstPartyAppGuideEntries,
  renderFirstPartyAppCommandEntries,
  type FirstPartyAppGuideEntry,
} from "./raftCliGuide";
import { buildCliSystemPrompt } from "./systemPrompt";
import { promptConfig } from "../testing/promptFixture";

const TABLE: readonly FirstPartyAppGuideEntry[] = [
  { appId: "alpha", commands: "**Alpha (test)** — `raft alpha list`.", commandsVersion: 1 },
  { appId: "beta", commands: "**Beta (test)** — `raft beta list`.", commandsVersion: 1 },
  { appId: "gamma", commands: "**Gamma (test)** — `raft gamma list`.", commandsVersion: 1 },
];

test("entries follow the table's order, whatever the order of enabledApps", () => {
  const expected = ["alpha", "gamma"];
  for (const enabledApps of [["alpha", "gamma"], ["gamma", "alpha"], ["gamma", "alpha", "gamma"]]) {
    expect(enabledFirstPartyAppGuideEntries(enabledApps, TABLE).map((entry) => entry.appId)).toEqual(expected);
  }
  expect(renderFirstPartyAppCommandEntries(["gamma", "beta", "alpha"], TABLE)).toBe(
    "\n18. **Alpha (test)** — `raft alpha list`."
    + "\n19. **Beta (test)** — `raft beta list`."
    + "\n20. **Gamma (test)** — `raft gamma list`.",
  );
});

test("app entries are numbered right after the command list's last fixed entry", () => {
  // The first app number comes from a constant; this ties it to the list, so
  // a fixed entry added later can't share a number with an app's.
  const firstAppNumber = Number(/^\n(\d+)\. /.exec(renderFirstPartyAppCommandEntries(["alpha"], TABLE))?.[1]);
  for (const audience of ["managed-runner", "self-hosted-runner"] as const)
  for (const taskConversations of [false, true]) {
    const { communication } = buildRaftCliGuideSections({ audience, identity: { handle: "alice", displayName: "Alice" }, taskConversations, shell: "posix" });
    const numbers = [...communication.matchAll(/^(\d+)\. \*\*/gm)].map((match) => Number(match[1]));
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, at) => at + 1));
    expect(firstAppNumber).toBe(numbers.length + 1);
  }
});

test("ids without an entry are skipped and take no number", () => {
  expect(renderFirstPartyAppCommandEntries(["zeta", "beta", "artifacts"], TABLE)).toBe(
    "\n18. **Beta (test)** — `raft beta list`.",
  );
  expect(renderFirstPartyAppCommandEntries(["zeta"], TABLE)).toBe("");
});

test("the entry that is entry 6 takes no number after the fixed ones; a second such entry keeps its own", () => {
  const delta = { appId: "delta", commands: "**Delta (test)** — `raft delta list`.", commandsVersion: 1, replacesAttachmentsEntry: true };
  const epsilon = { appId: "epsilon", commands: "**Epsilon (test)** — `raft epsilon list`.", commandsVersion: 1, replacesAttachmentsEntry: true };
  const table = [...TABLE, delta, epsilon];
  expect(renderFirstPartyAppCommandEntries(["delta", "beta"], table)).toBe("\n18. **Beta (test)** — `raft beta list`.");
  expect(renderFirstPartyAppCommandEntries(["delta"], table)).toBe("");
  expect(renderFirstPartyAppCommandEntries(["epsilon", "delta"], table)).toBe("\n18. **Epsilon (test)** — `raft epsilon list`.");
});

test("an absent or empty enabledApps renders nothing", () => {
  expect(renderFirstPartyAppCommandEntries(undefined, TABLE)).toBe("");
  expect(renderFirstPartyAppCommandEntries([], TABLE)).toBe("");
});

test("the shipped table names each app once", () => {
  const ids = FIRST_PARTY_APP_GUIDE_ENTRIES.map((entry) => entry.appId);
  expect(new Set(ids).size).toBe(ids.length);
  for (const entry of FIRST_PARTY_APP_GUIDE_ENTRIES) expect(entry.commands).not.toContain("\n");
  // Entry 6 is one app's at a time: a second would render as its own entry.
  expect(FIRST_PARTY_APP_GUIDE_ENTRIES.filter((entry) => entry.replacesAttachmentsEntry).length).toBeLessThanOrEqual(1);
});

// Every existing combination of the guide's inputs renders the same bytes
// with enabledApps absent, empty, or listing ids (known or not) that have no
// entry in the shipped table. The historical bytes themselves are pinned by
// the systemPrompt snapshots and the raft-cli-overview freshness gate.
const UNENTERED = ["future-app", "artifacts"].filter(
  (id) => !FIRST_PARTY_APP_GUIDE_ENTRIES.some((entry) => entry.appId === id),
);
const VARIANTS: readonly (readonly string[])[] = [[], UNENTERED, [...UNENTERED].reverse()];
const FLAGS = [undefined, false, true] as const;

test("the guide sections are unchanged by enabledApps without a shipped entry", () => {
  for (const audience of ["managed-runner", "self-hosted-runner"] as const)
  for (const reminderApp of FLAGS) for (const vaultApp of FLAGS) for (const taskConversations of FLAGS)
  for (const shell of ["posix", "powershell"] as const) {
    const base = { audience, identity: { handle: "alice", displayName: "Alice" }, reminderApp, vaultApp, taskConversations, shell };
    const historical = buildRaftCliGuideSections(base);
    for (const enabledApps of VARIANTS) expect(buildRaftCliGuideSections({ ...base, enabledApps })).toEqual(historical);
  }
});

test("the self-hosted guide and the manual are unchanged by enabledApps without a shipped entry", () => {
  const identity = { handle: "ext", displayName: "Ext", description: "Reviews", serverName: "Acme", serverRole: "member" };
  for (const who of [undefined, identity]) for (const taskConversations of FLAGS) {
    const historical = buildRaftCliGuideMarkdown(who, { taskConversations });
    for (const enabledApps of VARIANTS) expect(buildRaftCliGuideMarkdown(who, { taskConversations, enabledApps })).toBe(historical);
  }
});

test("the managed standing prompt is unchanged by enabledApps without a shipped entry", () => {
  const installed = [{ name: "Sentinel", description: "d", whenToUse: "w", service: "sentinel-abc" }];
  for (const reminderApp of FLAGS) for (const vaultApp of FLAGS) for (const taskConversations of FLAGS)
  for (const installedApps of [undefined, installed]) for (const commandShell of ["posix", "powershell"] as const) {
    const config = { reminderApp, vaultApp, taskConversations, installedApps };
    const options = { extraCriticalRules: [], commandShell };
    const historical = buildCliSystemPrompt(promptConfig(config), options);
    for (const enabledApps of VARIANTS) {
      expect(buildCliSystemPrompt(promptConfig({ ...config, enabledApps: [...enabledApps] }), options)).toBe(historical);
    }
  }
});
