import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

import SlackBridgeSetupWizard from "../src/components/settings/SlackBridgeSetupWizard";
import type {
  SlackBridgeProvisioningProvider,
  SlackBridgeProvisioningView,
  SlackBridgeSetupSnapshot,
} from "../src/components/settings/slackBridgeProvisioning";
import { renderWithIntl } from "./helpers/intl";

afterEach(cleanup);

const rawHealth = {
  install: {
    state: "active" as const,
    epochs: { grant: "g1", connection: "c1", scope: "s1", credential: "k1" },
  },
  credential: { state: "active" as const },
  bindings: [{ id: "binding-1", state: "active" as const }],
  audiences: [{ bindingId: "binding-1", status: "matched" as const }],
  lastVerifiedAt: "2032-01-02T03:04:05.000Z",
  failingSurface: null,
};

function snapshot(stage: SlackBridgeSetupSnapshot["stage"]): SlackBridgeSetupSnapshot {
  return {
    stage,
    workspaceName: stage === "connect" ? null : "Acme Slack",
    raftChannels: [
      { id: "raft-general", name: "general" },
      { id: "raft-support", name: "support" },
    ],
    slackChannels: [
      { id: "slack-general", name: "general", isMember: true },
      { id: "slack-support", name: "support", isMember: true },
    ],
    channelPairs: stage === "health"
      ? [{ raftChannelId: "raft-general", slackChannelId: "slack-general", bindingEpoch: 7 }]
      : [],
    preflight: stage === "enable" || stage === "health"
      ? {
        state: "passed",
        checks: [
          { id: "oauth", state: "passed" },
          { id: "endpoint", state: "passed" },
          { id: "scope", state: "passed" },
          { id: "audience", state: "passed" },
        ],
      }
      : null,
    rawHealth,
  };
}

async function selectOption(label: "Raft channel" | "Slack channel", optionName: string) {
  const trigger = screen.getByRole("combobox", { name: label });
  assert.equal(trigger.tagName, "BUTTON", `${label} must use the raft-ui Select trigger`);
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
}

function ready(stage: SlackBridgeSetupSnapshot["stage"]): SlackBridgeProvisioningView {
  return { kind: "ready", snapshot: snapshot(stage) };
}

test("an unavailable production provider does not manufacture a Connect success path", async () => {
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => { throw new Error("provider unavailable"); },
    connect: async () => ready("oauth"),
    beginOAuth: async () => ({ kind: "view", view: ready("channels") }),
    saveChannelPairs: async () => ready("preflight"),
    runPreflight: async () => ready("enable"),
    enable: async () => ready("health"),
  };

  renderWithIntl(<SlackBridgeSetupWizard canManage provider={provider} />);

  await screen.findByText("The Slack bridge operation failed. No setup state was assumed.");
  assert.equal(screen.queryByRole("button", { name: "Connect with Slack" }), null);
});

test("wizard keeps only OAuth consent and channel choice manual, then verifies and enables automatically", async () => {
  const calls: string[] = [];
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => ready("connect"),
    connect: async () => {
      calls.push("connect");
      return ready("oauth");
    },
    beginOAuth: async () => {
      calls.push("oauth");
      return { kind: "view", view: ready("channels") };
    },
    saveChannelPairs: async (pairs) => {
      calls.push(`pairs:${pairs[0]?.raftChannelId}:${pairs[0]?.slackChannelId}`);
      return ready("preflight");
    },
    runPreflight: async () => {
      calls.push("preflight");
      return ready("enable");
    },
    enable: async () => {
      calls.push("enable");
      return ready("health");
    },
  };

  renderWithIntl(<SlackBridgeSetupWizard canManage provider={provider} />);

  const progress = await screen.findByLabelText("Slack bridge setup progress");
  assert.equal(progress.childElementCount, 3, "the setup rail must expose only Connect, Channels, and Health");
  fireEvent.click(screen.getByRole("button", { name: "Connect with Slack" }));

  await screen.findByText("Choose channel pairs");
  await selectOption("Raft channel", "#general");
  await selectOption("Slack channel", "#general");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("button", { name: "Save mappings and enable" }));

  await screen.findByText("Connected");
  await screen.findByText("Last verified Jan 2, 2032, 3:04 AM");
  await waitFor(() => assert.deepEqual(calls, [
    "connect",
    "oauth",
    "pairs:raft-general:slack-general",
    "preflight",
    "enable",
  ]));
  assert.equal(document.body.textContent?.includes("g1"), false, "raw epochs are never rendered");
});

test("channel mapping uses Raft selectors and blocks Slack channels the app has not joined", async () => {
  const channels = ready("channels");
  if (channels.kind !== "ready") throw new Error("channels fixture required");
  channels.snapshot.slackChannels = [
    { id: "slack-unjoined", name: "unjoined", isMember: false },
    { id: "slack-joined", name: "joined", isMember: true },
  ];
  const refreshed = ready("channels");
  if (refreshed.kind !== "ready") throw new Error("refreshed channels fixture required");
  refreshed.snapshot.slackChannels = [
    { id: "slack-unjoined", name: "unjoined", isMember: true },
    { id: "slack-joined", name: "joined", isMember: true },
  ];
  let loadCalls = 0;
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => {
      loadCalls += 1;
      return loadCalls === 1 ? channels : refreshed;
    },
    connect: async () => ready("oauth"),
    beginOAuth: async () => ({ kind: "view", view: channels }),
    saveChannelPairs: async () => ready("preflight"),
    runPreflight: async () => ready("enable"),
    enable: async () => ready("health"),
  };

  renderWithIntl(<SlackBridgeSetupWizard canManage provider={provider} />);

  const raftTrigger = await screen.findByRole("combobox", { name: "Raft channel" });
  const slackTrigger = screen.getByRole("combobox", { name: "Slack channel" });
  assert.equal(raftTrigger.tagName, "BUTTON");
  assert.equal(slackTrigger.tagName, "BUTTON");
  assert.equal(screen.queryByText("Invite the Raft app before mapping channels"), null);
  assert.equal(screen.queryByText("Open each destination channel in Slack and invite the Raft app."), null);
  assert.ok(screen.getByText("1 channel ready to pair · 1 needs the Raft app invited"));
  const pairGrid = screen.getByTestId("slack-bridge-channel-pair-grid");
  const pairActions = screen.getByTestId("slack-bridge-channel-pair-actions");
  const membershipHint = screen.getByTestId("slack-bridge-channel-membership-hint");
  const addButton = screen.getByRole("button", { name: "Add" });
  const refreshButton = screen.getByRole("button", { name: "Refresh" });
  assert.ok(pairGrid.className.includes("sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"));
  for (const className of ["flex", "items-center", "gap-2", "self-end", "sm:col-start-3", "sm:row-start-1"]) {
    assert.ok(pairActions.className.split(" ").includes(className), `action group must include ${className}`);
  }
  for (const className of ["sm:col-start-2", "sm:row-start-2"]) {
    assert.ok(membershipHint.className.split(" ").includes(className), `membership hint must include ${className}`);
  }
  const pairGridChildren = Array.from(pairGrid.children);
  assert.deepEqual(
    [
      pairGridChildren.findIndex((child) => child.contains(raftTrigger)),
      pairGridChildren.findIndex((child) => child.contains(slackTrigger)),
      pairGridChildren.indexOf(membershipHint),
      pairGridChildren.indexOf(pairActions),
    ],
    [0, 1, 2, 3],
    "mobile DOM order must be Raft selector, Slack selector, membership hint, then actions",
  );
  assert.ok(addButton.className.split(" ").includes("h-8"));
  assert.ok(refreshButton.className.split(" ").includes("h-8"));

  fireEvent.click(slackTrigger);
  assert.equal(
    screen.getByRole("option", { name: "#unjoined — invite the Raft app in Slack" }).getAttribute("aria-disabled"),
    "true",
  );
  assert.equal(screen.getByRole("option", { name: "#joined" }).getAttribute("aria-disabled"), null);
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => {
    assert.equal(screen.queryByRole("option", { name: "#unjoined — invite the Raft app in Slack" }), null);
  });

  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("2 channels ready to pair · 0 need the Raft app invited");
  fireEvent.click(screen.getByRole("combobox", { name: "Slack channel" }));
  assert.equal(
    screen.getByRole("option", { name: "#unjoined" }).getAttribute("aria-disabled"),
    null,
  );
  assert.equal(loadCalls, 2);
});

test("a removed Slack app membership shows an exact recovery card and clears after recheck", async () => {
  const missing = ready("health");
  const recovered = ready("health");
  if (missing.kind !== "ready" || recovered.kind !== "ready") throw new Error("health fixtures required");
  missing.snapshot.slackChannels = [
    { id: "slack-general", name: "general", isMember: false },
    { id: "slack-support", name: "support", isMember: true },
  ];
  missing.snapshot.rawHealth = {
    ...missing.snapshot.rawHealth,
    audiences: [{ bindingId: "binding-1", status: "mismatch" }],
    failingSurface: "audience",
  };
  let loadCalls = 0;
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => {
      loadCalls += 1;
      return loadCalls === 1 ? missing : recovered;
    },
    connect: async () => ready("oauth"),
    beginOAuth: async () => ({ kind: "view", view: ready("channels") }),
    saveChannelPairs: async () => ready("preflight"),
    runPreflight: async () => ready("enable"),
    enable: async () => ready("health"),
  };

  renderWithIntl(<SlackBridgeSetupWizard canManage provider={provider} />);

  await screen.findByText("Slack channel access was removed");
  assert.ok(screen.getByText(
    "Message sync is paused for #general. Invite the Raft app back to the affected channel, then refresh and recheck.",
  ));
  fireEvent.click(screen.getByRole("button", { name: "How to invite the app" }));
  assert.ok(screen.getByText("Open channel settings or Integrations and invite the Raft app."));

  fireEvent.click(screen.getByRole("button", { name: "Refresh and recheck" }));
  await screen.findByText("Connected");
  assert.equal(screen.queryByText("Slack channel access was removed"), null);
  assert.equal(loadCalls, 2);
});

test("a mapped private channel missing from Slack inventory gets recovery without a false removal claim", async () => {
  const missing = ready("health");
  if (missing.kind !== "ready") throw new Error("health fixture required");
  missing.snapshot.slackChannels = [
    { id: "slack-general", name: "Slack channel C_PRIVATE", privacyClass: "private" },
  ];
  missing.snapshot.rawHealth = {
    ...missing.snapshot.rawHealth,
    audiences: [{ bindingId: "binding-1", status: "mismatch" }],
    failingSurface: "audience",
  };
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => missing,
    connect: async () => ready("oauth"),
    beginOAuth: async () => ({ kind: "view", view: ready("channels") }),
    saveChannelPairs: async () => ready("preflight"),
    runPreflight: async () => ready("enable"),
    enable: async () => ready("health"),
  };

  renderWithIntl(<SlackBridgeSetupWizard canManage provider={provider} />);

  await screen.findByText("Slack channel access needs attention");
  assert.ok(screen.getByText(
    "Message sync is paused because Raft could not verify access to a mapped Slack channel. Confirm that the Raft app is still in the channel, then refresh and recheck.",
  ));
  assert.equal(screen.queryByText("Slack channel access was removed"), null);
  assert.ok(screen.getByRole("button", { name: "Refresh and recheck" }));
});

test("failed preflight remains visible with typed checks and a retry action", async () => {
  const failed = ready("preflight");
  if (failed.kind !== "ready") throw new Error("test fixture must be ready");
  failed.snapshot.preflight = {
    state: "failed",
    checks: [
      { id: "oauth", state: "passed" },
      { id: "endpoint", state: "failed" },
      { id: "scope", state: "passed" },
      { id: "audience", state: "failed" },
    ],
  };
  let preflightCalls = 0;
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => ready("preflight"),
    connect: async () => ready("oauth"),
    beginOAuth: async () => ({ kind: "view", view: ready("channels") }),
    saveChannelPairs: async () => ready("preflight"),
    runPreflight: async () => {
      preflightCalls += 1;
      return failed;
    },
    enable: async () => ready("health"),
  };

  renderWithIntl(<SlackBridgeSetupWizard canManage provider={provider} />);

  fireEvent.click(await screen.findByRole("button", { name: "Verify and finish setup" }));
  await screen.findByText("Preflight has not passed. The bridge cannot be enabled.");
  assert.ok(screen.getByText("OAuth grant"));
  assert.ok(screen.getByText("Hosted endpoint"));
  assert.ok(screen.getByText("Granted scopes"));
  assert.ok(screen.getByText("Channel audience"));
  assert.equal(screen.getAllByText("Failed").length, 2);
  assert.equal(screen.getAllByText("Passed").length, 2);
  fireEvent.click(screen.getByRole("button", { name: "Verify and finish setup" }));
  await waitFor(() => assert.equal(preflightCalls, 2));
  assert.equal(screen.queryByText("All preflight checks passed."), null);
});

test("enable fails closed when a passed aggregate has incomplete or failed required checks", async () => {
  const view = ready("enable");
  if (view.kind !== "ready") throw new Error("test fixture must be ready");
  view.snapshot.preflight = {
    state: "passed",
    checks: [
      { id: "oauth", state: "failed" },
      { id: "endpoint", state: "passed" },
      { id: "scope", state: "passed" },
    ],
  };
  let preflightCalls = 0;
  let enableCalls = 0;
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => view,
    connect: async () => ready("oauth"),
    beginOAuth: async () => ({ kind: "view", view: ready("channels") }),
    saveChannelPairs: async () => ready("preflight"),
    runPreflight: async () => {
      preflightCalls += 1;
      return view;
    },
    enable: async () => {
      enableCalls += 1;
      return ready("health");
    },
  };

  renderWithIntl(<SlackBridgeSetupWizard canManage provider={provider} />);

  await screen.findByText("Preflight has not passed. The bridge cannot be enabled.");
  assert.equal(screen.queryByText("All preflight checks passed."), null);
  assert.ok(screen.getByText("Channel audience"));
  assert.ok(screen.getByText("Unverified"));
  assert.ok(screen.getByRole("button", { name: "Verify and finish setup" }));
  fireEvent.click(screen.getByRole("button", { name: "Verify and finish setup" }));
  await waitFor(() => assert.equal(preflightCalls, 1));
  assert.equal(enableCalls, 0, "an incomplete passed aggregate must not enable delivery");
});

test("a resumed Enable needs one click, and an enable rejection retries preflight before trying again", async () => {
  let current = ready("enable");
  if (current.kind !== "ready") throw new Error("test fixture must be ready");
  let preflightCalls = 0;
  let enableCalls = 0;
  const passed = {
    state: "passed" as const,
    checks: [
      { id: "oauth" as const, state: "passed" as const },
      { id: "endpoint" as const, state: "passed" as const },
      { id: "scope" as const, state: "passed" as const },
      { id: "audience" as const, state: "passed" as const },
    ],
  };
  const failed = {
    state: "failed" as const,
    checks: [
      { id: "oauth" as const, state: "passed" as const },
      { id: "endpoint" as const, state: "failed" as const },
      { id: "scope" as const, state: "passed" as const },
      { id: "audience" as const, state: "failed" as const },
    ],
  };
  current.snapshot.preflight = passed;
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => ({ kind: "ready", snapshot: current.snapshot }),
    connect: async () => ready("oauth"),
    beginOAuth: async () => ({ kind: "view", view: ready("channels") }),
    saveChannelPairs: async () => ready("preflight"),
    runPreflight: async () => {
      preflightCalls += 1;
      current = {
        ...current,
        snapshot: {
          ...current.snapshot,
          preflight: passed,
        },
      };
      return { kind: "ready", snapshot: current.snapshot };
    },
    enable: async () => {
      enableCalls += 1;
      if (enableCalls > 1) {
        current = { ...current, snapshot: { ...snapshot("health"), preflight: passed } };
        return { kind: "ready", snapshot: current.snapshot };
      }
      current = {
        ...current,
        snapshot: {
          ...current.snapshot,
          preflight: failed,
        },
      };
      return { kind: "ready", snapshot: current.snapshot };
    },
  };

  renderWithIntl(<SlackBridgeSetupWizard canManage provider={provider} />);

  fireEvent.click(await screen.findByRole("button", { name: "Verify and finish setup" }));
  await screen.findByRole("button", { name: "Verify and finish setup" });
  assert.equal(enableCalls, 1);

  fireEvent.click(screen.getByRole("button", { name: "Verify and finish setup" }));
  await waitFor(() => assert.equal(preflightCalls, 1));
  await screen.findByText("Connected");
  assert.equal(enableCalls, 2);
});

test("read-only viewers see health but cannot mutate provisioning", async () => {
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => ready("health"),
    connect: async () => ready("oauth"),
    beginOAuth: async () => ({ kind: "view", view: ready("channels") }),
    saveChannelPairs: async () => ready("preflight"),
    runPreflight: async () => ready("enable"),
    enable: async () => ready("health"),
  };

  renderWithIntl(<SlackBridgeSetupWizard canManage={false} provider={provider} />);

  await screen.findByText("Connected");
  await screen.findByText("#general ↔ #general");
  assert.equal(screen.queryByRole("button", { name: "Verify and finish setup" }), null);
  assert.equal(screen.queryByRole("button", { name: "Manage channel mappings" }), null);
  assert.equal(screen.queryByRole("button", { name: "Disconnect Slack workspace" }), null);
});

test("connected managers confirm the exact connection epoch before disconnecting the workspace", async () => {
  const current = ready("health");
  if (current.kind !== "ready" || !current.snapshot.rawHealth.install) throw new Error("health fixture required");
  current.snapshot.rawHealth.install.epochs.connection = "11";
  const calls: number[] = [];
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => current,
    connect: async () => ready("oauth"),
    beginOAuth: async () => ({ kind: "view", view: ready("channels") }),
    saveChannelPairs: async () => ready("preflight"),
    runPreflight: async () => ready("enable"),
    enable: async () => ready("health"),
    disconnect: async (expectedConnectionEpoch) => {
      calls.push(expectedConnectionEpoch);
      return ready("connect");
    },
  };

  renderWithIntl(<SlackBridgeSetupWizard canManage provider={provider} />);

  fireEvent.click(await screen.findByRole("button", { name: "Disconnect Slack workspace" }));
  await screen.findByText(/revokes this Raft Server's Slack credential/);
  assert.deepEqual(calls, [], "the first destructive click must only open confirmation");
  fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));

  await screen.findByRole("button", { name: "Connect with Slack" });
  assert.deepEqual(calls, [11]);
  assert.equal(screen.queryByText("Acme Slack"), null);
  assert.equal(screen.queryByText("#general ↔ #general"), null);
});

test("connected managers preserve existing pairs while adding another mapping", async () => {
  const savedPairs: Array<Array<{ raftChannelId: string; slackChannelId: string }>> = [];
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => ready("health"),
    connect: async () => ready("oauth"),
    beginOAuth: async () => ({ kind: "view", view: ready("channels") }),
    saveChannelPairs: async (pairs) => {
      savedPairs.push(pairs);
      const view = ready("preflight");
      if (view.kind === "ready") view.snapshot.channelPairs = pairs;
      return view;
    },
    runPreflight: async () => ready("enable"),
    enable: async () => ready("health"),
  };

  renderWithIntl(<SlackBridgeSetupWizard canManage provider={provider} />);

  await screen.findByText("#general ↔ #general");
  fireEvent.click(screen.getByRole("button", { name: "Manage channel mappings" }));
  await screen.findByText("Choose channel pairs");
  assert.ok(screen.getByText("#general ↔ #general"));

  await selectOption("Raft channel", "#support");
  await selectOption("Slack channel", "#support");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply mapping changes" }));

  await screen.findByText("Connected");
  assert.deepEqual(savedPairs, [[
    { raftChannelId: "raft-general", slackChannelId: "slack-general" },
    { raftChannelId: "raft-support", slackChannelId: "slack-support" },
  ]]);
});

test("connected managers remove a mapping through its exact epoch without an omission PUT", async () => {
  const calls: string[] = [];
  let current = snapshot("health");
  const view = (): SlackBridgeProvisioningView => ({ kind: "ready", snapshot: current });
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => view(),
    connect: async () => ready("oauth"),
    beginOAuth: async () => ({ kind: "view", view: ready("channels") }),
    removeChannelPair: async (pair) => {
      calls.push(`remove:${pair.raftChannelId}:${pair.slackChannelId}:${pair.expectedBindingEpoch}`);
      current = {
        ...current,
        channelPairs: current.channelPairs.filter((candidate) =>
          candidate.raftChannelId !== pair.raftChannelId || candidate.slackChannelId !== pair.slackChannelId),
      };
      return view();
    },
    saveChannelPairs: async () => {
      calls.push("unexpected-save");
      throw new Error("pure deletion must not PUT an omitted protected binding");
    },
    runPreflight: async () => {
      calls.push("unexpected-preflight");
      return ready("enable");
    },
    enable: async () => {
      calls.push("unexpected-enable");
      return ready("health");
    },
  };

  renderWithIntl(<SlackBridgeSetupWizard canManage provider={provider} />);

  await screen.findByText("#general ↔ #general");
  fireEvent.click(screen.getByRole("button", { name: "Manage channel mappings" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove pair" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply mapping changes" }));

  await screen.findByText("Connected");
  await waitFor(() => assert.deepEqual(calls, ["remove:raft-general:slack-general:7"]));
});

test("a missing binding epoch fails closed before DELETE or PUT", async () => {
  const calls: string[] = [];
  const current = {
    ...snapshot("health"),
    channelPairs: [{ raftChannelId: "raft-general", slackChannelId: "slack-general" }],
  };
  const view = (): SlackBridgeProvisioningView => ({ kind: "ready", snapshot: current });
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => view(),
    connect: async () => ready("oauth"),
    beginOAuth: async () => ({ kind: "view", view: ready("channels") }),
    removeChannelPair: async () => {
      calls.push("unexpected-remove");
      return view();
    },
    saveChannelPairs: async () => {
      calls.push("unexpected-save");
      return ready("preflight");
    },
    runPreflight: async () => ready("enable"),
    enable: async () => ready("health"),
  };

  renderWithIntl(<SlackBridgeSetupWizard canManage provider={provider} />);

  await screen.findByText("#general ↔ #general");
  fireEvent.click(screen.getByRole("button", { name: "Manage channel mappings" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove pair" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply mapping changes" }));

  await screen.findByText("The Slack bridge operation failed. No setup state was assumed.");
  assert.deepEqual(calls, []);
});

test("connected managers replace one exact binding, preserve its sibling, then preflight and enable", async () => {
  const calls: string[] = [];
  let current: SlackBridgeSetupSnapshot = {
    ...snapshot("health"),
    raftChannels: [
      { id: "raft-general", name: "general" },
      { id: "raft-support", name: "support" },
    ],
    slackChannels: [
      { id: "slack-general", name: "general", isMember: true },
      { id: "slack-replacement", name: "replacement", isMember: true },
      { id: "slack-support", name: "support", isMember: true },
    ],
    channelPairs: [
      { raftChannelId: "raft-general", slackChannelId: "slack-general", bindingEpoch: 7 },
      { raftChannelId: "raft-support", slackChannelId: "slack-support", bindingEpoch: 3 },
    ],
  };
  const view = (): SlackBridgeProvisioningView => ({ kind: "ready", snapshot: current });
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => view(),
    connect: async () => ready("oauth"),
    beginOAuth: async () => ({ kind: "view", view: ready("channels") }),
    removeChannelPair: async (pair) => {
      calls.push(`remove:${pair.raftChannelId}:${pair.slackChannelId}:${pair.expectedBindingEpoch}`);
      current = {
        ...current,
        channelPairs: current.channelPairs.filter((candidate) =>
          candidate.raftChannelId !== pair.raftChannelId || candidate.slackChannelId !== pair.slackChannelId),
      };
      return view();
    },
    saveChannelPairs: async (pairs) => {
      calls.push(`save:${pairs.map((pair) => `${pair.raftChannelId}=${pair.slackChannelId}`).join(",")}`);
      current = { ...current, stage: "preflight", channelPairs: [...pairs] };
      return view();
    },
    runPreflight: async () => {
      calls.push("preflight");
      current = { ...snapshot("enable"), raftChannels: current.raftChannels, slackChannels: current.slackChannels, channelPairs: current.channelPairs };
      return view();
    },
    enable: async () => {
      calls.push("enable");
      current = { ...current, stage: "health" };
      return view();
    },
  };

  renderWithIntl(<SlackBridgeSetupWizard canManage provider={provider} />);

  await screen.findByText("#general ↔ #general");
  fireEvent.click(screen.getByRole("button", { name: "Manage channel mappings" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Remove pair" })[0]!);
  await selectOption("Raft channel", "#general");
  await selectOption("Slack channel", "#replacement");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply mapping changes" }));

  await screen.findByText("Connected");
  await waitFor(() => assert.deepEqual(calls, [
    "remove:raft-general:slack-general:7",
    "save:raft-support=slack-support,raft-general=slack-replacement",
    "preflight",
    "enable",
  ]));
});

test("a failed replacement after exact teardown reports partial success instead of generic failure", async () => {
  let current = snapshot("health");
  const view = (): SlackBridgeProvisioningView => ({ kind: "ready", snapshot: current });
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => view(),
    connect: async () => ready("oauth"),
    beginOAuth: async () => ({ kind: "view", view: ready("channels") }),
    removeChannelPair: async () => {
      current = { ...current, channelPairs: [] };
      return view();
    },
    saveChannelPairs: async () => { throw new Error("replacement rejected"); },
    runPreflight: async () => ready("enable"),
    enable: async () => ready("health"),
  };

  renderWithIntl(<SlackBridgeSetupWizard canManage provider={provider} />);

  await screen.findByText("#general ↔ #general");
  fireEvent.click(screen.getByRole("button", { name: "Manage channel mappings" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove pair" }));
  await selectOption("Raft channel", "#general");
  await selectOption("Slack channel", "#support");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply mapping changes" }));

  await screen.findByText(
    "Some channel mappings were removed, but the remaining bridge changes did not finish. Reload the current mappings before retrying.",
  );
  assert.equal(screen.queryByText("The Slack bridge operation failed. No setup state was assumed."), null);
});
