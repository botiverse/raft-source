import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PROFILE_DESCRIPTION_MAX_LENGTH } from "@botiverse/raft-shared";
import AgentProfileEditDialog from "../src/components/agent/AgentProfileEditDialog";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";
import { TestIntlProvider } from "./helpers/intl";

// A new or changed agent description is at most 300 characters; one saved
// under the older 3000 limit stays as it is (the counter reads e.g. 412/300,
// no error) until the person edits it, and then the limit applies.

const LEGACY = "x".repeat(412);
const TOO_LONG = "Description must be 300 characters or fewer.";

function agent(description: string | null): Agent {
  return {
    id: "agent-1", serverId: "server-1", name: "sage", displayName: "Sage", avatarUrl: null, description, status: "active",
    model: "gpt-5.2", runtime: "codex", reasoningEffort: null, executionMode: "cloud", envVars: null,
    machineId: null, creatorType: null, creatorId: null, creator: null, createdAgents: [], deletedAt: null,
    createdAt: new Date(0).toISOString(),
  } as Agent;
}

const originalUpdateAgent = useAgentStore.getState().updateAgent;
let saved: Array<Record<string, unknown>> = [];

beforeEach(() => {
  saved = [];
  useAgentStore.setState({
    updateAgent: (async (_id: string, fields: Record<string, unknown>) => {
      saved.push(fields);
      return null;
    }) as unknown as typeof originalUpdateAgent,
  });
});

afterEach(() => {
  cleanup();
  useAgentStore.setState({ updateAgent: originalUpdateAgent });
});

function open(description: string | null) {
  render(
    <TestIntlProvider>
      <AgentProfileEditDialog agent={agent(description)} open field="description" onClose={() => {}} roleOptions={[]} />
    </TestIntlProvider>,
  );
  return {
    textarea: screen.getByTestId("agent-profile-edit-description") as HTMLTextAreaElement,
    save: screen.getByTestId("agent-profile-edit-save") as HTMLButtonElement,
  };
}

test("an unchanged over-long description shows its count and no error; once edited the 300 limit applies", async () => {
  const { textarea, save } = open(LEGACY);
  assert.equal(PROFILE_DESCRIPTION_MAX_LENGTH, 300);
  assert.ok(screen.getByText(`412/${PROFILE_DESCRIPTION_MAX_LENGTH}`));
  assert.ok(screen.queryByText(TOO_LONG) === null, "unchanged: not refused");
  assert.ok(screen.getByText("A sentence or two on who it is and what it does. Tell it longer instructions in a message."));

  fireEvent.change(textarea, { target: { value: `${LEGACY}!` } });
  assert.ok(screen.getByText(TOO_LONG), "changed and over the limit: refused with the existing message");
  assert.ok(screen.getByText("413/300"));
  assert.equal(save.disabled, true);

  const fits = "y".repeat(PROFILE_DESCRIPTION_MAX_LENGTH);
  fireEvent.change(textarea, { target: { value: fits } });
  assert.ok(screen.queryByText(TOO_LONG) === null, "fits: no error");
  assert.equal(save.disabled, false);
  await act(async () => {
    fireEvent.click(save);
  });
  assert.deepEqual(saved, [{ description: fits }]);
});

test("a new description over 300 is refused", () => {
  const { textarea, save } = open(null);
  fireEvent.change(textarea, { target: { value: "z".repeat(PROFILE_DESCRIPTION_MAX_LENGTH + 1) } });
  assert.ok(screen.getByText(TOO_LONG));
  assert.equal(save.disabled, true);
});
