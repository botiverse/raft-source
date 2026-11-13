import "../../../../tests/helpers/domSetup";

// The external agent's two-step create dialog (#wg-external-agent-ux:#2): Next makes the agent, records how it
// will run and makes its one agent credential; step 2 shows how to connect it and waits for the first sign-in;
// switching ways keeps the same credential; Cancel before it connects discards the agent; Done goes to its page.
import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import api from "../../../api/client";
import { useAgentStore } from "../../../store/agentStore";
import { useServerStore } from "../../../store/serverStore";
import { TestIntlProvider } from "../../../../tests/helpers/intl";
import { CreateExternalAgentDialog } from "../CreateExternalAgentDialog";
import { PAGE_CREDENTIAL_NAME } from "../externalAgentSetup";

const original = { get: api.get, post: api.post, put: api.put, delete: api.delete };
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const KEY = "sk_agent_test0000000000000000000000";

type Call = { method: string; url: string; body?: unknown };

function mockApi(state: { connected: boolean }) {
  const calls: Call[] = [];
  api.post = (async (url: string, body?: unknown) => {
    calls.push({ method: "post", url, body });
    if (url === "/agents") return { data: { id: AGENT_ID, name: "Nathan", displayName: "Nathan", status: "inactive", runtime: "external" } } as never;
    if (url === `/agents/${AGENT_ID}/credentials`) return { data: { agentId: AGENT_ID, credentialId: "cred-1", apiKey: KEY } } as never;
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  api.put = (async (url: string, body?: unknown) => {
    calls.push({ method: "put", url, body });
    return { data: body } as never;
  }) as typeof api.put;
  api.get = (async (url: string) => {
    calls.push({ method: "get", url });
    if (url === `/agents/${AGENT_ID}/external-status`) {
      return { data: { setupState: state.connected ? "connected" : "credential_minted", credentialLastUsedAt: null, lastActivityAt: null } } as never;
    }
    return { data: {} } as never;
  }) as typeof api.get;
  api.delete = (async (url: string) => {
    calls.push({ method: "delete", url });
    return { data: {} } as never;
  }) as typeof api.delete;
  return calls;
}

function Where() {
  const location = useLocation();
  return <span data-testid="where">{location.pathname}</span>;
}

function renderDialog(onClose: () => void) {
  useServerStore.setState({ current: { id: "server-1", name: "Server", slug: "server", ownerId: "user-1", role: "owner", plan: "pro" } } as never);
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/server/members"]}>
        <CreateExternalAgentDialog onClose={onClose} />
        <Where />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

async function next(name: string) {
  fireEvent.change(screen.getByTestId("create-external-agent-name"), { target: { value: name } });
  await act(async () => { fireEvent.click(screen.getByTestId("create-external-agent-next")); });
  await screen.findByTestId("create-external-agent-setup");
}

afterEach(() => {
  cleanup();
  Object.assign(api, original);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("Next makes the agent, records an existing agent, makes the one credential; step 2 gives the prompt and the credential", async () => {
  const calls = mockApi({ connected: false });
  renderDialog(() => undefined);
  await next("Nathan");
  const created = calls.find((call) => call.method === "post" && call.url === "/agents");
  assert.equal((created?.body as { external?: boolean }).external, true);
  assert.deepEqual(calls.find((call) => call.method === "put")?.body, { method: "existing_agent" });
  assert.deepEqual(calls.find((call) => call.url === `/agents/${AGENT_ID}/credentials`)?.body, { name: PAGE_CREDENTIAL_NAME });
  assert.match(screen.getByTestId("create-external-agent-prompt").textContent ?? "", /raft agent login --server .* --agent 11111111-1111-4111-8111-111111111111 --profile-slug Nathan/);
  assert.equal(screen.getByTestId("create-external-agent-credential").textContent, KEY);
  assert.match(screen.getByTestId("create-external-agent-status").textContent ?? "", /Waiting for Nathan to connect/);
});

test("switching to the SDK keeps the same credential, records the way, and makes nothing new", async () => {
  const calls = mockApi({ connected: false });
  renderDialog(() => undefined);
  await next("Nathan");
  const mintsBefore = calls.filter((call) => call.url === `/agents/${AGENT_ID}/credentials`).length;
  await act(async () => { fireEvent.click(screen.getByTestId("create-external-agent-switch")); });
  assert.ok(screen.getByTestId("create-external-agent-sdk-steps"));
  assert.equal(screen.getByTestId("create-external-agent-credential").textContent, KEY);
  assert.match(screen.getByTestId("create-external-agent-code").textContent ?? "", /createRaftClient[\s\S]*RAFT_AGENT_CREDENTIAL[\s\S]*raft\.agent\.context\(\)/);
  assert.deepEqual(calls.filter((call) => call.method === "put").at(-1)?.body, { method: "sdk" });
  assert.equal(calls.filter((call) => call.url === `/agents/${AGENT_ID}/credentials`).length, mintsBefore, "no new credential");
  assert.equal(calls.filter((call) => call.method === "delete").length, 0, "nothing revoked");
});

test("once it signs in: online, the steps go, only Done, which opens its page", async () => {
  const state = { connected: false };
  mockApi(state);
  let closed = false;
  renderDialog(() => { closed = true; });
  await next("Nathan");
  state.connected = true;
  await waitFor(() => assert.ok(screen.getByTestId("create-external-agent-status").hasAttribute("data-connected")), { timeout: 5000 });
  assert.match(screen.getByTestId("create-external-agent-status").textContent ?? "", /Nathan is online/);
  assert.ok(screen.queryByTestId("create-external-agent-existing-steps") === null);
  assert.ok(screen.queryByTestId("create-external-agent-cancel") === null);
  await act(async () => { fireEvent.click(screen.getByTestId("create-external-agent-done")); });
  assert.equal(closed, true);
  assert.equal(screen.getByTestId("where").textContent, `/s/server/agent/${AGENT_ID}`);
});

test("Cancel before it connects asks, then discards the agent (and its credential with it)", async () => {
  const calls = mockApi({ connected: false });
  let closed = false;
  renderDialog(() => { closed = true; });
  await next("Nathan");
  await act(async () => { fireEvent.click(screen.getByTestId("create-external-agent-cancel")); });
  assert.ok(screen.getByTestId("create-external-agent-discard"));
  await act(async () => { fireEvent.click(screen.getByTestId("create-external-agent-discard-confirm")); });
  await waitFor(() => assert.equal(closed, true));
  assert.ok(calls.some((call) => call.method === "delete" && call.url.startsWith(`/agents/${AGENT_ID}`)), "the agent is deleted");
});

test("a failed credential leaves nothing: the agent made before it is discarded and step 1 stays", async () => {
  const calls = mockApi({ connected: false });
  const post = api.post;
  api.post = (async (url: string, body?: unknown) => {
    if (url === `/agents/${AGENT_ID}/credentials`) throw Object.assign(new Error("nope"), { response: { status: 500, data: { error: "Raft couldn't make a credential." } } });
    return post(url, body as never);
  }) as typeof api.post;
  renderDialog(() => undefined);
  fireEvent.change(screen.getByTestId("create-external-agent-name"), { target: { value: "Nathan" } });
  await act(async () => { fireEvent.click(screen.getByTestId("create-external-agent-next")); });
  await screen.findByTestId("create-external-agent-error");
  assert.ok(screen.queryByTestId("create-external-agent-setup") === null);
  assert.ok(calls.some((call) => call.method === "delete" && call.url.startsWith(`/agents/${AGENT_ID}`)), "the half-made agent is deleted");
});
