import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";

import AgentDetailPanel from "../src/components/agent/AgentDetailPanel";
import { TestIntlProvider } from "./helpers/intl";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import api from "../src/api/client";
import { ExternalAgentToken } from "../src/components/agent/ExternalAgentToken";
import { en } from "../src/i18n/messages/en";
import { zhCn as zh } from "../src/i18n/messages/zh-cn";

beforeEach(() => {
  vi.spyOn(api, "get").mockImplementation(async (url: string) => ({ data: { agentId: url.split("/")[2], credentials: [] } }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

for (const locale of ["en", "zh-cn"] as const) {
  test(`token setup uses ${locale} resources and forgets the secret on agent switch`, async (t) => {
    const messages = locale === "en" ? en : zh;
    let mints = 0;
    const old = { id: "old-token", maskedToken: "sk_agent_82aa8***", name: "Existing deployment", scopes: ["read"], createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null, revokedAt: null };
    t.mock.method(api, "get", async (url: string) => ({ data: { agentId: url.split("/")[2], credentials: [old] } }));
    const deleted: string[] = [];
    t.mock.method(api, "delete", async (url: string) => { deleted.push(url); return {}; });
    t.mock.method(api, "post", async () => {
      mints++;
      return { data: { agentId: "agent-a", credentialId: "new-token", apiKey: "sk_agent_ephemeral-fixture" } };
    });
    function panel(agentId: string) {
      return createElement(TestIntlProvider, { locale, children: createElement(ExternalAgentToken, { key: agentId, agentId }) });
    }
    const view = render(panel("agent-a"));
    await screen.findByText("Existing deployment");
    assert.ok(screen.getByText("sk_agent_82aa8***"), "old tokens show their real prefix, not a credential ID or invented suffix");
    fireEvent.click(screen.getByRole("button", { name: messages["agent.detail.externalTokenRevoke"] }));
    assert.equal(deleted.length, 0, "the destructive action requires explicit confirmation");
    fireEvent.click(screen.getByRole("button", { name: messages["agent.detail.externalTokenConfirmRevoke"] }));
    await screen.findByText(messages["agent.detail.externalTokenRevoked"]);
    assert.deepEqual(deleted, ["/agents/agent-a/credentials/old-token"]);
    fireEvent.click(screen.getByRole("button", { name: messages["agent.detail.externalTokenGenerate"] }));
    await screen.findByRole("button", { name: messages["agent.detail.externalTokenCopy"] });
    const input = screen.getByLabelText(messages["agent.detail.externalTokenLabel"]) as HTMLInputElement;
    assert.equal(input.value, "sk_agent_ephem***fixture");
    assert.ok(!document.body.innerHTML.includes("sk_agent_ephemeral-fixture"), "raw token must not be put in the DOM");
    assert.ok(input.classList.contains("min-w-0") && input.classList.contains("w-full"), "token field must fit narrow panels");
    assert.equal(input.type, "text");
    for (const [key, value] of Object.entries(en).filter(([key]) => key.startsWith("agent.detail.externalToken"))) {
      assert.ok(value && zh[key as keyof typeof zh], `${key} needs both locale resources`);
      assert.ok(!document.body.textContent?.includes(key), "never render resource keys");
    }
    view.rerender(panel("agent-b"));
    assert.equal(screen.queryByLabelText(messages["agent.detail.externalTokenLabel"]), null);
    assert.equal(mints, 1, "agent switches must not issue a token");
    assert.ok(screen.getByRole("button", { name: messages["agent.detail.externalTokenGenerate"] }));
  });
}

test("ambiguous mint failure does not retry or expose the error payload", async (t) => {
  let mints = 0;
  t.mock.method(api, "post", async () => { mints++; throw new Error("sk_agent_error-fixture"); });
  render(createElement(TestIntlProvider, { children: createElement(ExternalAgentToken, { agentId: "agent-a" }) }));
  fireEvent.click(screen.getByRole("button", { name: "Generate login token" }));
  await screen.findByRole("alert");
  assert.equal(mints, 1);
  assert.match(screen.getByRole("alert").textContent ?? "", /agent exists.*response was lost/);
  assert.ok(!document.body.innerHTML.includes("sk_agent_error-fixture"));
  assert.equal(screen.queryByRole("button", { name: "Copy token" }), null);
});

test("a late mint response from the previous agent cannot appear in the new panel", async (t) => {
  let resolveMint!: (value: unknown) => void;
  t.mock.method(api, "post", () => new Promise((resolve) => { resolveMint = resolve; }));
  function panel(agentId: string) {
    return createElement(TestIntlProvider, { children: createElement(ExternalAgentToken, { key: agentId, agentId }) });
  }
  const view = render(panel("agent-a"));
  fireEvent.click(screen.getByRole("button", { name: "Generate login token" }));
  view.rerender(panel("agent-b"));
  resolveMint({ data: { agentId: "agent-a", apiKey: "sk_agent_stale-fixture" } });
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Generate login token" })));
  assert.equal(screen.queryByRole("button", { name: "Copy token" }), null);
  assert.ok(!document.body.innerHTML.includes("sk_agent_stale-fixture"));
});

test("failed revocation keeps the token, successful revocation clears only that secret", async (t) => {
  const row = (id: string) => ({ id, name: id, createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null, revokedAt: null });
  let minted = false;
  t.mock.method(api, "get", async () => ({ data: { agentId: "agent-a", credentials: minted ? [row("new-token"), row("old-token")] : [row("old-token")] } }));
  t.mock.method(api, "post", async () => { minted = true; return { data: { agentId: "agent-a", credentialId: "new-token", apiKey: "sk_agent_revocation-fixture" } }; });
  let attempts = 0;
  t.mock.method(api, "delete", async (url: string) => {
    assert.equal(url, "/agents/agent-a/credentials/new-token");
    if (++attempts === 1) throw new Error("sk_agent_error-body");
    return {};
  });
  render(createElement(TestIntlProvider, { children: createElement(ExternalAgentToken, { agentId: "agent-a" }) }));
  await screen.findByText("old-token");
  fireEvent.click(screen.getByRole("button", { name: "Generate login token" }));
  await screen.findByText("new-token");
  fireEvent.click(screen.getAllByRole("button", { name: "Revoke token" })[0]);
  fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
  await screen.findByRole("alert");
  assert.equal((screen.getByLabelText("Agent token") as HTMLInputElement).value, "sk_agent_revoc***fixture");
  assert.equal(screen.queryByText("Revoked"), null);
  assert.ok(!document.body.innerHTML.includes("sk_agent_error-body"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
  await screen.findByText("Revoked");
  assert.equal(Boolean(screen.queryByLabelText("Agent token")), false, "successful revoke must clear the displayed secret");
  assert.equal(Boolean(screen.queryByRole("button", { name: "Copy token" })), false);
  assert.equal(screen.getAllByText("Valid").length, 1);
  assert.equal(attempts, 2);
});

test("failed token inventory is not presented as an empty list", async (t) => {
  t.mock.method(api, "get", async () => { throw new Error("sk_agent_private-response"); });
  render(createElement(TestIntlProvider, { children: createElement(ExternalAgentToken, { agentId: "agent-a" }) }));
  await screen.findByRole("alert");
  assert.equal(screen.queryByText("No tokens have been issued for this agent."), null);
  assert.ok(!document.body.innerHTML.includes("sk_agent_private-response"));
});

function renderExternalAgent(role = "owner", creatorId = "user-1") {
  const agent = {
    id: "external-agent-1",
    name: "external probe",
    displayName: "External Probe",
    runtime: "external",
    status: "idle",
    external: true,
    creatorType: "user",
    creatorId,
    deletedAt: null,
    lastRuntimeError: null,
  };
  useAuthStore.setState({ user: { id: "user-1", name: "Owner" } } as never);
  useServerStore.setState({
    current: { id: "server-1", slug: "playwright-server", name: "Playwright Server", role },
    members: [],
  } as never);
  useMachineStore.setState({ machines: [] } as never);
  useChannelStore.setState({ openDM: () => undefined } as never);
  useAgentStore.setState({
    agents: [agent],
    agentActivities: {},
    activityLogs: {},
    fetchExternalAgentStatus: async () => ({
      setupState: "connected",
      credentialLastUsedAt: null,
      lastActivityAt: null,
    }),
  } as never);

  return render(createElement(
    MemoryRouter,
    { initialEntries: ["/s/playwright-server/agent/external-agent-1"] },
    createElement(TestIntlProvider, null, createElement(AgentDetailPanel, { agent: agent as never })),
  ));
}

test("a member can generate for their own agent but not somebody else's", async () => {
  const owner = renderExternalAgent("member");
  assert.ok(await screen.findByRole("button", { name: "Generate login token" }));
  owner.unmount();
  renderExternalAgent("member", "another-user");
  assert.equal(screen.queryByRole("button", { name: "Generate login token" }), null);
});

test("external setup tabs render and switch the real AgentDetailPanel command surface", async (t) => {
  let mints = 0;
  const token = "sk_agent_web-fixture-secret";
  t.mock.method(api, "post", async (url: string) => {
    assert.equal(url, "/agents/external-agent-1/credentials");
    mints++;
    return { data: { agentId: "external-agent-1", credentialId: "new-token", apiKey: token } };
  });
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } },
  });
  t.after(() => {
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  });

  const view = renderExternalAgent();
  assert.ok(await screen.findByText("External setup"));
  assert.ok(screen.getByText("Hermes"));
  assert.ok(screen.getByText("Claude Code"));
  assert.ok(screen.getByText("Other agents"));
  assert.equal(mints, 0, "opening the setup panel must not mint credentials");
  fireEvent.click(screen.getByRole("button", { name: "Generate login token" }));
  await screen.findByRole("button", { name: "Copy token" });
  assert.equal(mints, 1);
  assert.equal((screen.getByLabelText("Agent token") as HTMLInputElement).value, "sk_agent_web-f***-secret");
  assert.equal((screen.getByLabelText("Agent token") as HTMLInputElement).type, "text");
  assert.ok(!document.body.innerHTML.includes(token));
  assert.ok(!JSON.stringify(useAgentStore.getState()).includes(token));
  fireEvent.click(screen.getByRole("button", { name: "Copy token" }));
  await waitFor(() => assert.equal(copied[0], token, "explicit copy must receive the full token, never the mask"));
  copied.length = 0;

  assert.match(document.body.textContent ?? "", /npm i -g @botiverse\/raft@latest/);
  assert.match(document.body.textContent ?? "", /RAFT_EXPECTED_AGENT_ID=external-agent-1 hermes gateway setup/);
  assert.doesNotMatch(document.body.textContent ?? "", /RAFT_CHANNEL_TOKEN|RAFT_CHANNEL_PORT|hermes gateway run/);

  fireEvent.click(screen.getByText("Claude Code"));
  await waitFor(() => assert.match(document.body.textContent ?? "", /claude plugin marketplace add botiverse\/raft-external-agents/));
  assert.match(document.body.textContent ?? "", /claude plugin update raft-channel@raft/);
  assert.match(document.body.textContent ?? "", /RAFT_EXPECTED_AGENT_ID=external-agent-1 RAFT_PROFILE=external-probe claude/);
  assert.match(document.body.textContent ?? "", /--append-system-prompt 'You are connected to Raft/);
  assert.match(document.body.textContent ?? "", /--dangerously-load-development-channels plugin:raft-channel@raft/);

  fireEvent.click(screen.getByText("Other agents"));
  await waitFor(() => assert.match(document.body.textContent ?? "", /raft agent login --server/));
  assert.doesNotMatch(document.body.textContent ?? "", /raft agent login (start|wait)|device_code/);
  fireEvent.click(screen.getByRole("button", { name: /copy setup/i }));
  await waitFor(() => assert.equal(copied.length, 1));
  assert.match(copied[0] ?? "", /raft agent login --server/);
  assert.match(copied[0] ?? "", /hidden login prompt/);
  assert.ok(!copied[0].includes(token));
  assert.equal(mints, 1, "switching tabs must not mint another token");
  assert.doesNotMatch(copied[0] ?? "", /hermes gateway setup|claude plugin/);
  const nextAgent = { ...useAgentStore.getState().agents[0], id: "external-agent-2", name: "next probe" };
  view.rerender(createElement(MemoryRouter, null,
    createElement(TestIntlProvider, { children: createElement(AgentDetailPanel, { agent: nextAgent as never }) })));
  assert.equal(Boolean(screen.queryByRole("button", { name: "Copy token" })), false, "the real detail panel must discard the previous agent's token");
});
