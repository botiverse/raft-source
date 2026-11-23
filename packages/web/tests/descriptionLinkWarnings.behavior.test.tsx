import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { DescriptionLinkWarning } from "@botiverse/raft-shared";
import api from "../src/api/client";
import AgentProfileEditDialog from "../src/components/agent/AgentProfileEditDialog";
import { DescriptionLinkWarnings } from "../src/components/message/DescriptionLinkWarnings";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { renderWithIntl } from "./helpers/intl";

// #457: a saved description whose links some of its readers can't open. The
// save succeeds; the dialog stays open on the warnings (every fix, the whole
// server last) until closed; the stores keep `warnings` off the saved agent
// and user and hand them to the caller.

const LINK = "https://app.raft.build/artifacts/TUCt9hmScMEdBpHaTXatxr";
const warning: DescriptionLinkWarning = { code: "conversation", url: LINK, object: { kind: "artifact", id: "pt_x" }, fixes: ["(agent text, not shown)"] };
const agent = { id: "agent-1", name: "remy", displayName: "Remy", description: "Old", avatarUrl: null, serverRole: "member" } as unknown as Agent;

const noop = () => {};
const IN_TWO_SERVERS: DescriptionLinkWarning[] = [
  { ...warning, server: { id: "a", name: "Alpha" } },
  { ...warning, code: "other_server", server: { id: "b", name: "Beta" } },
];
const NO_ROLES: { id: "admin" | "member"; label: string }[] = [];
const initialAgents = useAgentStore.getInitialState();
const initialAuth = useAuthStore.getInitialState();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAgentStore.setState(initialAgents, true);
  useAuthStore.setState(initialAuth, true);
});

test("the agent's description dialog saves, then shows the link warnings with every fix until closed; the stored agent has no warnings", async () => {
  useAgentStore.setState({ agents: [agent] });
  const description = `My list: ${LINK}`;
  vi.spyOn(api, "patch").mockResolvedValue({ data: { ...agent, description, warnings: [warning] } });
  const onClose = vi.fn();
  renderWithIntl(<AgentProfileEditDialog agent={agent} open field="description" onClose={onClose} roleOptions={NO_ROLES} />);

  fireEvent.change(screen.getByTestId("agent-profile-edit-description"), { target: { value: description } });
  fireEvent.click(screen.getByTestId("agent-profile-edit-save"));

  const notice = await screen.findByTestId("description-link-warnings");
  assert.equal(onClose.mock.calls.length, 0, "stays open on the warnings");
  assert.match(notice.textContent ?? "", /A link in this description can't be opened by everyone who can see it/);
  assert.match(notice.textContent ?? "", new RegExp(`${LINK.replace(/[./]/g, "\\$&")} is shared only in one conversation`));
  const fixes = [...notice.querySelectorAll("ul ul li")].map((item) => item.textContent ?? "");
  assert.equal(fixes.length, 3, "an agent's description is read by its server: no 'anyone with the link'");
  assert.match(fixes[0]!, /publish a separate version.*make it visible to everyone in the server/);
  assert.match(fixes[2]!, /whole server.*Everyone in the server will be able to see all of its contents/);
  assert.ok(fixes.every((fix) => !fix.includes("Anyone with the link")));
  assert.ok(!(notice.textContent ?? "").includes("(agent text, not shown)"), "the web words the fixes itself");
  assert.match(notice.textContent ?? "", /The agent's description is shown to everyone in this server/, "an agent's description: its server only");

  const stored = useAgentStore.getState().agents[0]!;
  assert.equal(stored.description, description, "saved");
  assert.equal("warnings" in stored, false);

  fireEvent.click(screen.getByTestId("agent-profile-edit-done"));
  assert.equal(onClose.mock.calls.length, 1);
});

test("without warnings the dialog closes on save as before", async () => {
  useAgentStore.setState({ agents: [agent] });
  vi.spyOn(api, "patch").mockResolvedValue({ data: { ...agent, description: "Plain" } });
  const onClose = vi.fn();
  renderWithIntl(<AgentProfileEditDialog agent={agent} open field="description" onClose={onClose} roleOptions={NO_ROLES} />);
  fireEvent.change(screen.getByTestId("agent-profile-edit-description"), { target: { value: "Plain" } });
  fireEvent.click(screen.getByTestId("agent-profile-edit-save"));
  await waitFor(() => assert.equal(onClose.mock.calls.length, 1));
  assert.ok(screen.queryByTestId("description-link-warnings") === null, "no notice");
});

test("updateProfile returns the warnings and never stores them on the user", async () => {
  vi.spyOn(api, "patch").mockResolvedValue({ data: { id: "u1", name: "me", description: LINK, warnings: [warning] } });
  const { warnings } = await useAuthStore.getState().updateProfile({ description: LINK });
  assert.deepEqual(warnings, [warning]);
  const user = useAuthStore.getState().user as unknown as Record<string, unknown>;
  assert.equal(user.description, LINK);
  assert.equal("warnings" in user, false);

  vi.spyOn(api, "patch").mockResolvedValue({ data: { id: "u1", name: "me", description: "x" } });
  assert.deepEqual((await useAuthStore.getState().updateProfile({ description: "x" })).warnings, []);
});

test("a person's link warned of in two servers is one link: one entry, each server's sentence, each fix once", () => {
  renderWithIntl(<DescriptionLinkWarnings warnings={IN_TWO_SERVERS} owner="person" onDismiss={noop} />);
  const notice = screen.getByTestId("description-link-warnings");
  assert.match(notice.textContent ?? "", /^Saved\. A link in this description can't be opened/);
  const entries = screen.getAllByTestId("description-link-warning");
  assert.equal(entries.length, 1);
  assert.match(entries[0]!.textContent ?? "", /people in Alpha outside it can't open it/);
  assert.match(entries[0]!.textContent ?? "", /people in Beta who can see this description can't open it/);
  assert.equal(entries[0]!.querySelectorAll("ul li").length, 4, "each fix once");
  assert.match(notice.textContent ?? "", /change who can see it to everyone in the server/);
  assert.match(notice.textContent ?? "", /shown to everyone who can see you/);
});
