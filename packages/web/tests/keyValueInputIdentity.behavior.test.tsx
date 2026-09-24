import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { getCreatableRuntimeOptions } from "@botiverse/raft-shared";
import type { RuntimeSelectionOption } from "@botiverse/raft-shared";
import CreateAgentDialog from "../src/components/agent/CreateAgentDialog";
import { AgentMcpTab } from "../src/components/agent/AgentMcpTab";
import api from "../src/api/client";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

/**
 * Every key/value input must be individually addressable — its own DOM id, and
 * its own accessible name.
 *
 * Found in review by @Dozy on PR #7010. After the raft-ui Input migration, all
 * four inputs of a two-row Environment Variables list shared ONE id and all
 * announced as "Environment Variables": Base UI's Field context hands every
 * Input beneath it the same control id and the same `aria-labelledby`, so a
 * screen-reader user heard the group's label four times and could not tell the
 * key box from the value box, let alone one row from another.
 *
 * Both real consumers are driven here rather than a stand-in row. That is the
 * point: the defect lives in how the shared row interacts with the Field context
 * its CALLSITE puts it in, so a hand-built harness has no context to get wrong
 * and would pass no matter what the production tree does. (I have shipped that
 * mistake three times; see #6804 and #7034.)
 */

const originalGet = api.get;

/**
 * Resolve what a control actually announces, with the real precedence.
 *
 * Asserting `aria-label` alone would be a false green: throughout the bug the
 * `aria-label` was present and correct, and an inherited `aria-labelledby`
 * silently outranked it. Only the resolved name can tell the two apart.
 */
function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
  }
  return el.getAttribute("aria-label")?.trim() ?? "";
}

function assertIndividuallyAddressable(inputs: HTMLInputElement[], surface: string) {
  assert.ok(inputs.length >= 4, `${surface}: need two full rows to prove uniqueness, got ${inputs.length} inputs`);

  const ids = inputs.map((el) => el.id);
  assert.ok(ids.every(Boolean), `${surface}: every input needs an id, got ${JSON.stringify(ids)}`);
  assert.equal(
    new Set(ids).size,
    ids.length,
    `${surface}: duplicate DOM ids — ${JSON.stringify(ids)}. Base UI hands every Input in one Field context the SAME control id; each input needs its own Field to keep its own.`,
  );

  const names = inputs.map(accessibleName);
  assert.ok(
    names.every(Boolean),
    `${surface}: every input needs an accessible name, got ${JSON.stringify(names)}`,
  );
  /*
   * Compared PAIRWISE, not globally unique. Two rows' key boxes legitimately
   * share one name ("Header name") — the row is told apart by the value box,
   * whose name interpolates that row's key. What must never happen is key and
   * value announcing the SAME thing, which is exactly the shape of the bug:
   * every control inheriting the group's label.
   */
  for (let row = 0; row < names.length; row += 2) {
    assert.notEqual(
      names[row],
      names[row + 1],
      `${surface}: row ${row / 2} announces "${names[row]}" for BOTH its key and its value — one label is covering the whole row, so the two boxes are indistinguishable.`,
    );
  }
}

function runtimeOption(runtimeId: string, available: boolean): RuntimeSelectionOption {
  return {
    runtimeId, capabilityStatus: available ? "available" : "not_installed",
    admissionStatus: "available_for_new", admissionReason: null, current: false,
    availableForNew: true, manageableForCurrentAgent: false, canSelectInThisContext: available,
  };
}

function seedStores() {
  useServerStore.setState({
    current: { id: "server-1", name: "Launch", slug: "launch", avatarUrl: null, ownerId: "owner-1", onboardingAgentId: null, hideHumansFromMembers: false, plan: "free", planDowngradedAt: null, role: "owner", createdAt: "2026-07-14T00:00:00.000Z" },
    billing: null, loadBilling: async () => undefined,
  } as never);
  useMachineStore.setState({
    machines: [{ id: "machine-1", name: "Mac", description: null, status: "online", statusVersion: 1, apiKeyPrefix: null, runtimes: ["claude"], hostname: "mac.local", os: "darwin", daemonVersion: "0.72.6", lastHeartbeat: "2026-07-14T00:00:00.000Z", createdAt: "2026-07-14T00:00:00.000Z" }],
  } as never);
  useChannelStore.setState({ channels: [] } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
  api.get = (async (url: string) => {
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: getCreatableRuntimeOptions().filter((r) => r.id !== "grok").map((r) => runtimeOption(r.id, r.id === "claude")) } } as never;
    }
    return { data: { kind: "unsupported" } } as never;
  }) as typeof api.get;
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAgentStore.setState({ agents: [], loading: false } as never);
  useServerStore.setState({ current: null } as never);
});

test("Create Agent env-var rows are each individually addressable", async () => {
  seedStores();
  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <TestIntlProvider locale="en"><CreateAgentDialog onClose={() => undefined} /></TestIntlProvider>
    </MemoryRouter>,
  );
  await waitFor(() => assert.equal(screen.getAllByRole("combobox").length > 0, true));
  for (const label of [/^More$/i, /^Advanced$/i]) {
    const buttons = screen.queryAllByRole("button", { name: label });
    if (buttons.length) fireEvent.click(buttons[buttons.length - 1]);
  }

  const addVariable = await waitFor(() => {
    const [button] = screen.queryAllByRole("button", { name: /add variable/i });
    assert.ok(button, "the env-vars consumer must render its add control");
    return button;
  });
  fireEvent.click(addVariable);
  fireEvent.click(addVariable);

  const keys = await waitFor(() => {
    const found = screen.queryAllByPlaceholderText("KEY");
    assert.equal(found.length, 2, "two env-var rows must render");
    return found;
  });
  // Distinct keys: the value input's name is interpolated from its own row's
  // key, so this also proves rows are told apart, not just key from value.
  fireEvent.change(keys[0], { target: { value: "RAFT_PROFILE" } });
  fireEvent.change(keys[1], { target: { value: "RAFT_HOME" } });

  const inputs = [...document.querySelectorAll<HTMLInputElement>("input")]
    .filter((el) => el.placeholder === "KEY" || el.placeholder === "value");
  assertIndividuallyAddressable(inputs, "env vars");

  const names = inputs.map(accessibleName);
  assert.deepEqual(
    names,
    ["Environment variable name", "Value for RAFT_PROFILE", "Environment variable name", "Value for RAFT_HOME"],
    "each input must announce its own role in its own row",
  );
  // The exact regression: the group's label leaking onto its controls.
  assert.equal(
    names.some((name) => /^Environment Variables$/i.test(name)),
    false,
    "no input may announce the enclosing field's group label",
  );
});

test("MCP credential-header rows are each individually addressable", async () => {
  api.get = (async () => ({ data: { servers: [], recommendations: [] } }) as never) as typeof api.get;
  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <TestIntlProvider locale="en"><AgentMcpTab scope="server" canManageServer /></TestIntlProvider>
    </MemoryRouter>,
  );
  const addServer = await waitFor(() => {
    const [button] = screen.queryAllByRole("button", { name: /add server/i });
    assert.ok(button, "the MCP editor must be reachable");
    return button;
  });
  fireEvent.click(addServer);

  const authTrigger = await waitFor(() => {
    const found = screen.getAllByRole("combobox").find((el) => /none/i.test(el.textContent ?? ""));
    assert.ok(found, "the authentication select must render");
    return found;
  });
  authTrigger.focus();
  fireEvent.keyDown(authTrigger, { key: "ArrowDown" });
  const listbox = await screen.findByRole("listbox");
  const headerMode = within(listbox).getByRole("option", { name: /credential headers/i });
  fireEvent.pointerDown(headerMode, { pointerType: "mouse" });
  fireEvent.click(headerMode);

  const addHeader = await waitFor(() => {
    const [button] = screen.queryAllByRole("button", { name: /add header/i });
    assert.ok(button, "credential-header mode must render its add control");
    return button;
  });
  fireEvent.click(addHeader);
  fireEvent.click(addHeader);

  const keys = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLInputElement>("input")]
      .filter((el) => accessibleName(el) === "Header name");
    assert.equal(found.length, 2, "two credential-header rows must render");
    return found;
  });
  fireEvent.change(keys[0], { target: { value: "Authorization" } });
  fireEvent.change(keys[1], { target: { value: "X-Api-Key" } });

  const inputs = [...document.querySelectorAll<HTMLInputElement>("input")]
    .filter((el) => /^(Header name|Value for )/.test(accessibleName(el)));
  assertIndividuallyAddressable(inputs, "MCP credential headers");

  assert.deepEqual(
    inputs.map(accessibleName),
    ["Header name", "Value for Authorization", "Header name", "Value for X-Api-Key"],
    "each input must announce its own role in its own row",
  );
});
