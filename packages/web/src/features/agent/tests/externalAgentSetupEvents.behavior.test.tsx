import "../../../../tests/helpers/domSetup";

// External agent setup events (Grace, 2026-11-15): what the create dialog and the agent page's connection card
// record up to the first sign-in. Counts of people per step: no agent id, and a copy never carries what was copied.
import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, test } from "vitest";
import api from "../../../api/client";
import { flushProductEvents, resetProductEventsForTest } from "../../../analytics/track";
import { useAgentStore } from "../../../store/agentStore";
import { useServerStore } from "../../../store/serverStore";
import { TestIntlProvider } from "../../../../tests/helpers/intl";
import { CreateExternalAgentDialog } from "../CreateExternalAgentDialog";
import { ExternalAgentLinkIntent } from "../ExternalAgentLinkIntent";

const original = { get: api.get, post: api.post, put: api.put, delete: api.delete };
const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const KEY = "sk_agent_test0000000000000000000000";

type SentEvent = { event: string; properties: Record<string, unknown> };

function tokenStorages(): Storage[] {
  return [...new Set([window.localStorage, globalThis.localStorage])].filter(Boolean);
}

function captureProductEvents(): SentEvent[] {
  const sent: SentEvent[] = [];
  // The sender reads globalThis.localStorage; on a Node with its own Web Storage that is not jsdom's.
  for (const storage of tokenStorages()) storage.setItem("slock_access_token", "token-1");
  resetProductEventsForTest(async (url, init) => {
    if (url.endsWith("/product-events/config")) return new Response(JSON.stringify({ clientEventsAllowed: true }), { status: 200 });
    for (const { event, properties } of (JSON.parse(String(init?.body)) as { events: SentEvent[] }).events) sent.push({ event, properties });
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });
  return sent;
}

/** The setup events sent so far, as `[event without its prefix, step / action / result, surface, method]`. */
async function setupEvents(sent: SentEvent[]) {
  await flushProductEvents();
  return sent
    .filter((item) => item.event.startsWith("external_agent_setup_"))
    .map(({ event, properties }) => [event.replace("external_agent_setup_", ""), properties.step ?? properties.action ?? properties.result, properties.surface ?? null, properties.method]);
}

function mockApi(state: { connected: boolean; credentialFails?: boolean }) {
  api.post = (async (url: string) => {
    if (url === "/agents") return { data: { id: AGENT_ID, name: "Nathan", displayName: "Nathan", status: "inactive", runtime: "external" } } as never;
    if (url === `/agents/${AGENT_ID}/credentials`) {
      if (state.credentialFails) throw Object.assign(new Error("nope"), { response: { status: 500, data: { error: "Raft couldn't make a credential." } } });
      return { data: { agentId: AGENT_ID, credentialId: "cred-1", apiKey: KEY } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  api.put = (async (_url: string, body?: unknown) => ({ data: body }) as never) as typeof api.put;
  api.get = (async (url: string) => {
    if (url === `/agents/${AGENT_ID}/external-status`) {
      return { data: { setupState: state.connected ? "connected" : "credential_minted", credentialLastUsedAt: null, lastActivityAt: null } } as never;
    }
    return { data: {} } as never;
  }) as typeof api.get;
  api.delete = (async () => ({ data: {} }) as never) as typeof api.delete;
}

function setServer(role: string) {
  useServerStore.setState({ current: { id: "server-1", name: "Server", slug: "server", ownerId: "user-1", role, plan: "pro" }, members: [] } as never);
}

function renderDialog(onClose: () => void = () => undefined) {
  setServer("owner");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => undefined } });
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/server/members"]}>
        <CreateExternalAgentDialog onClose={onClose} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

async function next(name: string) {
  fireEvent.change(screen.getByTestId("create-external-agent-name"), { target: { value: name } });
  await act(async () => { fireEvent.click(screen.getByTestId("create-external-agent-next")); });
}

async function click(testId: string) {
  await act(async () => { fireEvent.click(screen.getByTestId(testId)); });
}

afterEach(() => {
  cleanup();
  Object.assign(api, original);
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
  resetProductEventsForTest();
  for (const storage of tokenStorages()) storage.removeItem("slock_access_token");
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("the dialog records created, each copy, a switch with the method switched to, and Done while waiting as finish_later", async () => {
  const sent = captureProductEvents();
  mockApi({ connected: false });
  renderDialog();
  await next("Nathan");
  await screen.findByTestId("create-external-agent-setup");
  await click("create-external-agent-prompt-copy");
  await click("create-external-agent-credential-copy");
  await click("create-external-agent-switch");
  await click("create-external-agent-install-copy");
  await click("create-external-agent-code-copy");
  await click("create-external-agent-done");
  assert.deepEqual(await setupEvents(sent), [
    ["progress", "created", "dialog", "existing_agent"],
    ["action", "prompt_copied", "dialog", "existing_agent"],
    ["action", "credential_copied", "dialog", "existing_agent"],
    ["action", "method_switched", "dialog", "sdk"],
    ["action", "install_copied", "dialog", "sdk"],
    ["action", "code_copied", "dialog", "sdk"],
    ["closed", "finish_later", null, "sdk"],
  ]);
  const text = JSON.stringify(sent);
  assert.equal(text.includes(KEY) || text.includes(AGENT_ID) || text.includes("Nathan"), false, "no credential, agent id or name on any event");
});

test("the first sign-in seen in the dialog is recorded once, and Done after it is done_connected", async () => {
  const sent = captureProductEvents();
  const state = { connected: false };
  mockApi(state);
  renderDialog();
  await next("Nathan");
  await screen.findByTestId("create-external-agent-setup");
  state.connected = true;
  await waitFor(() => assert.ok(screen.getByTestId("create-external-agent-status").hasAttribute("data-connected")), { timeout: 5000 });
  await click("create-external-agent-done");
  assert.deepEqual(await setupEvents(sent), [
    ["progress", "created", "dialog", "existing_agent"],
    ["progress", "connected_seen", "dialog", "existing_agent"],
    ["closed", "done_connected", null, "existing_agent"],
  ]);
});

test("closing before Next is cancelled; discarding the agent is discarded; a failed Next is create_failed", async () => {
  const sent = captureProductEvents();
  const state = { connected: false, credentialFails: true };
  mockApi(state);
  const first = renderDialog();
  await next("Nathan");
  await screen.findByTestId("create-external-agent-error");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  first.unmount();

  state.credentialFails = false;
  let closed = false;
  renderDialog(() => { closed = true; });
  fireEvent.click(screen.getByTestId("create-external-agent-sdk"));
  await next("Nathan");
  await screen.findByTestId("create-external-agent-setup");
  await click("create-external-agent-cancel");
  // Keep is not a close: nothing is recorded for it.
  await click("create-external-agent-discard-confirm");
  await waitFor(() => assert.equal(closed, true));
  assert.deepEqual(await setupEvents(sent), [
    ["progress", "create_failed", "dialog", "existing_agent"],
    ["closed", "cancelled", null, "existing_agent"],
    ["progress", "created", "dialog", "sdk"],
    ["closed", "discarded", null, "sdk"],
  ]);
});

test("a ?dialog=connect-external-agent link is agent_create_opened with entry link_external, only when the dialog opens", async () => {
  const sent = captureProductEvents();
  const renderLink = () => render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/server/channel/general?dialog=connect-external-agent"]}>
        <ExternalAgentLinkIntent />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  setServer("member");
  const member = renderLink();
  await act(async () => undefined);
  await flushProductEvents();
  assert.deepEqual(sent.filter((item) => item.event === "agent_create_opened"), [], "a member gets no dialog and no event");
  member.unmount();

  setServer("owner");
  renderLink();
  await screen.findByTestId("create-external-agent-dialog");
  await flushProductEvents();
  assert.deepEqual(sent.filter((item) => item.event === "agent_create_opened").map((item) => item.properties.entry), ["link_external"]);
});

test("Cancel while Next is still running does nothing and is not reported: the dialog stays, only created is sent", async () => {
  const sent = captureProductEvents();
  mockApi({ connected: false });
  const post = api.post;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/agents") await held;
    return post(url, body as never);
  }) as typeof api.post;
  let closes = 0;
  renderDialog(() => { closes += 1; });
  fireEvent.change(screen.getByTestId("create-external-agent-name"), { target: { value: "Nathan" } });
  fireEvent.click(screen.getByTestId("create-external-agent-next"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => { release(); await held; });
  await screen.findByTestId("create-external-agent-setup");
  assert.equal(closes, 0);
  assert.deepEqual(await setupEvents(sent), [["progress", "created", "dialog", "existing_agent"]]);
});
