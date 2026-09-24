import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  applyChannelSlackBridgeSelection,
  ChannelSlackBridgeField,
  isChannelSlackBridgeSelectionAvailable,
} from "../src/components/channel/ChannelSlackBridgeField";
import type { SlackBridgeEditor } from "../src/components/channel/ChannelSlackBridgeField";
import type { SlackBridgeProvisioningProvider, SlackBridgeSetupSnapshot } from "../src/components/settings/slackBridgeProvisioning";
import { TestIntlProvider } from "./helpers/intl";

afterEach(cleanup);

test("channel bridge selection is exposed only after the bridge is enabled", () => {
  assert.equal(isChannelSlackBridgeSelectionAvailable("health"), true);
  for (const stage of ["connect", "oauth", "channels", "preflight", "enable"] as const) {
    assert.equal(isChannelSlackBridgeSelectionAvailable(stage), false, `${stage} must not expose channel pairing`);
  }
  assert.equal(isChannelSlackBridgeSelectionAvailable(null), false);
});

test("channel bridge selector disables Slack channels paired to another Raft channel", () => {
  const editor: SlackBridgeEditor = {
    available: true,
    selectedSlackChannelId: "",
    setSelectedSlackChannelId: () => {},
    apply: async () => {},
    snapshot: {
      stage: "health",
      workspaceName: "Acme Slack",
      raftChannels: [
        { id: "raft-current", name: "current" },
        { id: "raft-other", name: "other" },
      ],
      slackChannels: [
        { id: "slack-open", name: "open", privacyClass: "public", isMember: true },
        { id: "slack-used", name: "used", privacyClass: "public", isMember: true },
        { id: "slack-private", name: "private", privacyClass: "private", isMember: true },
      ],
      channelPairs: [{ raftChannelId: "raft-other", slackChannelId: "slack-used", bindingEpoch: 4 }],
      preflight: null,
      rawHealth: {
        install: null,
        credential: null,
        bindings: [],
        audiences: [],
        lastVerifiedAt: null,
        failingSurface: null,
      },
    },
  };

  render(
    <TestIntlProvider>
      <ChannelSlackBridgeField editor={editor} visibility="public" />
    </TestIntlProvider>,
  );

  const trigger = screen.getByRole("combobox", { name: "Slack channel" });
  assert.equal(trigger.tagName, "BUTTON", "the channel picker must use the raft-ui Select trigger");
  fireEvent.click(trigger);

  assert.ok(screen.getByRole("option", { name: "#open" }));
  assert.equal(screen.getByRole("option", { name: "#used — already paired" }).getAttribute("aria-disabled"), "true");
  assert.equal(screen.queryByRole("option", { name: "#private" }), null);
});

test("channel bridge selector blocks Slack channels the Raft app has not joined", () => {
  const editor: SlackBridgeEditor = {
    available: true,
    selectedSlackChannelId: "",
    setSelectedSlackChannelId: () => {},
    apply: async () => {},
    snapshot: {
      stage: "health",
      workspaceName: "Acme Slack",
      raftChannels: [{ id: "raft-current", name: "current" }],
      slackChannels: [
        { id: "slack-unjoined", name: "unjoined", privacyClass: "public", isMember: false },
        { id: "slack-joined", name: "joined", privacyClass: "public", isMember: true },
      ],
      channelPairs: [],
      preflight: null,
      rawHealth: {
        install: null,
        credential: null,
        bindings: [],
        audiences: [],
        lastVerifiedAt: null,
        failingSurface: null,
      },
    },
  };

  render(
    <TestIntlProvider>
      <ChannelSlackBridgeField editor={editor} visibility="public" />
    </TestIntlProvider>,
  );

  fireEvent.click(screen.getByRole("combobox", { name: "Slack channel" }));
  assert.equal(
    screen.getByRole("option", { name: "#unjoined — invite the Raft app in Slack" }).getAttribute("aria-disabled"),
    "true",
  );
  assert.equal(screen.getByRole("option", { name: "#joined" }).getAttribute("aria-disabled"), null);
});

test("editing a paired channel removes its exact epoch then enables the replacement with other pairs preserved", async () => {
  const base: SlackBridgeSetupSnapshot = {
    stage: "health",
    workspaceName: "Acme Slack",
    raftChannels: [{ id: "raft-current", name: "current" }, { id: "raft-other", name: "other" }],
    slackChannels: [
      { id: "slack-old", name: "old", isMember: true },
      { id: "slack-new", name: "new", isMember: true },
      { id: "slack-other", name: "other", isMember: true },
    ],
    channelPairs: [
      { raftChannelId: "raft-current", slackChannelId: "slack-old", bindingEpoch: 7 },
      { raftChannelId: "raft-other", slackChannelId: "slack-other", bindingEpoch: 2 },
    ],
    preflight: null,
    rawHealth: { install: null, credential: null, bindings: [], audiences: [], lastVerifiedAt: null, failingSurface: null },
  };
  const calls: string[] = [];
  let current = base;
  const view = () => ({ kind: "ready" as const, snapshot: current });
  const provider: SlackBridgeProvisioningProvider = {
    load: async () => view(),
    connect: async () => view(),
    beginOAuth: async () => ({ kind: "view", view: view() }),
    disconnect: async () => view(),
    removeChannelPair: async (pair) => {
      calls.push(`remove:${pair.raftChannelId}:${pair.slackChannelId}:${pair.expectedBindingEpoch}`);
      current = { ...current, channelPairs: current.channelPairs.filter((candidate) => candidate.raftChannelId !== pair.raftChannelId) };
      return view();
    },
    saveChannelPairs: async (pairs) => {
      calls.push(`save:${pairs.map((pair) => `${pair.raftChannelId}=${pair.slackChannelId}`).join(",")}`);
      current = { ...current, stage: "preflight", channelPairs: [...pairs] };
      return view();
    },
    runPreflight: async () => {
      calls.push("preflight");
      current = {
        ...current,
        stage: "enable",
        preflight: {
          state: "passed",
          checks: [
            { id: "oauth", state: "passed" },
            { id: "endpoint", state: "passed" },
            { id: "scope", state: "passed" },
            { id: "audience", state: "passed" },
          ],
        },
      };
      return view();
    },
    enable: async () => {
      calls.push("enable");
      current = { ...current, stage: "health" };
      return view();
    },
  };

  await applyChannelSlackBridgeSelection({
    provider,
    snapshot: base,
    channelId: "raft-current",
    selectedSlackChannelId: "slack-new",
  });

  assert.deepEqual(calls, [
    "remove:raft-current:slack-old:7",
    "save:raft-other=slack-other,raft-current=slack-new",
    "preflight",
    "enable",
  ]);
});
