import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import AgentDetailPanel from "../src/components/agent/AgentDetailPanel";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";

// Runtime-error sentinel render-path tooth (@Wug 2026-08-04): the AgentDetail
// banner must show the classified catalog copy for a KNOWN runtime error under
// zh, and the generic fallback for an UNKNOWN one — never the raw English.

const noop = () => {};

function seedStores(agent: Record<string, unknown>) {
  useAuthStore.setState({ user: { id: "user-1", name: "Owner" } } as never);
  useServerStore.setState({
    current: { id: "server-1", slug: "playwright-server", name: "Playwright Server", role: "owner" },
    members: [],
  } as never);
  useMachineStore.setState({ machines: [] } as never);
  useChannelStore.setState({ openDM: noop } as never);
  useAgentStore.setState({
    agents: [agent],
    activityLogs: {},
  } as never);
}

function renderAgentZh(agent: Record<string, unknown>) {
  seedStores(agent);
  return render(
    <MemoryRouter>
      <TestIntlProvider locale="zh-cn">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  useAgentStore.setState({ agents: [], activityLogs: {} } as never);
  useServerStore.setState({ current: null, members: [] } as never);
  useAuthStore.setState({ user: null } as never);
});

test("known runtime error renders the classified zh in the agent banner", async () => {
  const agent = {
    id: "agent-1",
    name: "witty",
    runtime: "claude",
    status: "active",
    lastRuntimeError: { message: "Claude Code is not logged in on this machine. Please log in locally, then retry." },
  };
  renderAgentZh(agent);

  assert.ok(await screen.findByText("该运行时未在此计算机上登录"));
  assert.equal(screen.queryByText(/is not logged in/), null);
});

test("unknown runtime error stays verbatim for the creator — never mistranslated", async () => {
  // @Wug boundary: unknown errors are NOT substring-translated. For the
  // creator view the raw text stays (verbatim, per the boundary); it must
  // never be wrongly classified into a known-kind zh message.
  const agent = {
    id: "agent-2",
    name: "mystery",
    runtime: "claude",
    status: "active",
    lastRuntimeError: { message: "The daemon lost its connection to the workspace broker." },
  };
  renderAgentZh(agent);

  assert.ok(await screen.findByText(/workspace broker/), "unknown error stays verbatim for the creator");
  assert.equal(screen.queryByText("该运行时未在此计算机上登录"), null, "no wrong classification");
  assert.equal(screen.queryByText("该运行时未安装在此计算机上"), null);
});

test("typed runtime error surfaces the authoritative daemon class/reason/fingerprint (#688d)", async () => {
  const agent = {
    id: "agent-3",
    name: "typed",
    runtime: "claude",
    status: "active",
    lastRuntimeError: {
      message: "Authentication failed: not logged in on this machine.",
      errorClass: "AuthError",
      errorReason: "auth_failed",
      fingerprint: "abcd1234567890ef",
      reasonProvenance: "daemon_fallback",
    },
  };
  renderAgentZh(agent);

  // Authoritative typed auth class/reason drives the catalog copy (auth_failed → authFailed label).
  assert.ok(await screen.findByText("运行时身份验证失败"), "typed auth class maps to catalog copy");
  // The typed class/reason/fingerprint ride in the diagnostic payload (copy/debug surface),
  // not the banner text — wait for the label, then confirm no wrong untyped classification.
  assert.equal(screen.queryByText("该运行时未在此计算机上登录"), null, "typed auth must not fall to the untyped notLoggedIn label");
});

test("unknown-type runtime error stays verbatim even with typed fields present if reason is unmapped (#688d)", async () => {
  const agent = {
    id: "agent-4",
    name: "typed-unknown",
    runtime: "claude",
    status: "active",
    lastRuntimeError: {
      message: "The daemon lost its connection to the workspace broker.",
      errorClass: "ProviderConnectionError",
      errorReason: "provider_connection_error",
      fingerprint: "ffff000011112222",
      reasonProvenance: "daemon_fallback",
    },
  };
  renderAgentZh(agent);

  assert.ok(await screen.findByText(/workspace broker/), "unknown typed error stays verbatim");
  assert.equal(screen.queryByText("该运行时未在此计算机上登录"), null, "no wrong classification");
});
