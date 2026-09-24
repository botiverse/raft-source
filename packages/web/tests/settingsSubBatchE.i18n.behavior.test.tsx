import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import { IntegrationsSection } from "../src/components/settings/SettingsPanel";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import api from "../src/api/client";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";

// Settings sub-batch E (react-intl migration acceptance): the Connected Apps
// EDITOR danger zone — client-secret rotation, marketplace lifecycle, and the
// unsaved-app notice.
//
// The danger zone only mounts when the register/edit drawer is open. This
// batch mounts the unsaved-app (`!editingClient`) branch by opening Register
// app. The saved-app regenerate/offline confirm path still needs a loaded
// client + Edit click; that is recorded as catalog-only, not wiring.

const IDS = [
  "settings.connectedApps.editor.dangerStatusRestricted",
  "settings.connectedApps.editor.dangerStatusAvailableAfterSave",
  "settings.connectedApps.editor.saveBeforeLifecycle",
  "settings.connectedApps.editor.clientSecretTitle",
  "settings.connectedApps.editor.clientSecretDescription",
  "settings.connectedApps.editor.regenerateClientSecret",
  "settings.connectedApps.editor.regeneratingClientSecret",
  "settings.connectedApps.editor.marketplaceLifecycleTitle",
  "settings.connectedApps.editor.marketplaceLifecycleDescription",
  "settings.connectedApps.editor.requestOffline",
  "settings.connectedApps.editor.regenerateSecretConfirmTitle",
  "settings.connectedApps.editor.regenerateSecretConfirmMessage",
  "settings.connectedApps.editor.regenerateSecretConfirmLabel",
];

const originalGet = api.get;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAuthStore.setState({ user: null } as never);
  useServerStore.setState({ current: null, members: [] } as never);
});

test("every id this sub-batch added is present and actually translated in both catalogs", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  for (const id of IDS) {
    assert.ok(en[id], `${id} missing from en.ts`);
    assert.ok(zh[id], `${id} missing from zh-cn.ts`);
    assert.notEqual(zh[id], en[id], `${id} is still the English string in zh-cn.ts`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }
});

test("the two state-pair ternaries stay two distinct messages", () => {
  const zh = zhMessages as Record<string, string>;

  assert.notEqual(
    zh["settings.connectedApps.editor.dangerStatusRestricted"],
    zh["settings.connectedApps.editor.dangerStatusAvailableAfterSave"],
    "saved/unsaved danger status must stay distinct",
  );
  assert.notEqual(
    zh["settings.connectedApps.editor.regenerateClientSecret"],
    zh["settings.connectedApps.editor.regeneratingClientSecret"],
    "idle/in-flight regenerate labels must stay distinct",
  );
});

test("mounted register-app danger zone is Chinese, not English residue", () => {
  const zh = zhMessages as Record<string, string>;
  useAuthStore.setState({
    user: { id: "u1", name: "U", displayName: "U", email: "u@example.com" },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    servers: [{ id: "s1", slug: "s1", name: "S1", role: "owner" }],
    current: { id: "s1", slug: "s1", name: "S1", role: "owner" },
    members: [],
    loading: false,
  } as never);
  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: [] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/marketplace") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    return { data: {} };
  }) as typeof api.get;

  render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter>
        <IntegrationsSection />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: zh["settings.connectedApps.registerApp"] }));
  assert.ok(screen.getByText(zh["settings.connectedApps.editor.saveBeforeLifecycle"]));
  assert.ok(screen.getAllByText(zh["settings.connectedApps.editor.dangerStatusAvailableAfterSave"]).length > 0);
  assert.equal(
    screen.queryByText("Save the app before lifecycle or credential actions become available."),
    null,
  );
  assert.equal(screen.queryByText("Available after save"), null);
});

test("connected-apps editor confirm ids stay translated in the catalog", () => {
  const zh = zhMessages as Record<string, string>;
  const en = enMessages as Record<string, string>;
  for (const id of [
    "settings.connectedApps.editor.regenerateSecretConfirmTitle",
    "settings.connectedApps.editor.regenerateSecretConfirmMessage",
    "settings.connectedApps.editor.regenerateSecretConfirmLabel",
    "settings.connectedApps.editor.marketplaceLifecycleTitle",
    "settings.connectedApps.editor.requestOffline",
    "settings.connectedApps.section.profile",
    "settings.connectedApps.section.loginWithRaft",
    "settings.connectedApps.section.distribution",
    "settings.connectedApps.section.dangerZone",
  ]) {
    assert.notEqual(zh[id], en[id], `${id} is still English in zh-cn.ts`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }
});
