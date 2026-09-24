import assert from "node:assert/strict";
import test from "node:test";
import {
  createServerLabEnrollmentMutation,
  createServerLabMasterMutation,
  getServerLabEnrollmentDisabledReasonMessageId,
  getServerLabSettingsAuthority,
  getServerLabStateMessageId,
  isServerLabEffectivelyEnabled,
  isServerLabEnrollmentEditable,
  normalizeServerLabSettingsReadback,
} from "../src/utils/serverLabsSettings.js";
import type {
  ServerLabSettingsReadback,
} from "../src/utils/serverLabsSettings.js";
import { SETTINGS_TABS, normalizeSettingsTab } from "../src/components/settings/settingsNavigation.js";
import {
  beginServerLabsMutation,
  createServerLabsStoreContext,
  getServerLabsSettingsSnapshot,
  publishServerLabsReadback,
  resetServerLabsSettingsForTests,
} from "../src/store/serverLabsSettingsStore.js";
import { useServerStore } from "../src/store/serverStore.js";

const readback: ServerLabSettingsReadback = {
  serverId: "server-1",
  serverLabVersion: 17,
  masterEnabled: true,
  labs: [
    {
      key: "composer_lab",
      name: "Composer Lab",
      description: "New composer entry points.",
      state: "open",
      enrolled: true,
      effective: true,
    },
  ],
};

test("server Labs settings authority follows owner/admin/member contract", () => {
  assert.deepEqual(getServerLabSettingsAuthority("owner", null), {
    canSetMasterAccess: true,
    canSetEnrollments: true,
  });
  assert.deepEqual(getServerLabSettingsAuthority("admin", null), {
    canSetMasterAccess: false,
    canSetEnrollments: true,
  });
  assert.deepEqual(getServerLabSettingsAuthority("member", null), {
    canSetMasterAccess: false,
    canSetEnrollments: false,
  });
});

test("server Labs settings honors server-returned permissions over local visibility", () => {
  assert.deepEqual(getServerLabSettingsAuthority("owner", {
    canSetMasterAccess: false,
    canSetEnrollments: false,
  }), {
    canSetMasterAccess: false,
    canSetEnrollments: false,
  });
  assert.deepEqual(getServerLabSettingsAuthority("member", {
    canSetMasterAccess: true,
    canSetEnrollments: true,
  }), {
    canSetMasterAccess: true,
    canSetEnrollments: true,
  });
});

test("server Labs settings makes paused draft and retired Labs read-only", () => {
  const authority = getServerLabSettingsAuthority("admin", null);
  assert.equal(isServerLabEnrollmentEditable({ state: "open" }, authority), true);
  assert.equal(isServerLabEnrollmentEditable({ state: "open" }, authority, false), false);
  assert.equal(isServerLabEnrollmentEditable({ state: "paused" }, authority), false);
  assert.equal(isServerLabEnrollmentEditable({ state: "draft" }, authority), false);
  assert.equal(isServerLabEnrollmentEditable({ state: "retired" }, authority), false);
  assert.equal(
    getServerLabEnrollmentDisabledReasonMessageId({ state: "open" }, authority, false),
    "settings.labs.enrollmentMasterDisabled",
  );
  assert.equal(
    getServerLabEnrollmentDisabledReasonMessageId({ state: "paused" }, authority),
    "settings.labs.enrollmentLifecycleReadOnly",
  );
  assert.equal(
    getServerLabEnrollmentDisabledReasonMessageId({ state: "open" }, getServerLabSettingsAuthority("member", null)),
    "settings.labs.enrollmentAdminOnly",
  );
});

test("server Labs settings derives effective state from authoritative master and lifecycle", () => {
  assert.equal(isServerLabEffectivelyEnabled(true, { state: "open", enrolled: true }), true);
  assert.equal(isServerLabEffectivelyEnabled(false, { state: "open", enrolled: true }), false);
  assert.equal(isServerLabEffectivelyEnabled(true, { state: "paused", enrolled: true }), false);
  assert.equal(isServerLabEffectivelyEnabled(true, { state: "open", enrolled: false }), false);
});

test("server Labs mutations carry serverLabVersion and do not invent local versions", () => {
  assert.deepEqual(createServerLabMasterMutation(readback, false), {
    enabled: false,
    expectedVersion: 17,
  });
  assert.deepEqual(createServerLabEnrollmentMutation(readback, false), {
    enabled: false,
    expectedVersion: 17,
  });
});

test("server Labs state labels are stable for settings badges", () => {
  assert.equal(getServerLabStateMessageId("draft"), "settings.labs.stateDraft");
  assert.equal(getServerLabStateMessageId("open"), "settings.labs.stateOpen");
  assert.equal(getServerLabStateMessageId("paused"), "settings.labs.statePaused");
  assert.equal(getServerLabStateMessageId("retired"), "settings.labs.stateRetired");
});

test("server Labs settings normalizes canonical API readback", () => {
  assert.deepEqual(normalizeServerLabSettingsReadback({
    serverId: "server-1",
    accessEnabled: true,
    version: 22,
    canManageAccess: false,
    canManageEnrollments: true,
    labs: [{
      labKey: "composer_lab",
      name: "Composer Lab",
      description: "New composer entry points.",
      state: "open",
      enrolled: true,
      effective: true,
      updatedAt: "2026-07-23T00:00:00.000Z",
    }],
  }), {
    serverId: "server-1",
    serverLabVersion: 22,
    masterEnabled: true,
    permissions: {
      canSetMasterAccess: false,
      canSetEnrollments: true,
    },
    labs: [{
      key: "composer_lab",
      name: "Composer Lab",
      description: "New composer entry points.",
      state: "open",
      enrolled: true,
      effective: true,
    }],
  });
});

test("server Labs shared source rejects slower older mutation responses on one epoch boundary", () => {
  resetServerLabsSettingsForTests();
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server 1",
      avatarUrl: null,
      slug: "server-1",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-24T00:00:00.000Z",
    },
    serverEpoch: 5,
  } as never);

  const older = createServerLabsStoreContext("server-1", 5);
  beginServerLabsMutation(older);
  const newer = createServerLabsStoreContext("server-1", 5);
  beginServerLabsMutation(newer);

  assert.equal(publishServerLabsReadback(newer, { ...readback, serverLabVersion: 19 }, "mutation"), true);
  assert.equal(publishServerLabsReadback(older, { ...readback, serverLabVersion: 18, masterEnabled: false }, "mutation"), false);
  assert.equal(
    getServerLabsSettingsSnapshot("server-1", 5).readback?.serverLabVersion,
    19,
  );
  assert.equal(getServerLabsSettingsSnapshot("server-1", 5).readback?.masterEnabled, true);

  resetServerLabsSettingsForTests();
});

test("server Labs direct settings aliases land on the standalone Labs settings surface", () => {
  assert.equal(normalizeSettingsTab("labs"), "labs");
  assert.equal(normalizeSettingsTab("server-labs"), "labs");
});

test("server Labs settings tab is ordered immediately after Connected Apps", () => {
  const workspaceTabIds = SETTINGS_TABS.map((tab) => tab.id);
  assert.equal(
    workspaceTabIds[workspaceTabIds.indexOf("integrations") + 1],
    "labs",
  );
});
