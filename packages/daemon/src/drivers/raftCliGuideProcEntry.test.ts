// The `raft proc` entry (#proj-raft-computer:#114): in the command list only
// for a managed runner whose daemon runs jobs (`procJobs`, `proc@1`; not on
// Windows in v1), as the last entry. Elsewhere `raft proc` refuses, so the
// prompt keeps its historical text; the self-hosted guide and the manual topic
// never carry it.
import { buildRaftCliGuideMarkdown, buildRaftCliGuideSections, buildRaftCliOverviewMdx, PROC_COMMANDS_ENTRY } from "./raftCliGuide";
import { buildCliTransportSystemPrompt } from "./cliTransport";
import { daemonRunsProcJobs } from "../procJobs";
import { promptConfig } from "../testing/promptFixture";

const identity = { handle: "alice", displayName: "Alice" };

function communication(options: { procJobs?: boolean; agentContextView?: boolean; enabledApps?: string[]; audience?: "managed-runner" | "self-hosted-runner" }): string {
  return buildRaftCliGuideSections({ audience: "managed-runner", identity, ...options }).communication;
}

/** The numbers of the command list's entries, in order. */
function entryNumbers(text: string): number[] {
  return [...text.matchAll(/^(\d+)\. \*\*/gmu)].map((match) => Number(match[1]));
}

test("on: the proc entry is the command list's last entry, numbered after the fixed ones", () => {
  const text = communication({ procJobs: true });
  expect(text).toContain(`\n18. ${PROC_COMMANDS_ENTRY}`);
  expect(PROC_COMMANDS_ENTRY).toMatch(/^\*\*Background jobs\*\* — `raft proc start`, `raft proc list`, `raft proc logs`, `raft proc stop`\./u);
  expect(PROC_COMMANDS_ENTRY).toContain("the `proc` Manual topic");
});

test("on: the proc entry follows the apps' and the context entries, numbers consecutive", () => {
  for (const enabledApps of [[], ["artifacts"]])
  for (const agentContextView of [false, true]) {
    const text = communication({ procJobs: true, agentContextView, enabledApps });
    const numbers = entryNumbers(text);
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
    expect(text).toContain(`\n${numbers.at(-1)}. ${PROC_COMMANDS_ENTRY}`);
  }
});

test("off or absent: no proc entry, and the text is the historical one", () => {
  const absent = communication({});
  expect(communication({ procJobs: false })).toBe(absent);
  expect(absent).not.toContain("raft proc");
});

test("self-hosted runners and the manual topic never get the proc entry", () => {
  expect(communication({ audience: "self-hosted-runner", procJobs: true })).toBe(communication({ audience: "self-hosted-runner" }));
  expect(communication({ audience: "self-hosted-runner", procJobs: true })).not.toContain("raft proc");
  expect(buildRaftCliGuideMarkdown()).not.toContain("raft proc");
  expect(buildRaftCliOverviewMdx()).not.toContain("raft proc");
});

test("the daemon's prompt carries the entry where it runs jobs, and only there", () => {
  expect(daemonRunsProcJobs("linux")).toBe(true);
  expect(daemonRunsProcJobs("darwin")).toBe(true);
  expect(daemonRunsProcJobs("win32")).toBe(false);
  const prompt = String(buildCliTransportSystemPrompt(promptConfig(), { extraCriticalRules: [] }));
  if (daemonRunsProcJobs()) expect(prompt).toContain(PROC_COMMANDS_ENTRY);
  else expect(prompt).not.toContain("raft proc");
  expect(String(buildCliTransportSystemPrompt(promptConfig(), { extraCriticalRules: [], procJobs: false }))).not.toContain("raft proc");
});
