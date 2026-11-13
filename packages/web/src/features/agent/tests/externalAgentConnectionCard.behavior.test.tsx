import "../../../../tests/helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";

import { AgentDetailPanel } from "../AgentDetailPanel";
import { ExternalAgentConnectionCard } from "../ExternalAgentConnectionCard";
import { externalConnectionState, PAGE_CREDENTIAL_NAME } from "../externalAgentSetup";
import { TestIntlProvider } from "../../../../tests/helpers/intl";
import { useAgentStore } from "../../../store/agentStore";
import type { ExternalAgentStatus } from "../../../store/agentStore";
import { useAuthStore } from "../../../store/authStore";
import { useChannelStore } from "../../../store/channelStore";
import { useMachineStore } from "../../../store/machineStore";
import { useServerStore } from "../../../store/serverStore";
import api from "../../../api/client";
import { en } from "../../../i18n/messages/en";

const AGENT_ID = "external-agent-1";
const NAME = "External Probe";
const CLI = { id: "cred-cli", maskedToken: "sk_agent_aaaa***", name: "MacBook-Pro", createdAt: "2026-11-12T10:00:00Z", lastUsedAt: "2026-11-12T10:05:00Z", revokedAt: null };
const noop = () => undefined;
const PAGE = { id: "cred-page", maskedToken: "sk_agent_bbbb***", name: PAGE_CREDENTIAL_NAME, createdAt: "2026-11-12T11:00:00Z", lastUsedAt: null, revokedAt: null };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

function fmt(id: keyof typeof en, values: Record<string, string> = {}) {
  return Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, value), en[id] as string);
}

function stubCredentials(credentials: unknown[]) {
  return vi.spyOn(api, "get").mockImplementation(async (url: string) => ({ data: { agentId: url.split("/")[2], credentials } }) as never);
}

function renderAgent(status: Partial<ExternalAgentStatus>, { role = "owner", creatorId = "user-1", creator = { id: creatorId, type: "human", name: "olive", displayName: "Olive", avatarUrl: null } as unknown } = {}) {
  const agent = {
    id: AGENT_ID,
    name: "external-probe",
    displayName: NAME,
    runtime: "external",
    status: "idle",
    external: true,
    creatorType: "user",
    creatorId,
    creator,
    deletedAt: null,
    lastRuntimeError: null,
  };
  useAuthStore.setState({ user: { id: "user-1", name: "Owner" } } as never);
  useServerStore.setState({ current: { id: "server-1", slug: "s", name: "S", role }, members: [] } as never);
  useMachineStore.setState({ machines: [] } as never);
  useChannelStore.setState({ openDM: () => undefined } as never);
  useAgentStore.setState({
    agents: [agent],
    agentActivities: {},
    activityLogs: {},
    fetchExternalAgentStatus: async () => ({ setupState: "credential_minted", credentialLastUsedAt: null, lastActivityAt: null, externalSetupMethod: "existing_agent", ...status }),
  } as never);
  return render(createElement(MemoryRouter, { initialEntries: [`/s/s/agent/${AGENT_ID}`] },
    createElement(TestIntlProvider, null, createElement(AgentDetailPanel, { agent: agent as never }))));
}

test("four states: every server state without a sign-in reads as not signed in yet", () => {
  assert.equal(externalConnectionState("waiting_for_login", false), "not_signed_in");
  assert.equal(externalConnectionState("credential_minted", false), "not_signed_in");
  assert.equal(externalConnectionState("login_token_expired", false), "not_signed_in");
  assert.equal(externalConnectionState("connected", true), "online");
  assert.equal(externalConnectionState("connected", false), "offline");
  assert.equal(externalConnectionState("disconnected", false), "disconnected");
});

test("an expired CLI login token shows the waiting line with its steps, not a separate state", async () => {
  stubCredentials([]);
  renderAgent({ setupState: "login_token_expired" });
  const status = await screen.findByTestId("external-agent-status");
  assert.equal(status.getAttribute("data-state"), "not_signed_in");
  assert.ok(within(status).getByText(fmt("agent.createExternal.waiting", { name: NAME })));
  assert.ok(screen.getByTestId("external-agent-steps"));
  assert.ok(screen.getByRole("button", { name: en["agent.externalCard.createCredential"] }));
});

test("disconnected names the agent; connected folds the steps behind How it connects", async () => {
  stubCredentials([CLI]);
  const view = renderAgent({ setupState: "disconnected" });
  assert.ok(await screen.findByText(fmt("agent.externalCard.disconnected", { name: NAME })));
  assert.ok(screen.getByTestId("external-agent-switch"), "disconnected offers the switch");
  view.unmount();
  renderAgent({ setupState: "connected", credentialLastUsedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
  const status = await screen.findByTestId("external-agent-status");
  assert.equal(status.getAttribute("data-state"), "offline");
  // As the Computers page says it, the exact time in the tooltip.
  assert.match(screen.getByTestId("external-agent-status-title").textContent ?? "", /^Offline · last seen .+ ago$/);
  assert.ok(screen.queryByTestId("external-agent-steps") === null, "steps folded");
  fireEvent.click(screen.getByRole("button", { name: en["agent.externalCard.howItConnects"] }));
  assert.ok(screen.getByTestId("external-agent-steps"));
  assert.ok(screen.queryByTestId("external-agent-switch") === null, "no switch link once connected");
});

test("the switch link flips the remembered method with PUT and swaps the steps", async () => {
  stubCredentials([PAGE]);
  const put = vi.spyOn(api, "put").mockResolvedValue({ data: {} } as never);
  renderAgent({ setupState: "credential_minted", externalSetupMethod: "existing_agent" });
  await screen.findByTestId("external-agent-steps");
  assert.equal(screen.getByTestId("external-agent-steps").getAttribute("data-method"), "existing_agent");
  fireEvent.click(screen.getByRole("button", { name: en["agent.createExternal.switchToSdk"] }));
  await waitFor(() => assert.equal(screen.getByTestId("external-agent-steps").getAttribute("data-method"), "sdk"));
  assert.deepEqual(put.mock.calls[0], [`/agents/${AGENT_ID}/external-setup-method`, { method: "sdk" }]);
  assert.ok(screen.getByTestId("external-agent-install"));
});

// Only the credential POSTs: anything else the page posts while it renders is not this card's.
function credentialPosts(post: { mock: { calls: unknown[][] } }): unknown[][] {
  return post.mock.calls.filter((call) => call[0] === `/agents/${AGENT_ID}/credentials`);
}

test("Create new credential replaces only the page's credential, after a warning confirm", async () => {
  stubCredentials([CLI, PAGE]);
  const post = vi.spyOn(api, "post").mockResolvedValue({ data: { agentId: AGENT_ID, credentialId: "cred-new", apiKey: "sk_agent_new-fixture" } } as never);
  renderAgent({ setupState: "credential_minted" });
  await waitFor(() => assert.equal(screen.queryAllByTestId("external-agent-credential-row").length, 2));
  fireEvent.click(await screen.findByRole("button", { name: en["agent.externalCard.createNewCredential"] }));
  const confirm = await screen.findByTestId("external-agent-replace-confirm");
  assert.equal(credentialPosts(post).length, 0, "nothing is made before the confirm");
  assert.match(confirm.className, /warning/);
  fireEvent.click(confirm);
  await waitFor(() => assert.equal(credentialPosts(post).length, 1));
  assert.deepEqual(credentialPosts(post)[0], [`/agents/${AGENT_ID}/credentials`, { name: PAGE_CREDENTIAL_NAME, replacesCredentialId: PAGE.id }]);
  assert.ok(await screen.findByTestId("external-agent-new-credential"));
});

test("a first credential is made without a confirm and replaces nothing", async () => {
  stubCredentials([CLI]);
  const post = vi.spyOn(api, "post").mockResolvedValue({ data: { agentId: AGENT_ID, credentialId: "cred-new", apiKey: "sk_agent_new-fixture" } } as never);
  renderAgent({ setupState: "waiting_for_login" });
  await waitFor(() => assert.equal(screen.queryAllByTestId("external-agent-credential-row").length, 1));
  fireEvent.click(screen.getByRole("button", { name: en["agent.externalCard.createCredential"] }));
  await waitFor(() => assert.equal(credentialPosts(post).length, 1));
  assert.deepEqual(credentialPosts(post)[0], [`/agents/${AGENT_ID}/credentials`, { name: PAGE_CREDENTIAL_NAME }]);
});

test("Revoke asks with a danger confirm, then deletes that credential", async () => {
  stubCredentials([CLI, PAGE]);
  const del = vi.spyOn(api, "delete").mockResolvedValue({ data: {} } as never);
  renderAgent({ setupState: "connected" });
  await waitFor(() => assert.equal(screen.getAllByTestId("external-agent-credential-row").length, 2));
  const cliRow = screen.getAllByTestId("external-agent-credential-row")[0]!;
  fireEvent.click(within(cliRow).getByTestId("external-agent-credential-menu"));
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), [en["agent.externalCard.revoke"]], "a CLI login's credential offers no Create new");
  fireEvent.click(screen.getByRole("menuitem", { name: en["agent.externalCard.revoke"] }));
  const confirm = await screen.findByTestId("external-agent-revoke-confirm");
  assert.match(confirm.className, /danger/);
  fireEvent.click(confirm);
  await waitFor(() => assert.equal(del.mock.calls.length, 1));
  assert.equal(del.mock.calls[0]![0], `/agents/${AGENT_ID}/credentials/${CLI.id}`);
  await waitFor(() => assert.equal(screen.getAllByTestId("external-agent-credential-row").length, 1));
});

test("a member sees credentials for their own agent, never for somebody else's", async () => {
  const get = stubCredentials([CLI]);
  const own = renderAgent({ setupState: "credential_minted" }, { role: "member" });
  assert.ok(await screen.findByTestId("external-agent-credentials"));
  assert.ok(screen.getByRole("button", { name: en["agent.externalCard.createCredential"] }));
  own.unmount();
  get.mockClear();
  renderAgent({ setupState: "credential_minted" }, { role: "member", creatorId: "another-user" });
  await waitFor(() => assert.ok(screen.queryByTestId("external-agent-credentials") === null, "no credentials"));
  assert.ok(screen.queryByRole("button", { name: en["agent.externalCard.createCredential"] }) === null, "no create");
  assert.ok(screen.queryByTestId("external-agent-credential-menu") === null, "no menu");
  assert.ok(!get.mock.calls.some(([url]) => String(url).endsWith("/credentials")), "their credentials are not even asked for");
});

// Today's roles never manage an agent without issuing its credentials (editAgents and issueAgentCredentials go
// together; a creator has both), so the panel never gets here: the card is rendered as it would be.
function renderCardWithoutIssue(creator: unknown) {
  const agent = { id: AGENT_ID, name: "external-probe", displayName: NAME, runtime: "external", external: true, status: "idle", creatorType: creator ? "user" : "agent", creatorId: "someone", creator };
  useAgentStore.setState({ agents: [agent] } as never);
  const status = { setupState: "waiting_for_login", credentialLastUsedAt: null, lastActivityAt: null, externalSetupMethod: "existing_agent" } as const;
  return render(createElement(TestIntlProvider, null,
    createElement(ExternalAgentConnectionCard, { agent: agent as never, status, canIssueCredentials: false, onStatus: noop })));
}

test("someone who manages the agent but can't issue credentials is told to ask its creator", () => {
  const get = stubCredentials([CLI]);
  renderCardWithoutIssue({ id: "u-olive", type: "human", name: "olive", displayName: "Olive", avatarUrl: null });
  assert.equal(screen.getByTestId("external-agent-ask-credential").textContent, fmt("agent.externalCard.askCreator", { name: "Olive" }));
  assert.ok(screen.queryByTestId("external-agent-credentials") === null, "no credentials");
  assert.ok(screen.queryByTestId("external-agent-create-credential") === null, "no create");
  assert.ok(!get.mock.calls.some(([url]) => String(url).endsWith("/credentials")), "not asked for");
});

test("with no person as its creator, the ask names the server's owners and admins", () => {
  stubCredentials([]);
  renderCardWithoutIssue(null);
  assert.equal(screen.getByTestId("external-agent-ask-credential").textContent, en["agent.externalCard.askAdmin"]);
});

test("a new credential's secret shows only until the card goes: a remount shows names and dates, never the secret", async () => {
  const secret = "sk_agent_shown-once-fixture";
  stubCredentials([CLI]);
  vi.spyOn(api, "post").mockResolvedValue({ data: { agentId: AGENT_ID, credentialId: "cred-new", apiKey: secret } } as never);
  const first = renderAgent({ setupState: "waiting_for_login" });
  await waitFor(() => assert.equal(screen.queryAllByTestId("external-agent-credential-row").length, 1));
  fireEvent.click(screen.getByRole("button", { name: en["agent.externalCard.createCredential"] }));
  assert.equal((await screen.findByTestId("external-agent-new-credential")).textContent, secret);
  first.unmount();
  // After a refresh or leaving the page: the list answers masked rows only, and nothing kept the secret.
  stubCredentials([CLI, { ...PAGE, id: "cred-new" }]);
  renderAgent({ setupState: "credential_minted" });
  await waitFor(() => assert.equal(screen.queryAllByTestId("external-agent-credential-row").length, 2));
  assert.ok(screen.queryByTestId("external-agent-new-credential") === null, "no secret field after a remount");
  assert.ok(!document.body.innerHTML.includes(secret), "the secret is nowhere on the page");
  assert.ok(!JSON.stringify(useAgentStore.getState()).includes(secret), "no store kept it");
  assert.ok(!JSON.stringify({ ...localStorage }).includes(secret) && !JSON.stringify({ ...sessionStorage }).includes(secret), "no browser storage kept it");
});
