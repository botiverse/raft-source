// The `raft context` entry (`agent_context_view_v0`): in the command list only
// where View Context is on for the server, numbered after the enabled apps'
// entries. Off (or an older Server that sends no flag), the prompt keeps its
// historical text: elsewhere `raft context` always refuses.
import { buildRaftCliGuideSections, CONTEXT_COMMANDS_ENTRY } from "./raftCliGuide";

const identity = { handle: "alice", displayName: "Alice" };

function communication(options: { agentContextView?: boolean; enabledApps?: string[] }): string {
  return buildRaftCliGuideSections({ audience: "managed-runner", identity, ...options }).communication;
}

test("on: the context entry follows the fixed entries", () => {
  const text = communication({ agentContextView: true });
  expect(text).toContain(`\n18. ${CONTEXT_COMMANDS_ENTRY}`);
  expect(CONTEXT_COMMANDS_ENTRY).toMatch(/^\*\*Context\*\* — `raft context search`, `raft context read`\./u);
});

test("on: the context entry is numbered after the enabled apps' entries", () => {
  // Artifacts takes entry 6 rather than a numbered entry of its own.
  expect(communication({ agentContextView: true, enabledApps: ["artifacts"] })).toContain(`\n18. ${CONTEXT_COMMANDS_ENTRY}`);
});

test("off or absent: no context entry, and the text is the historical one", () => {
  const absent = communication({});
  expect(communication({ agentContextView: false })).toBe(absent);
  expect(absent).not.toContain("raft context");
});
