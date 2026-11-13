import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { toast } from "@botiverse/raft-ui";

import api from "../src/api/client";
import { AgentConnections } from "../src/components/agent/AgentConnections";
import AgentConnectionCallbackPage, { describeAgentConnectionCallback } from "../src/pages/AgentConnectionCallbackPage";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SERVER = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";

const initialAuthState = useAuthStore.getState();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.setState(initialAuthState, true);
  useServerStore.setState({ current: null, servers: [], members: [] } as never);
});

function callbackSearch(params: Record<string, string>) {
  return `?${new URLSearchParams({ connection: "github", serverId: SERVER, agentId: AGENT, ...params })}`;
}

function renderCallback(search: string) {
  useAuthStore.setState({ user: { id: ME } } as never);
  useServerStore.setState({ current: null, servers: [{ id: SERVER, slug: "acme", name: "Acme" }], members: [] } as never);
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[`/connections/callback${search}`]}>
        <Routes>
          <Route path="/connections/callback" element={<AgentConnectionCallbackPage />} />
        </Routes>
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

test("the callback view binds the flow to the signed-in user", () => {
  assert.equal(describeAgentConnectionCallback(callbackSearch({ status: "pending", pending: "p1", by: OTHER }), ME).kind, "foreign");
  assert.equal(describeAgentConnectionCallback(callbackSearch({ status: "pending", pending: "p1" }), ME).kind, "foreign", "missing by");
  assert.equal(describeAgentConnectionCallback(callbackSearch({ status: "pending", pending: "p1", by: ME }), null).kind, "foreign", "signed out");
  assert.deepEqual(describeAgentConnectionCallback(callbackSearch({ status: "pending", pending: "p1", by: ME }), ME), {
    kind: "pending", pending: "p1", provider: "github", serverId: SERVER, agentId: AGENT,
  });
  assert.equal(describeAgentConnectionCallback(callbackSearch({ status: "pending", by: ME }), ME).kind, "failed", "pending without id");
  assert.equal(describeAgentConnectionCallback(callbackSearch({ status: "connected", by: ME }), ME).kind, "failed", "no unconfirmed success");
  assert.equal(describeAgentConnectionCallback(callbackSearch({ status: "denied", by: ME }), ME).kind, "denied");
  assert.equal(describeAgentConnectionCallback("?connection=gitlab&status=pending", ME).kind, "invalid");
  for (const id of Object.keys(en).filter((key) => key.startsWith("agent.detail.connections.") || key.startsWith("pages.agentConnectionCallback."))) {
    assert.ok(zh[id], `${id} has a zh-cn translation`);
  }
});

test("a flow started by another user is never confirmed and advises disconnect if the agent is connected", async () => {
  const post = vi.spyOn(api, "post").mockImplementation(async () => ({ data: {} }) as never);
  const get = vi.spyOn(api, "get").mockImplementation(async () => ({
    data: { provider: "github", supported: true, connected: true, account: "octocat", connectedAt: null, connectedBy: null, scopes: [] },
  }) as never);
  renderCallback(callbackSearch({ status: "pending", pending: "p1", by: OTHER }));
  assert.equal(screen.getByTestId("agent-connection-callback-message").textContent, en["pages.agentConnectionCallback.foreign"]);
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-callback-disconnect-advice")));
  assert.equal(post.mock.calls.length, 0, "no confirm call for someone else's flow");
  assert.equal(get.mock.calls[0]?.[0], `/agents/${AGENT}/connections/github`);
});

test("the initiating user confirms the pending id once, for the agent's server", async () => {
  const post = vi.spyOn(api, "post").mockImplementation(async () => ({
    data: { provider: "github", supported: true, connected: true, account: "octocat", connectedAt: null, connectedBy: null, scopes: [] },
  }) as never);
  renderCallback(callbackSearch({ status: "pending", pending: "p1", by: ME }));
  await waitFor(() => assert.match(screen.getByTestId("agent-connection-callback-message").textContent ?? "", /octocat/));
  assert.equal(post.mock.calls.length, 1);
  const [path, body, config] = post.mock.calls[0]!;
  assert.equal(path, `/agents/${AGENT}/connections/github/confirm`);
  assert.deepEqual(body, { pending: "p1" });
  assert.deepEqual((config as { headers: Record<string, string> }).headers, { "X-Server-Id": SERVER });
  assert.ok(screen.getByRole("link", { name: en["pages.agentConnectionCallback.backToAgent"] }).getAttribute("href")?.endsWith(`/s/acme/agent/${AGENT}`));
});

function codedRefusal(status: number, code: string, error = "Raft's sentence for this refusal") {
  return Object.assign(new Error(String(status)), { response: { status, data: { error, code, errorCode: code } } });
}

test("pending_invalid at confirm: the link expired, start again from the agent's profile", async () => {
  vi.spyOn(api, "post").mockImplementation(async () => { throw codedRefusal(404, "agent_connection_pending_invalid"); });
  renderCallback(callbackSearch({ status: "pending", pending: "p1", by: ME }));
  await waitFor(() => assert.equal(screen.getByTestId("agent-connection-callback-message").textContent, en["pages.agentConnectionCallback.expired"]));
  assert.equal(screen.getByTestId("agent-connection-callback-page").getAttribute("data-confirm"), "expired");
  screen.getByRole("link", { name: en["pages.agentConnectionCallback.backToAgent"] });
  assert.ok(screen.queryByTestId("agent-connection-callback-reconnect") === null);
});

test("connector_not_found at confirm (#13136): the connection is gone from the list, not a link that expired", async () => {
  vi.spyOn(api, "post").mockImplementation(async () => { throw codedRefusal(404, "agent_connection_connector_not_found"); });
  renderCallback(callbackSearch({ status: "pending", pending: "p1", by: ME }));
  await waitFor(() => assert.equal(screen.getByTestId("agent-connection-callback-page").getAttribute("data-confirm"), "connector_gone"));
  assert.equal(screen.getByTestId("agent-connection-callback-message").textContent, en["pages.agentConnectionCallback.connectorGone"]);
  assert.ok(!document.body.textContent?.includes(en["pages.agentConnectionCallback.expired"]!));
  screen.getByRole("link", { name: en["pages.agentConnectionCallback.backToAgent"] });
});

test("account_mismatch at confirm: nothing changed, sign in as the connection's account, then Reconnect from the agent's page", async () => {
  vi.spyOn(api, "post").mockImplementation(async (path) => {
    if (String(path).endsWith("/confirm")) throw codedRefusal(409, "agent_connection_account_mismatch");
    throw new Error(`unexpected POST ${String(path)}`);
  });
  renderCallback(callbackSearch({ status: "pending", pending: "p1", by: ME }));
  await waitFor(() => assert.equal(screen.getByTestId("agent-connection-callback-page").getAttribute("data-confirm"), "account_mismatch"));
  assert.equal(screen.getByTestId("agent-connection-callback-message").textContent, en["pages.agentConnectionCallback.accountMismatch"]);
  // This page does not know which connection was being reconnected, so it starts no flow (that would make a
  // new connection); the agent's page Reconnects that connection in place.
  assert.ok(screen.queryByTestId("agent-connection-callback-reconnect") === null);
  screen.getByRole("link", { name: en["pages.agentConnectionCallback.backToAgent"] });
});

test("connector_forbidden at confirm: only the creator or an owner/admin can reconnect it", async () => {
  vi.spyOn(api, "post").mockImplementation(async () => { throw codedRefusal(403, "agent_connection_connector_forbidden"); });
  renderCallback(callbackSearch({ status: "pending", pending: "p1", by: ME }));
  await waitFor(() => assert.equal(screen.getByTestId("agent-connection-callback-message").textContent, en["pages.agentConnectionCallback.forbidden"]));
  assert.ok(screen.queryByTestId("agent-connection-callback-reconnect") === null);
});

const AGENT_NAME = "Atlas";

function renderSection() {
  return render(<TestIntlProvider><AgentConnections agentId={AGENT} agentName={AGENT_NAME} /></TestIntlProvider>);
}

function fmt(id: string, values: Record<string, string> = {}) {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), en[id]!);
}

const NOT_CONNECTED = { provider: "github", supported: true, connected: false, account: null, connectedAt: null, connectedBy: null, scopes: [] };

function stateChip() {
  return screen.getByTestId("agent-connection-github-state");
}

async function openActionsMenu() {
  fireEvent.click(screen.getByTestId("agent-connection-github-menu"));
  await screen.findAllByRole("menuitem");
  return screen.getAllByRole("menuitem").map((item) => item.textContent);
}

async function chooseMenuItem(name: string) {
  if (!screen.queryAllByRole("menuitem").length) await openActionsMenu();
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

test("#proj-assistant:#23: only the agent's owner is offered a new connection", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({
    data: { provider: "github", supported: true, connected: false, account: null, connectedAt: null, connectedBy: null, scopes: [], connectorId: null, connectors: [], canConnectNew: false },
  }) as never);
  renderSection();
  await waitFor(() => assert.equal(screen.getByTestId("agent-connection-github-owner-only").textContent, en["agent.detail.connections.ownerOnly"]));
  assert.ok(screen.queryByRole("button", { name: en["agent.detail.connections.connectNew"] }) === null);
});

test("#proj-assistant:#23: an unassignable current connection is cleared after confirming, with no Undo that would be refused", async () => {
  const connector = { id: "ctr_other", account: "TennyZhuang", createdAt: null, creator: null, current: true, canManage: true, assignable: false };
  vi.spyOn(api, "get").mockImplementation(async () => ({
    data: { provider: "github", supported: true, connected: true, account: "TennyZhuang", connectedAt: null, connectedBy: null, scopes: [], connectorId: "ctr_other", connectors: [connector], canConnectNew: true },
  }) as never);
  const del = vi.spyOn(api, "delete").mockImplementation(async () => ({ data: undefined, status: 204 }) as never);
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-menu")));
  await openActionsMenu();
  await chooseMenuItem(fmt("agent.detail.connections.detach", { agent: AGENT_NAME }));
  assert.equal(del.mock.calls.length, 0, "asks first: there is no Undo for a connection it can't be given back");
});

test("not connected: a Not Connected chip, what the connection is for, and one Connect New Account action", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: NOT_CONNECTED }) as never);
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github")));
  assert.equal(stateChip().getAttribute("data-state"), "not_connected");
  assert.equal(stateChip().textContent, en["agent.detail.connections.statusNotConnected"]);
  assert.ok(screen.getByText(fmt("agent.detail.connections.purpose", { agent: AGENT_NAME })));
  assert.equal(screen.getAllByRole("button", { name: en["agent.detail.connections.connectNew"] }).length, 1);
  assert.ok(screen.queryByTestId("agent-connection-github-menu") === null, "nothing to remove or disconnect");
  assert.ok(screen.queryByRole("checkbox") === null, "the private-repos choice lives in the connect dialog");
});

test("Connect New Account asks for repository access in a dialog and sends the matching access param", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: NOT_CONNECTED }) as never);
  const post = vi.spyOn(api, "post").mockImplementation(async () => ({
    data: { url: "https://github.com/login/oauth/authorize?x=1", expiresAt: "2026-09-29T00:10:00.000Z", scopes: ["repo"] },
  }) as never);
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github")));

  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.connectNew"] }));
  const dialog = await screen.findByTestId("agent-connection-connect-dialog");
  assert.match(dialog.textContent ?? "", /public_repo/);
  assert.equal(screen.getByRole("radio", { name: new RegExp(en["agent.detail.connections.accessPublic"]!) }).getAttribute("aria-checked"), "true", "public by default");
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(en["agent.detail.connections.accessPrivate"]!) }));
  fireEvent.click(screen.getByTestId("agent-connection-connect-continue"));
  await waitFor(() => assert.equal(post.mock.calls.length, 1));
  assert.deepEqual(post.mock.calls[0]?.slice(0, 2), [`/agents/${AGENT}/connections/github`, { access: "private" }], "Connect New names no connection");
});

test("Continue with public access sends no access param", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: NOT_CONNECTED }) as never);
  const post = vi.spyOn(api, "post").mockImplementation(async () => ({
    data: { url: "https://github.com/login/oauth/authorize?x=1", expiresAt: "2026-09-29T00:10:00.000Z", scopes: ["public_repo"] },
  }) as never);
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github")));
  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.connectNew"] }));
  await screen.findByTestId("agent-connection-connect-dialog");
  fireEvent.click(screen.getByTestId("agent-connection-connect-continue"));
  await waitFor(() => assert.equal(post.mock.calls.length, 1));
  assert.deepEqual(post.mock.calls[0]?.slice(0, 2), [`/agents/${AGENT}/connections/github`, {}]);
});

test("the Connections section stays hidden when the provider does not support connections", async () => {
  const get = vi.spyOn(api, "get").mockImplementation(async () => ({ data: { provider: "github", supported: false } }) as never);
  renderSection();
  await waitFor(() => assert.equal(get.mock.calls.length, 1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(screen.queryByTestId("agent-connections") === null);
});

const REASON = "github 401: Bad credentials — the gh mount's account was used";
const MOUNT_REASON = "Agent has no github plugin mount; add exactly one.";
const OTHER_REASON = "connector quota exceeded for this tenant";
/** The server's 409 for any provider 4xx, in the refusal envelope: the provider's words under `details`. */
function refusal(status: number, providerCode = "github_bad_credentials", providerMessage = REASON, providerStatus = 401) {
  return Object.assign(new Error(String(status)), {
    response: { status, data: {
      error: providerMessage, code: "agent_connection_provider_refused", errorCode: "agent_connection_provider_refused",
      details: { providerCode, providerMessage, providerStatus },
    } },
  });
}
/** The same refusal from a server before the envelope: the provider's words top-level. */
function legacyRefusal(status: number, providerCode: string, providerMessage: string, providerStatus: number) {
  return Object.assign(new Error(String(status)), {
    response: { status, data: { error: providerMessage, code: "agent_connection_provider_refused", providerCode, providerMessage, providerStatus } },
  });
}
const mountMissing = () => refusal(409, "github_mount_missing", MOUNT_REASON, 409);
const otherRefusal = () => refusal(409, "connector_quota_exceeded", OTHER_REASON, 422);

async function connectAndFail(post: () => never) {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: NOT_CONNECTED }) as never);
  const spy = vi.spyOn(api, "post").mockImplementation(async () => post());
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github")));
  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.connectNew"] }));
  await screen.findByTestId("agent-connection-connect-dialog");
  fireEvent.click(screen.getByTestId("agent-connection-connect-continue"));
  return { banner: await screen.findByTestId("agent-connection-github-error"), post: spy };
}

test("the generic provider refusal shows the provider's sentence and stops: no automatic retry, Retry and Copy Details by hand", async () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const success = vi.spyOn(toast, "success").mockImplementation(() => "toast-id");
  const { banner, post } = await connectAndFail(() => { throw mountMissing(); });
  assert.equal(banner.getAttribute("data-code"), "agent_connection_provider_refused");
  assert.ok((banner.textContent ?? "").includes(MOUNT_REASON), "the provider's sentence, as sent");
  assert.equal(stateChip().getAttribute("data-state"), "not_connected", "a refusal is not Needs reconnecting");
  assert.ok(screen.queryByRole("button", { name: en["agent.detail.connections.reconnect"] }) === null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(post.mock.calls.length, 1, "the attempt stops: nothing is sent again by itself");

  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.copyDetails"] }));
  await waitFor(() => assert.equal(writeText.mock.calls.length, 1));
  assert.equal(writeText.mock.calls[0]?.[0], `409 github_mount_missing: ${MOUNT_REASON}`);
  await waitFor(() => assert.equal(success.mock.calls[0]?.[0], en["agent.detail.connections.detailsCopied"]));

  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.retry"] }));
  await waitFor(() => assert.equal(post.mock.calls.length, 2));
  assert.deepEqual(post.mock.calls[1]?.slice(0, 2), [`/agents/${AGENT}/connections/github`, {}], "Retry repeats the same start");
});

test("the generic refusal never branches on the provider's code: bad credentials read the same, not Needs reconnecting", async () => {
  const { banner } = await connectAndFail(() => { throw refusal(409, "github_bad_credentials", REASON, 401); });
  assert.equal(banner.getAttribute("data-code"), "agent_connection_provider_refused");
  assert.ok((banner.textContent ?? "").includes(REASON));
  assert.equal(stateChip().getAttribute("data-state"), "not_connected");
  assert.ok(screen.queryByRole("button", { name: en["agent.detail.connections.reconnect"] }) === null);
});

test("a server from before the envelope (the provider's words top-level) is read the same", async () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  vi.spyOn(toast, "success").mockImplementation(() => "toast-id");
  const { banner } = await connectAndFail(() => { throw legacyRefusal(409, "github_mount_missing", MOUNT_REASON, 409); });
  assert.ok((banner.textContent ?? "").includes(MOUNT_REASON));
  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.copyDetails"] }));
  await waitFor(() => assert.equal(writeText.mock.calls[0]?.[0], `409 github_mount_missing: ${MOUNT_REASON}`));
});

test("a generic refusal without a sentence falls back to Raft's own words", async () => {
  const { banner } = await connectAndFail(() => {
    throw Object.assign(new Error("409"), { response: { status: 409, data: { code: "agent_connection_provider_refused", details: { providerCode: "x" } } } });
  });
  assert.ok((banner.textContent ?? "").startsWith(en["agent.detail.connections.providerRefusedOther"]!));
  assert.ok(!document.body.textContent?.includes(OTHER_REASON));
});

test("the callback page shows the provider's refusal reason after confirm", async () => {
  vi.spyOn(api, "post").mockImplementation(async () => { throw mountMissing(); });
  renderCallback(callbackSearch({ status: "pending", pending: "p1", by: ME }));
  await waitFor(() => assert.match(screen.getByTestId("agent-connection-callback-message").textContent ?? "", /no github plugin mount/));
});

function agentMissing() {
  return Object.assign(new Error("409"), {
    response: { status: 409, data: { code: "agent_connection_agent_missing_at_provider", details: { providerMessage: "no provisioned agent made from Raft agent x" } } },
  });
}

test("the Connections section warns (instead of hiding) when the agent no longer exists at its provider", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => { throw agentMissing(); });
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connections")));
  assert.equal(screen.getByTestId("agent-connections-agent-missing").textContent, en["agent.detail.connections.agentMissingAtProvider"]);
  assert.ok(screen.queryByTestId("agent-connection-github") === null, "no Connect action");
});

test("Connect switches to the missing-agent warning when the provider no longer knows the agent", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: NOT_CONNECTED }) as never);
  vi.spyOn(api, "post").mockImplementation(async () => { throw agentMissing(); });
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github")));
  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.connectNew"] }));
  await screen.findByTestId("agent-connection-connect-dialog");
  fireEvent.click(screen.getByTestId("agent-connection-connect-continue"));
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connections-agent-missing")));
  assert.ok(screen.queryByTestId("agent-connection-github") === null);
});

test("other 4xx statuses still hide the Connections section", async () => {
  const get = vi.spyOn(api, "get").mockImplementation(async () => {
    throw Object.assign(new Error("409"), { response: { status: 409, data: { code: "agent_connection_agent_not_active" } } });
  });
  renderSection();
  await waitFor(() => assert.equal(get.mock.calls.length, 1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(screen.queryByTestId("agent-connections") === null);
});

const CREATED_AT = "2026-09-29T00:00:00.000Z";

function connector(id: string, account: string, creatorName: string | null, canManage: boolean, current = false) {
  return { id, account, createdAt: CREATED_AT, creator: { id: `${id}-user`, name: creatorName, displayName: creatorName }, current, canManage };
}

function connectedStatus(connectors: ReturnType<typeof connector>[], connectorId: string | null = "ctr_mine") {
  return {
    provider: "github", supported: true, connected: connectorId !== null, account: connectorId ? "octocat" : null, connectedAt: null, connectedBy: null, scopes: [],
    connectorId, connectors,
  };
}

async function openConnectorSelect() {
  const trigger = screen.getByRole("combobox", { name: en["agent.detail.connections.useConnection"] });
  fireEvent.click(trigger);
  return trigger;
}

test("connected: a Connected chip, the creator line under the select, and secondary actions in the More Actions menu", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: connectedStatus([connector("ctr_mine", "octocat", "alice", true, true)]) }) as never);
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  assert.equal(stateChip().getAttribute("data-state"), "connected");
  assert.equal(stateChip().textContent, en["agent.detail.connections.statusConnected"]);
  assert.match(screen.getByTestId("agent-connection-github-status").textContent ?? "", /^Created by alice · /);
  // Who created it and when is the connection's data: not a FieldDescription (HelperText step 1).
  assert.ok(screen.getByTestId("agent-connection-github-status").getAttribute("data-slot") !== "field-description");
  assert.ok(screen.queryByRole("button", { name: en["agent.detail.connections.connectNew"] }) === null, "no standalone buttons when connected");
  assert.equal(screen.getByTestId("agent-connection-github-menu").getAttribute("aria-label"), en["agent.detail.connections.moreActions"]);
  assert.deepEqual(await openActionsMenu(), [
    en["agent.detail.connections.connectNew"],
    fmt("agent.detail.connections.detach", { agent: AGENT_NAME }),
    en["agent.detail.connections.disconnectConnector"],
  ]);
});

test("Disconnect for All Agents is offered only to the connector's creator or an admin", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: connectedStatus([connector("ctr_mine", "octocat", "alice", false, true)]) }) as never);
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  assert.deepEqual(await openActionsMenu(), [
    en["agent.detail.connections.connectNew"],
    fmt("agent.detail.connections.detach", { agent: AGENT_NAME }),
  ]);
});

test("select options show who created each connection and when; one the caller cannot assign keeps its reason and is never sent", async () => {
  let status = connectedStatus([
    connector("ctr_mine", "octocat", "alice", true, true),
    connector("ctr_theirs", "hubot", "bob", false),
    connector("ctr_team", "monalisa", "carol", true),
  ]);
  const get = vi.spyOn(api, "get").mockImplementation(async () => ({ data: status }) as never);
  const put = vi.spyOn(api, "put").mockImplementation(async () => {
    status = { ...status, connectorId: "ctr_team" };
    return { data: status } as never;
  });
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));

  await openConnectorSelect();
  const forbidden = await screen.findByTestId("agent-connection-connector-ctr_theirs");
  assert.equal(forbidden.getAttribute("aria-disabled"), "true");
  assert.equal(forbidden.getAttribute("title"), en["agent.detail.connections.connectorForbidden"]);
  assert.match(forbidden.textContent ?? "", /hubot/);
  assert.match(forbidden.textContent ?? "", /Created by bob · /);
  assert.ok((forbidden.textContent ?? "").includes(en["agent.detail.connections.connectorForbidden"]!));
  fireEvent.pointerDown(forbidden);
  fireEvent.click(forbidden);
  assert.equal(put.mock.calls.length, 0, "a connector the caller cannot assign is never sent");

  const allowed = screen.getByTestId("agent-connection-connector-ctr_team");
  assert.match(allowed.textContent ?? "", /monalisa.*Created by carol · /);
  fireEvent.pointerDown(allowed);
  fireEvent.click(allowed);
  await waitFor(() => assert.equal(put.mock.calls.length, 1));
  assert.deepEqual(put.mock.calls[0]?.slice(0, 2), [`/agents/${AGENT}/connections/github`, { connectorId: "ctr_team" }]);
  await waitFor(() => assert.ok(get.mock.calls.length >= 2, "status reloads after switching"));
});

test("a refused switch shows the provider's sentence; a later successful switch clears it", async () => {
  let status = connectedStatus([
    connector("ctr_mine", "octocat", "alice", true, true),
    connector("ctr_team", "monalisa", "carol", true),
  ]);
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: status }) as never);
  let puts = 0;
  vi.spyOn(api, "put").mockImplementation(async () => {
    puts += 1;
    if (puts === 1) throw otherRefusal();
    status = { ...status, connectorId: "ctr_team" };
    return { data: status } as never;
  });
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));

  await openConnectorSelect();
  const team = await screen.findByTestId("agent-connection-connector-ctr_team");
  fireEvent.pointerDown(team);
  fireEvent.click(team);
  const banner = await screen.findByTestId("agent-connection-github-error");
  assert.ok((banner.textContent ?? "").includes(OTHER_REASON));
  assert.equal(stateChip().getAttribute("data-state"), "connected");

  await openConnectorSelect();
  const again = await screen.findByTestId("agent-connection-connector-ctr_team");
  fireEvent.pointerDown(again);
  fireEvent.click(again);
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-error") === null, "a successful switch clears the error"));
  assert.equal(stateChip().getAttribute("data-state"), "connected");
});

test("Remove from agent acts at once, clears an earlier error, and its Undo toast re-attaches the same connector", async () => {
  let status: ReturnType<typeof connectedStatus> = connectedStatus([
    connector("ctr_mine", "octocat", "alice", true, true),
    connector("ctr_team", "monalisa", "carol", true),
  ]);
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: status }) as never);
  let puts = 0;
  const put = vi.spyOn(api, "put").mockImplementation(async (_path, body) => {
    puts += 1;
    if (puts === 1) throw Object.assign(new Error("500"), { response: { status: 500, data: {} } });
    status = { ...status, connected: true, account: "octocat", connectorId: (body as { connectorId: string }).connectorId };
    return { data: status } as never;
  });
  const del = vi.spyOn(api, "delete").mockImplementation(async () => {
    status = { ...status, connected: false, account: null, connectorId: null };
    return { data: null } as never;
  });
  const success = vi.spyOn(toast, "success").mockImplementation(() => "toast-id");
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));

  // An earlier failed switch leaves an error behind.
  await openConnectorSelect();
  const team = await screen.findByTestId("agent-connection-connector-ctr_team");
  fireEvent.pointerDown(team);
  fireEvent.click(team);
  await screen.findByTestId("agent-connection-github-error");

  await chooseMenuItem(fmt("agent.detail.connections.detach", { agent: AGENT_NAME }));
  await waitFor(() => assert.equal(del.mock.calls.length, 1));
  assert.equal(del.mock.calls[0]?.[0], `/agents/${AGENT}/connections/github`);
  assert.ok(screen.queryByRole("dialog") === null, "no confirmation dialog");
  await waitFor(() => assert.equal(success.mock.calls.length, 1));
  assert.ok(screen.queryByTestId("agent-connection-github-error") === null, "Remove clears the earlier error");
  await waitFor(() => assert.equal(stateChip().getAttribute("data-state"), "not_connected"));

  const [message, options] = success.mock.calls[0]! as [string, { action: { label: string; onClick: () => void } }];
  assert.equal(message, fmt("agent.detail.connections.detached", { account: "octocat", agent: AGENT_NAME }));
  assert.equal(options.action.label, en["agent.detail.connections.undo"]);
  options.action.onClick();
  await waitFor(() => assert.equal(put.mock.calls.length, 2));
  assert.deepEqual(put.mock.calls[1]?.slice(0, 2), [`/agents/${AGENT}/connections/github`, { connectorId: "ctr_mine" }]);
  await waitFor(() => assert.equal(stateChip().getAttribute("data-state"), "connected"));
});

test("Remove from agent confirms first when the caller could not assign the connection back", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: connectedStatus([connector("ctr_mine", "octocat", "alice", false, true)]) }) as never);
  const del = vi.spyOn(api, "delete").mockImplementation(async () => ({ data: null }) as never);
  const success = vi.spyOn(toast, "success").mockImplementation(() => "toast-id");
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  await chooseMenuItem(fmt("agent.detail.connections.detach", { agent: AGENT_NAME }));
  await screen.findByTestId("agent-connection-detach-confirm");
  assert.equal(del.mock.calls.length, 0);
  fireEvent.click(screen.getByTestId("agent-connection-detach-confirm"));
  await waitFor(() => assert.equal(del.mock.calls.length, 1));
  await waitFor(() => assert.equal(success.mock.calls.length, 1));
  assert.equal(success.mock.calls[0]?.length, 1, "no Undo the caller could not perform");
});

test("Disconnect for All Agents confirms with the connection's account, creator and date, then clears an earlier error", async () => {
  let status: ReturnType<typeof connectedStatus> = connectedStatus([
    connector("ctr_mine", "octocat", "alice", true, true),
    connector("ctr_team", "monalisa", "carol", true),
  ]);
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: status }) as never);
  vi.spyOn(api, "put").mockImplementation(async () => { throw Object.assign(new Error("500"), { response: { status: 500, data: {} } }); });
  const del = vi.spyOn(api, "delete").mockImplementation(async () => {
    status = connectedStatus([connector("ctr_team", "monalisa", "carol", true)], null);
    return { data: null } as never;
  });
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  await openConnectorSelect();
  const team = await screen.findByTestId("agent-connection-connector-ctr_team");
  fireEvent.pointerDown(team);
  fireEvent.click(team);
  await screen.findByTestId("agent-connection-github-error");

  await chooseMenuItem(en["agent.detail.connections.disconnectConnector"]!);
  const confirm = await screen.findByTestId("agent-connection-disconnect-connector-confirm");
  const dialog = screen.getByRole("dialog");
  assert.match(dialog.textContent ?? "", /octocat \(created by alice on .+\) is disconnected for every agent on this server that uses it, not only Atlas/);
  assert.ok(within(dialog).getByRole("button", { name: en["common.confirm.cancel"] }));
  assert.equal(confirm.textContent, en["agent.detail.connections.disconnectConnector"]);
  fireEvent.click(confirm);
  await waitFor(() => assert.equal(del.mock.calls.length, 1));
  assert.equal(del.mock.calls[0]?.[0], `/agents/${AGENT}/connections/github/connectors/ctr_mine`);
  await waitFor(() => assert.equal(stateChip().getAttribute("data-state"), "not_connected"));
  assert.ok(screen.queryByTestId("agent-connection-github-error") === null, "a successful disconnect clears the earlier error");
});

test("a partially completed connector disconnect is not a success and offers a retry of the same call", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: connectedStatus([connector("ctr_mine", "octocat", "alice", true, true)]) }) as never);
  let calls = 0;
  const del = vi.spyOn(api, "delete").mockImplementation(async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error("502"), { response: { status: 502, data: { code: "agent_connection_connector_disconnect_partial", failedCount: 2 } } });
    }
    return { data: null } as never;
  });
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  await chooseMenuItem(en["agent.detail.connections.disconnectConnector"]!);
  fireEvent.click(await screen.findByTestId("agent-connection-disconnect-connector-confirm"));
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-disconnect-partial")));
  assert.match(screen.getByTestId("agent-connection-disconnect-partial").textContent ?? "", /partially completed/);

  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.retry"] }));
  await waitFor(() => assert.equal(del.mock.calls.length, 2));
  assert.deepEqual(del.mock.calls.map((call) => call[0]), [
    `/agents/${AGENT}/connections/github/connectors/ctr_mine`,
    `/agents/${AGENT}/connections/github/connectors/ctr_mine`,
  ]);
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-disconnect-partial") === null));
});

test("a failed disconnect shows a translated message instead of an unhandled rejection", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: connectedStatus([connector("ctr_mine", "octocat", "alice", true, true)]) }) as never);
  vi.spyOn(api, "delete").mockImplementation(async () => {
    throw Object.assign(new Error("500"), { response: { status: 500, data: { error: "internal boom" } } });
  });
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  await chooseMenuItem(en["agent.detail.connections.disconnectConnector"]!);
  fireEvent.click(await screen.findByTestId("agent-connection-disconnect-connector-confirm"));
  const banner = await screen.findByTestId("agent-connection-github-error");
  assert.equal(banner.textContent, en["agent.detail.connections.disconnectFailed"]);
  assert.ok(!document.body.textContent?.includes("internal boom"));
});

function notCleared() {
  return Object.assign(new Error("409"), { response: { status: 409, data: {
    error: "The agent still holds the connection's credential; the connection was kept. Try again",
    code: "agent_connection_disconnect_not_cleared",
  } } });
}

/** Its handler awaits a mocked request: let what that request settles land inside act. */
async function settled(action: () => unknown) {
  await act(async () => {
    await action();
  });
}

function isDisabled(element: HTMLElement) {
  return (element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true";
}

test("a removal that did not take offers Retry, which repeats it: disabled while in flight, the same warning again on a second failure", async () => {
  let status: ReturnType<typeof connectedStatus> = connectedStatus([connector("ctr_mine", "octocat", "alice", true, true)]);
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: status }) as never);
  let release: (outcome: "fail" | "ok") => void = () => undefined;
  let calls = 0;
  const del = vi.spyOn(api, "delete").mockImplementation(async () => {
    calls += 1;
    if (calls === 1) throw notCleared();
    const outcome = await new Promise<"fail" | "ok">((resolve) => { release = resolve; });
    if (outcome === "fail") throw notCleared();
    status = { ...status, connected: false, account: null, connectorId: null };
    return { data: null } as never;
  });
  const success = vi.spyOn(toast, "success").mockImplementation(() => "toast-id");
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  const warning = fmt("agent.detail.connections.detachNotCleared", { agent: AGENT_NAME });
  const retryName = en["agent.detail.connections.retry"]!;

  await settled(() => chooseMenuItem(fmt("agent.detail.connections.detach", { agent: AGENT_NAME })));
  const banner = await screen.findByTestId("agent-connection-github-error");
  assert.ok((banner.textContent ?? "").includes(warning));
  assert.ok(!(banner.textContent ?? "").includes(fmt("agent.detail.connections.detachFailed", { agent: AGENT_NAME })), "the Retry button says it: no \"try again\" in the text");
  assert.equal(stateChip().getAttribute("data-state"), "connected", "the connection was kept");

  await settled(() => fireEvent.click(within(banner).getByRole("button", { name: retryName })));
  await waitFor(() => assert.equal(del.mock.calls.length, 2));
  // In flight: the warning stays and its Retry cannot be pressed again.
  const inFlight = within(screen.getByTestId("agent-connection-github-error")).getByRole("button", { name: retryName });
  assert.ok(isDisabled(inFlight), "Retry is disabled while the removal is in flight");
  fireEvent.click(inFlight);
  await settled(() => release("fail"));
  await waitFor(() => assert.ok(!isDisabled(within(screen.getByTestId("agent-connection-github-error")).getByRole("button", { name: retryName }))));
  assert.ok((screen.getByTestId("agent-connection-github-error").textContent ?? "").includes(warning), "a second failure says the same");
  assert.equal(del.mock.calls.length, 2, "no second DELETE while the first was in flight");

  await settled(() => fireEvent.click(within(screen.getByTestId("agent-connection-github-error")).getByRole("button", { name: retryName })));
  await waitFor(() => assert.equal(del.mock.calls.length, 3));
  await settled(() => release("ok"));
  await waitFor(() => assert.equal(success.mock.calls.length, 1));
  await waitFor(() => assert.equal(stateChip().getAttribute("data-state"), "not_connected"));
  assert.ok(screen.queryByTestId("agent-connection-github-error") === null, "the retry that took clears the warning");
  assert.deepEqual(del.mock.calls.map((call) => call[0]), Array(3).fill(`/agents/${AGENT}/connections/github`), "the same removal each time");
  assert.equal(success.mock.calls[0]?.[0], fmt("agent.detail.connections.detached", { account: "octocat", agent: AGENT_NAME }));
});

test("only a removal that did not take offers Retry; another failed removal shows the warning alone", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: connectedStatus([connector("ctr_mine", "octocat", "alice", true, true)]) }) as never);
  vi.spyOn(api, "delete").mockImplementation(async () => {
    throw Object.assign(new Error("502"), { response: { status: 502, data: { code: "agent_connection_provider_error", error: "provider down" } } });
  });
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  await settled(() => chooseMenuItem(fmt("agent.detail.connections.detach", { agent: AGENT_NAME })));
  const banner = await screen.findByTestId("agent-connection-github-error");
  assert.equal(banner.textContent, fmt("agent.detail.connections.detachFailed", { agent: AGENT_NAME }));
  assert.equal(within(banner).queryAllByRole("button").length, 0, "no Retry");
});

function revokeHint() {
  return screen.queryByTestId("agent-connection-github-revoke-hint");
}

function assertRevokeHint() {
  const hint = revokeHint();
  assert.ok(hint, "the revoke-on-GitHub hint is shown");
  assert.ok((hint.textContent ?? "").includes(en["agent.detail.connections.revokeOnGithub"]!.split("{link}")[0]!));
  const link = within(hint).getByRole("link", { name: `${en["agent.detail.connections.revokeOnGithubLink"]} ${en["common.opensInNewTab"]}` });
  assert.equal(link.getAttribute("href"), "https://github.com/settings/applications");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  return hint;
}

test("a removal that leaves a copy out of the provider's reach says to revoke on GitHub, with the link; Dismiss puts it away", async () => {
  let status: ReturnType<typeof connectedStatus> = connectedStatus([connector("ctr_mine", "octocat", "alice", true, true)]);
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: status }) as never);
  vi.spyOn(api, "delete").mockImplementation(async () => {
    status = { ...status, connected: false, account: null, connectorId: null };
    return { data: { revokeOnGithub: true } } as never;
  });
  const success = vi.spyOn(toast, "success").mockImplementation(() => "toast-id");
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  await settled(() => chooseMenuItem(fmt("agent.detail.connections.detach", { agent: AGENT_NAME })));
  await waitFor(() => assert.equal(success.mock.calls.length, 1, "the removal itself took"));
  await waitFor(() => assert.ok(revokeHint()));
  const hint = assertRevokeHint();
  fireEvent.click(within(hint).getByRole("button", { name: en["agent.detail.connections.dismiss"] }));
  await waitFor(() => assert.ok(revokeHint() === null));
});

test("a plain removal or disconnect says nothing about GitHub", async () => {
  let status: ReturnType<typeof connectedStatus> = connectedStatus([connector("ctr_mine", "octocat", "alice", true, true)]);
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: status }) as never);
  // A 204 reaches the client as an empty body; an older server never sends the field.
  const del = vi.spyOn(api, "delete").mockImplementation(async () => {
    status = { ...status, connected: false, account: null, connectorId: null };
    return { data: "" } as never;
  });
  const success = vi.spyOn(toast, "success").mockImplementation(() => "toast-id");
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  await settled(() => chooseMenuItem(fmt("agent.detail.connections.detach", { agent: AGENT_NAME })));
  await waitFor(() => assert.equal(success.mock.calls.length, 1));
  await waitFor(() => assert.equal(stateChip().getAttribute("data-state"), "not_connected"));
  assert.ok(revokeHint() === null, "no hint after a plain removal");

  status = connectedStatus([connector("ctr_mine", "octocat", "alice", true, true)]);
  cleanup();
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  await chooseMenuItem(en["agent.detail.connections.disconnectConnector"]!);
  fireEvent.click(await screen.findByTestId("agent-connection-disconnect-connector-confirm"));
  await waitFor(() => assert.equal(del.mock.calls.length, 2));
  await waitFor(() => assert.equal(stateChip().getAttribute("data-state"), "not_connected"));
  assert.ok(revokeHint() === null, "no hint after a plain disconnect");
});

test("Disconnect for All Agents says to revoke on GitHub when the server says so", async () => {
  let status: ReturnType<typeof connectedStatus> = connectedStatus([connector("ctr_mine", "octocat", "alice", true, true)]);
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: status }) as never);
  vi.spyOn(api, "delete").mockImplementation(async () => {
    status = connectedStatus([], null);
    return { data: { revokeOnGithub: true } } as never;
  });
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  await chooseMenuItem(en["agent.detail.connections.disconnectConnector"]!);
  fireEvent.click(await screen.findByTestId("agent-connection-disconnect-connector-confirm"));
  await waitFor(() => assert.ok(revokeHint()));
  assertRevokeHint();
});

test("a partial disconnect that met an unreachable copy shows the hint once its retry completes, one banner at a time", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: connectedStatus([connector("ctr_mine", "octocat", "alice", true, true)]) }) as never);
  let calls = 0;
  const del = vi.spyOn(api, "delete").mockImplementation(async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error("502"), { response: { status: 502, data: {
        code: "agent_connection_connector_disconnect_partial", failedCount: 1, revokeOnGithub: true,
      } } });
    }
    // The retry no longer meets the wiped agent (its binding went on the first call): a plain success.
    return { data: "" } as never;
  });
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  await chooseMenuItem(en["agent.detail.connections.disconnectConnector"]!);
  fireEvent.click(await screen.findByTestId("agent-connection-disconnect-connector-confirm"));
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-disconnect-partial")));
  assert.ok(revokeHint() === null, "the partial warning first");

  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.retry"] }));
  await waitFor(() => assert.equal(del.mock.calls.length, 2));
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-disconnect-partial") === null));
  await waitFor(() => assert.ok(revokeHint()));
  assertRevokeHint();
});

test("Undo does not overwrite a connection picked after Remove, and an Undo failure is a toast", async () => {
  let status: ReturnType<typeof connectedStatus> = connectedStatus([
    connector("ctr_mine", "octocat", "alice", true, true),
    connector("ctr_team", "monalisa", "carol", true),
  ]);
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: status }) as never);
  const put = vi.spyOn(api, "put").mockImplementation(async (_path, body) => {
    status = { ...status, connected: true, account: "monalisa", connectorId: (body as { connectorId: string }).connectorId };
    return { data: status } as never;
  });
  vi.spyOn(api, "delete").mockImplementation(async () => {
    status = { ...status, connected: false, account: null, connectorId: null };
    return { data: null } as never;
  });
  const success = vi.spyOn(toast, "success").mockImplementation(() => "toast-id");
  const error = vi.spyOn(toast, "error").mockImplementation(() => "toast-id");
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  await chooseMenuItem(fmt("agent.detail.connections.detach", { agent: AGENT_NAME }));
  await waitFor(() => assert.equal(success.mock.calls.length, 1));
  await waitFor(() => assert.equal(stateChip().getAttribute("data-state"), "not_connected"));

  // The user picks another connection while the toast is still up.
  await openConnectorSelect();
  const team = await screen.findByTestId("agent-connection-connector-ctr_team");
  fireEvent.pointerDown(team);
  fireEvent.click(team);
  await waitFor(() => assert.equal(stateChip().getAttribute("data-state"), "connected"));
  const putsBefore = put.mock.calls.length;

  const [, options] = success.mock.calls[0]! as unknown as [string, { action: { onClick: () => void } }];
  options.action.onClick();
  await waitFor(() => assert.equal(error.mock.calls.length, 1));
  assert.equal(error.mock.calls[0]?.[0], fmt("agent.detail.connections.undoSkipped", { agent: AGENT_NAME }));
  assert.equal(put.mock.calls.length, putsBefore, "the newer choice is kept");
});

test("an Undo whose PUT fails reports through a toast, since the toast can outlive the panel", async () => {
  let status: ReturnType<typeof connectedStatus> = connectedStatus([connector("ctr_mine", "octocat", "alice", true, true)]);
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: status }) as never);
  vi.spyOn(api, "put").mockImplementation(async () => { throw Object.assign(new Error("500"), { response: { status: 500, data: {} } }); });
  vi.spyOn(api, "delete").mockImplementation(async () => {
    status = { ...status, connected: false, account: null, connectorId: null };
    return { data: null } as never;
  });
  const success = vi.spyOn(toast, "success").mockImplementation(() => "toast-id");
  const error = vi.spyOn(toast, "error").mockImplementation(() => "toast-id");
  const { unmount } = renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  await chooseMenuItem(fmt("agent.detail.connections.detach", { agent: AGENT_NAME }));
  await waitFor(() => assert.equal(success.mock.calls.length, 1));
  await waitFor(() => assert.equal(stateChip().getAttribute("data-state"), "not_connected"));
  unmount();
  const [, options] = success.mock.calls[0]! as unknown as [string, { action: { onClick: () => void } }];
  options.action.onClick();
  await waitFor(() => assert.equal(error.mock.calls.length, 1));
  assert.equal(error.mock.calls[0]?.[0], en["agent.detail.connections.reattachFailed"]);
});

test("a second Remove while the first is in flight sends nothing", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: connectedStatus([connector("ctr_mine", "octocat", "alice", true, true)]) }) as never);
  let release: () => void = () => undefined;
  const del = vi.spyOn(api, "delete").mockImplementation(() => new Promise((resolve) => {
    release = () => resolve({ data: null } as never);
  }));
  const success = vi.spyOn(toast, "success").mockImplementation(() => "toast-id");
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  const removeLabel = fmt("agent.detail.connections.detach", { agent: AGENT_NAME });
  await chooseMenuItem(removeLabel);
  await waitFor(() => assert.equal(del.mock.calls.length, 1));
  await openActionsMenu();
  const item = screen.getByRole("menuitem", { name: removeLabel });
  assert.equal(item.getAttribute("aria-disabled"), "true");
  fireEvent.click(item);
  release();
  await waitFor(() => assert.equal(success.mock.calls.length, 1));
  assert.equal(del.mock.calls.length, 1, "one DELETE, one toast");
});

test("Continue stays disabled after a successful start until the page leaves; radios are named by their title only", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: NOT_CONNECTED }) as never);
  const post = vi.spyOn(api, "post").mockImplementation(async () => ({
    data: { url: "https://github.com/login/oauth/authorize?x=1", expiresAt: "2026-09-29T00:10:00.000Z", scopes: ["public_repo"] },
  }) as never);
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github")));
  fireEvent.click(screen.getByRole("button", { name: en["agent.detail.connections.connectNew"] }));
  await screen.findByTestId("agent-connection-connect-dialog");
  const radio = screen.getByRole("radio", { name: en["agent.detail.connections.accessPrivate"] });
  assert.match(radio.getAttribute("aria-describedby") ? document.getElementById(radio.getAttribute("aria-describedby")!)?.textContent ?? "" : "", /repo/);
  const continueButton = screen.getByTestId("agent-connection-connect-continue");
  fireEvent.click(continueButton);
  await waitFor(() => assert.equal(post.mock.calls.length, 1));
  await waitFor(() => assert.ok((continueButton as HTMLButtonElement).disabled));
  fireEvent.click(continueButton);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(post.mock.calls.length, 1, "no second start");
});

test("the confirm-first Remove names the connection's creator to ask for re-assignment", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: connectedStatus([connector("ctr_mine", "octocat", "alice", false, true)]) }) as never);
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  await chooseMenuItem(fmt("agent.detail.connections.detach", { agent: AGENT_NAME }));
  await screen.findByTestId("agent-connection-detach-confirm");
  assert.ok((screen.getByRole("dialog").textContent ?? "").includes(
    fmt("agent.detail.connections.detachMessage", { agent: AGENT_NAME, account: "octocat", creator: "alice" }),
  ));
});

// --- Listed connection codes in the panel (REFUSAL_CODES) ---

function optionIds() {
  return screen.queryAllByTestId(/^agent-connection-connector-/).map((item) => item.getAttribute("data-testid"));
}

test("connector_not_found on a switch drops that connection from the list, reloads the status and says so", async () => {
  const status = connectedStatus([
    connector("ctr_mine", "octocat", "alice", true, true),
    connector("ctr_team", "monalisa", "carol", true),
  ]);
  let reloaded = false;
  const get = vi.spyOn(api, "get").mockImplementation(async () => {
    // The reload: the provider no longer lists it either.
    if (get.mock.calls.length > 1) reloaded = true;
    return { data: reloaded ? { ...status, connectors: [status.connectors[0]] } : status } as never;
  });
  vi.spyOn(api, "put").mockImplementation(async () => { throw codedRefusal(404, "agent_connection_connector_not_found"); });
  const toastError = vi.spyOn(toast, "error").mockImplementation(() => "toast-id");
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  await openConnectorSelect();
  const team = await screen.findByTestId("agent-connection-connector-ctr_team");
  fireEvent.pointerDown(team);
  fireEvent.click(team);

  const banner = await screen.findByTestId("agent-connection-github-error");
  assert.equal(banner.getAttribute("data-code"), "agent_connection_connector_not_found");
  assert.equal(banner.textContent, fmt("agent.detail.connections.connectorGone", { account: "monalisa" }));
  await waitFor(() => assert.ok(get.mock.calls.length >= 2, "the status reloads"));
  await openConnectorSelect();
  await screen.findByTestId("agent-connection-connector-ctr_mine");
  assert.deepEqual(optionIds(), ["agent-connection-connector-ctr_mine"], "the gone connection left the list");
  assert.equal(toastError.mock.calls.length, 0);
});

test("connector_forbidden on a switch reloads the status, whose canManage then disables it, and names who can", async () => {
  let status = connectedStatus([
    connector("ctr_mine", "octocat", "alice", true, true),
    connector("ctr_team", "monalisa", "carol", true),
  ]);
  const get = vi.spyOn(api, "get").mockImplementation(async () => ({ data: status }) as never);
  vi.spyOn(api, "put").mockImplementation(async () => {
    // Raft decided meanwhile that the caller may not manage it.
    status = connectedStatus([connector("ctr_mine", "octocat", "alice", true, true), connector("ctr_team", "monalisa", "carol", false)]);
    throw codedRefusal(403, "agent_connection_connector_forbidden");
  });
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  await openConnectorSelect();
  const team = await screen.findByTestId("agent-connection-connector-ctr_team");
  fireEvent.pointerDown(team);
  fireEvent.click(team);

  const banner = await screen.findByTestId("agent-connection-github-error");
  assert.equal(banner.textContent, fmt("agent.detail.connections.connectorForbiddenBy", { account: "monalisa", creator: "carol" }));
  await waitFor(() => assert.equal(get.mock.calls.length, 2, "the status reloads once"));
  await openConnectorSelect();
  await waitFor(() => assert.equal(screen.getByTestId("agent-connection-connector-ctr_team").getAttribute("aria-disabled"), "true"));
});

const BROKEN_REASON = "OAuth authorization expired; reconnect required";

function brokenStatus(canManage = true) {
  return {
    provider: "github", supported: true, connected: false, account: null, connectedAt: null, connectedBy: null, scopes: [],
    oauthStatus: "error", lastCheckError: BROKEN_REASON, lastCheckedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    connectorId: null,
    connectors: [
      { ...connector("ctr_broken", "octocat", "alice", canManage, true), oauthStatus: "error", lastCheckError: BROKEN_REASON, scopes: ["repo"], requestedScopes: ["repo"] },
      { ...connector("ctr_ok", "hubot", "bob", true), oauthStatus: "connected", lastCheckError: null, scopes: ["public_repo"], requestedScopes: ["public_repo"] },
    ],
  };
}

test("needs reconnecting: the chip and row say so in plain words, the reason muted, when it was checked, and Reconnect", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: brokenStatus() }) as never);
  const post = vi.spyOn(api, "post").mockImplementation(async () => ({
    data: { url: "https://github.com/login/oauth/authorize?x=3", expiresAt: "2026-11-05T00:10:00.000Z", scopes: ["repo"] },
  }) as never);
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-health")));
  assert.equal(stateChip().getAttribute("data-state"), "needs_reconnect");
  assert.equal(stateChip().textContent, "Needs reconnecting");
  const health = screen.getByTestId("agent-connection-github-health");
  assert.ok((health.textContent ?? "").includes(fmt("agent.detail.connections.needsReconnectBody", { account: "octocat", agent: AGENT_NAME })));
  assert.equal(screen.getByTestId("agent-connection-github-health-reason").textContent, BROKEN_REASON);
  assert.match(screen.getByTestId("agent-connection-github-health-checked").textContent ?? "", /^Last checked 2 hours ago$/);
  assert.ok(screen.queryByRole("button", { name: en["agent.detail.connections.connectNew"] }) === null, "Reconnect is the one action");
  assert.ok(screen.queryByTestId("agent-connection-github-access") === null, "no access line while it is broken");

  // The broken connection's option says so too; the healthy one says only what it can do.
  await openConnectorSelect();
  assert.match((await screen.findByTestId("agent-connection-connector-ctr_broken")).textContent ?? "", /Needs reconnecting/);
  const ok = screen.getByTestId("agent-connection-connector-ctr_ok").textContent ?? "";
  assert.ok(ok.includes(en["agent.detail.connections.accessSummaryPublic"]!));
  assert.ok(!/connected|healthy/i.test(ok), "a connected option carries no health word");
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

  fireEvent.click(within(health).getByRole("button", { name: en["agent.detail.connections.reconnect"] }));
  await screen.findByTestId("agent-connection-connect-dialog");
  assert.ok((screen.getByRole("dialog").textContent ?? "").includes(fmt("agent.detail.connections.reconnectTitle", { account: "octocat" })));
  assert.equal(screen.getByRole("radio", { name: en["agent.detail.connections.accessPrivate"] }).getAttribute("aria-checked"), "true", "asks for what it had");
  fireEvent.click(screen.getByTestId("agent-connection-connect-continue"));
  await waitFor(() => assert.equal(post.mock.calls.length, 1));
  assert.deepEqual(post.mock.calls[0]?.slice(0, 2), [`/agents/${AGENT}/connections/github`, { access: "private", connectorId: "ctr_broken" }]);
});

test("needs reconnecting, but not the caller's to fix: no Reconnect, and it says who can", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: brokenStatus(false) }) as never);
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-health")));
  const health = screen.getByTestId("agent-connection-github-health");
  assert.ok((health.textContent ?? "").includes(fmt("agent.detail.connections.needsReconnectNotYours", { account: "octocat", agent: AGENT_NAME })));
  assert.equal(within(health).queryAllByRole("button").length, 0);
});

test("a connected row stays quiet: no health banner, no health word, no last-checked time", async () => {
  vi.spyOn(api, "get").mockImplementation(async () => ({
    data: { ...connectedStatus([{ ...connector("ctr_mine", "octocat", "alice", true, true), oauthStatus: "connected", lastCheckError: null, lastCheckedAt: CREATED_AT }]), oauthStatus: "connected", lastCheckedAt: CREATED_AT },
  }) as never);
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
  assert.ok(screen.queryByTestId("agent-connection-github-health") === null);
  assert.ok(screen.queryByTestId("agent-connection-github-health-checked") === null);
  assert.ok(!(screen.getByTestId("agent-connection-github").textContent ?? "").includes("Last checked"));
});

test("Reconnect's POST 404 goes through the connection error classifier: connector_not_found drops it, no toast", async () => {
  const status = brokenStatus();
  const get = vi.spyOn(api, "get").mockImplementation(async () => ({ data: get.mock.calls.length > 1 ? { ...status, oauthStatus: undefined, connectors: [status.connectors[1]] } : status }) as never);
  vi.spyOn(api, "post").mockImplementation(async () => { throw codedRefusal(404, "agent_connection_connector_not_found"); });
  const toastError = vi.spyOn(toast, "error").mockImplementation(() => "toast-id");
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-health")));
  fireEvent.click(within(screen.getByTestId("agent-connection-github-health")).getByRole("button", { name: en["agent.detail.connections.reconnect"] }));
  await screen.findByTestId("agent-connection-connect-dialog");
  fireEvent.click(screen.getByTestId("agent-connection-connect-continue"));

  const banner = await screen.findByTestId("agent-connection-github-error");
  assert.equal(banner.getAttribute("data-code"), "agent_connection_connector_not_found");
  assert.equal(banner.textContent, fmt("agent.detail.connections.connectorGone", { account: "octocat" }));
  await waitFor(() => assert.ok(get.mock.calls.length >= 2, "the status reloads"));
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-health") === null, "the gone connection no longer needs reconnecting"));
  assert.equal(toastError.mock.calls.length, 0, "not a generic toast");
});

test("a POST 404 without a listed code is the start's own failure in the panel, not a toast", async () => {
  const toastError = vi.spyOn(toast, "error").mockImplementation(() => "toast-id");
  const { banner } = await connectAndFail(() => { throw Object.assign(new Error("404"), { response: { status: 404, data: { error: "Not found", code: "not_found" } } }); });
  assert.equal(banner.textContent, en["agent.detail.connections.startFailed"]);
  assert.equal(toastError.mock.calls.length, 0);
});

function scopedStatus(scopes: string[] | null | undefined, requestedScopes: string[] | null | undefined) {
  const entry: Record<string, unknown> = { ...connector("ctr_mine", "octocat", "alice", true, true), oauthStatus: "connected" };
  if (scopes !== undefined) entry.scopes = scopes;
  if (requestedScopes !== undefined) entry.requestedScopes = requestedScopes;
  return { ...connectedStatus([entry as ReturnType<typeof connector>]), scopes: scopes ?? [], requestedScopes };
}

async function renderScoped(scopes: string[] | null | undefined, requestedScopes: string[] | null | undefined) {
  cleanup();
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: scopedStatus(scopes, requestedScopes) }) as never);
  renderSection();
  await waitFor(() => assert.ok(screen.queryByTestId("agent-connection-github-connectors")));
}

test("scopes in words: private, public only, and nothing for not recorded or [] (a GitHub App user token)", async () => {
  await renderScoped(["repo", "read:org"], ["repo", "read:org"]);
  const privateLine = screen.getByTestId("agent-connection-github-access");
  assert.equal(privateLine.textContent, en["agent.detail.connections.accessSummaryPrivate"]);
  assert.ok(!(screen.getByTestId("agent-connection-github").textContent ?? "").includes("read:org"), "the raw scopes are not the main text");
  assert.ok(screen.queryByTestId("agent-connection-github-scopes-short") === null);

  await renderScoped(["public_repo"], ["public_repo"]);
  assert.equal(screen.getByTestId("agent-connection-github-access").textContent, en["agent.detail.connections.accessSummaryPublic"]);

  await renderScoped(null, null);
  assert.ok(screen.queryByTestId("agent-connection-github-access") === null, "null: not recorded, nothing said");
  assert.ok(screen.queryByTestId("agent-connection-github-scopes-short") === null);

  await renderScoped(undefined, undefined);
  assert.ok(screen.queryByTestId("agent-connection-github-access") === null, "absent: an older provider, nothing said");

  await renderScoped([], null);
  assert.ok(screen.queryByTestId("agent-connection-github-access") === null, "[]: a working App token has no OAuth scopes, nothing said");
});

test("GitHub granted less than requested: said in words with Reconnect, which asks for the requested access again", async () => {
  const post = vi.spyOn(api, "post").mockImplementation(async () => ({
    data: { url: "https://github.com/login/oauth/authorize?x=4", expiresAt: "2026-11-05T00:10:00.000Z", scopes: ["repo"] },
  }) as never);
  await renderScoped(["public_repo"], ["repo"]);
  const short = screen.getByTestId("agent-connection-github-scopes-short");
  assert.ok((short.textContent ?? "").includes(en["agent.detail.connections.scopesShort"]!));
  assert.ok(screen.queryByTestId("agent-connection-github-access") === null, "one line about access, not two");
  fireEvent.click(within(short).getByRole("button", { name: en["agent.detail.connections.reconnect"] }));
  await screen.findByTestId("agent-connection-connect-dialog");
  fireEvent.click(screen.getByTestId("agent-connection-connect-continue"));
  await waitFor(() => assert.equal(post.mock.calls.length, 1));
  assert.deepEqual(post.mock.calls[0]?.slice(0, 2), [`/agents/${AGENT}/connections/github`, { access: "private", connectorId: "ctr_mine" }]);

  // `[]` next to requested scopes: not "granted less" (an App token), so no Reconnect loop.
  await renderScoped([], ["public_repo"]);
  assert.ok(screen.queryByTestId("agent-connection-github-scopes-short") === null);
  assert.ok(screen.queryByTestId("agent-connection-github-access") === null);

  // `repo` covers `public_repo`: nothing is missing.
  await renderScoped(["repo"], ["public_repo"]);
  assert.ok(screen.queryByTestId("agent-connection-github-scopes-short") === null);
});
