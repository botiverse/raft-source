import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, screen, waitFor } from "@testing-library/react";
import type { SkillInfo } from "@botiverse/raft-shared";
import api from "../src/api/client";
import AgentSkills from "../src/components/agent/AgentSkills";
import { en } from "../src/i18n/messages/en";
import { renderWithIntl } from "./helpers/intl";

// The agent's Skills section draws the Computer's built-in list (skills the
// runtime ships, read through OAR) as its own group before Global and
// Workspace; a server or Computer that sends none draws the two groups as before.

const skill = (name: string, sourcePath?: string): SkillInfo => ({
  name,
  displayName: name,
  description: `${name} skill`,
  userInvocable: true,
  ...(sourcePath ? { sourcePath } : {}),
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function groupLabels(): string[] {
  return [en["agent.skills.builtin"], en["agent.skills.global"], en["agent.skills.workspace"]]
    .filter((label) => screen.queryByText(label) !== null);
}

test("a built-in list is drawn first, without a folder line for skills that have none", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({
    data: {
      global: [skill("review", "~/.claude/skills")],
      workspace: [skill("deploy", "~/agent/.claude/skills")],
      builtin: [skill("simplify")],
      state: "ok",
    },
  }) as never);
  renderWithIntl(<AgentSkills agentId="agent-1" embedded />);
  await waitFor(() => assert.ok(screen.queryByText("simplify")));
  assert.deepEqual(groupLabels(), [en["agent.skills.builtin"], en["agent.skills.global"], en["agent.skills.workspace"]]);
  // Drawn in this order on the page.
  const labels = screen.getAllByText(/^(Built-in|Global|Workspace)$/).map((node) => node.textContent);
  assert.deepEqual(labels, ["Built-in", "Global", "Workspace"]);
  assert.ok(screen.queryByText("unknown") === null, "no placeholder folder line for built-in skills");
  assert.ok(screen.queryByText("~/.claude/skills") !== null, "other groups keep their folder line");
});

test("an older server (no builtin) or a malformed one draws Global and Workspace only", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({
    data: { global: [skill("review", "~/.claude/skills")], workspace: [], builtin: "nope" },
  }) as never);
  renderWithIntl(<AgentSkills agentId="agent-1" embedded />);
  await waitFor(() => assert.ok(screen.queryByText("review")));
  assert.deepEqual(groupLabels(), [en["agent.skills.global"]]);
});
