import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { DISPLAY_LOCALE_STORAGE_KEY } from "../src/i18n/locale";
import SettingsPanel from "../src/components/settings/SettingsPanel";
import api from "../src/api/client";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { useTranslationStore } from "../src/store/translationStore";
import { formatShortDateTime } from "../src/utils/timeFormatting";

// Dynamic-ICU behavior teeth for Settings sub-batch B.
//
// Sub-batch B migrated 13 dynamic ICU placeholder call-sites (14 occurrences)
// in SettingsPanel.tsx to react-intl. The reviewer found these call-sites had
// no behavioral test teeth: dropping `{serverName}` from the catalog string
// `settings.notifications.muted` (or the component ceasing to pass the value)
// still passed every existing DOM/catalog/typecheck test.
//
// Each test below renders the REAL SettingsPanel (or fires the real interaction
// that mounts the ConfirmDialog / drawer / error) in the default (en) locale,
// seeds a DISTINCTIVE sentinel for every placeholder, and asserts:
//   1. the sentinel value(s) reach the final rendered DOM text (VALUE FLOW), and
//   2. no unresolved `{placeholder}` literal and no `FORMAT_ERROR` survive.
// If a placeholder is deleted from en.ts, or the component stops threading the
// value, the sentinel disappears and the test goes RED. (Verified by reverse
// mutation during authoring — see the PR description.)

const SERVER_NAME = "Zephyr-QA-Server";
const REVOKE_EMAIL = "revoke-target@sentinel.test";
const JOIN_EXPIRES_ISO = "2033-11-05T13:47:00.000Z";
const SHARE_EXPIRES_ISO = "2033-11-05T13:47:00.000Z";
const APP_CATEGORY = "Productivity & Collaboration";
const APP_DEVELOPER = "Sentinel Dev Co";
const APP_NAME = "Sentinel App";
const BODY_MAX_LABEL = "5,000"; // real PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH_LABEL

function formatAppDate(value: string): string {
  return new Intl.DateTimeFormat("en").format(new Date(value));
}

const originalGet = api.get;
const originalPatch = api.patch;
const originalPost = api.post;
const originalDelete = api.delete;
const originalTranslationSettings = useTranslationStore.getState().settings;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.patch = originalPatch;
  api.post = originalPost;
  api.delete = originalDelete;
  useAuthStore.setState({ user: null } as never);
  useServerStore.setState({ current: null, servers: [], members: [] } as never);
  useTranslationStore.setState({ settings: originalTranslationSettings } as never);
  try {
    window.localStorage.clear();
  } catch {
    // ignore storageless environments
  }
});

type Route = [pattern: string | RegExp, data: unknown];

// URL-dispatching GET loader. Unmatched URLs fall back to a neutral empty list
// so the many sibling sections a tab mounts (admins, channels, translation,
// member-permissions, push vapid-key, …) load without a live backend.
function installGet(routes: Route[]) {
  api.get = (async (url: string) => {
    for (const [pattern, data] of routes) {
      const hit = typeof pattern === "string" ? url.includes(pattern) : pattern.test(url);
      if (hit) return { data };
    }
    return { data: [] };
  }) as typeof api.get;
}

function seed(role: "owner" | "admin" | "member" = "owner") {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as never;
  }
  // Deterministic en locale (no zh) — the teeth are about value flow, not copy.
  window.localStorage.setItem(DISPLAY_LOCALE_STORAGE_KEY, "en");
  useAuthStore.setState({
    user: {
      id: "user-1", email: "u@example.com", gravatarHash: "", name: "U", displayName: "U",
      description: null, avatarUrl: null, emailVerified: true,
      preferredLanguage: null, displayLanguage: null, preferredTimezone: null,
      autoTranslationEnabled: false, preferredTranslationDisplay: "translated",
      preferredTimeFormat: null, preferredMessageBodyFontSize: null,
      referralSource: null, referralSourceOther: null, referralSourceSkippedAt: null,
    },
    loading: false, initialized: true,
  } as never);
  useServerStore.setState({
    servers: [{ id: "s1", slug: "s1", name: SERVER_NAME, role }],
    current: { id: "s1", slug: "s1", name: SERVER_NAME, role },
    members: [], loading: false,
  } as never);
}

function renderPanel(node: ReactElement) {
  return render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <MemoryRouter>{node}</MemoryRouter>
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

// The tooth. `contains` are the sentinel values that MUST reach rendered text;
// `placeholders` are the raw ICU tokens that must NOT survive.
function assertResolved(
  text: string | null | undefined,
  opts: { contains: string[]; placeholders: string[] },
) {
  const body = text ?? "";
  for (const value of opts.contains) {
    assert.ok(
      body.includes(value),
      `expected rendered text to include sentinel "${value}" — got: ${body.slice(0, 500)}`,
    );
  }
  for (const token of opts.placeholders) {
    assert.ok(!body.includes(token), `rendered text must not contain unresolved placeholder ${token}`);
  }
  assert.ok(!body.includes("FORMAT_ERROR"), "rendered text must not contain FORMAT_ERROR");
}

// ── Notifications tab ───────────────────────────────────────────────────────

test("notifications.muteServerDescription threads {serverName} into the mute copy", async () => {
  seed("owner");
  installGet([["/notification-settings", { serverPushMuted: false }]]);

  const { container } = renderPanel(<SettingsPanel tab="notifications" />);

  await screen.findByText(
    `Stops web push notifications from ${SERVER_NAME} for your account. Other servers are unchanged.`,
  );
  assertResolved(container.textContent, {
    contains: [SERVER_NAME, "Stops web push notifications from"],
    placeholders: ["{serverName}"],
  });
});

test("notifications.muted threads {serverName} after saving a server mute", async () => {
  seed("owner");
  installGet([["/notification-settings", { serverPushMuted: false }]]);
  api.patch = (async (_url: string, body: { serverPushMuted?: boolean }) => ({
    data: { serverPushMuted: !!body?.serverPushMuted },
  })) as typeof api.patch;

  renderPanel(<SettingsPanel tab="notifications" />);

  const muteLabel = (await screen.findByText(
    `Stops web push notifications from ${SERVER_NAME} for your account. Other servers are unchanged.`,
  )).closest("label") as HTMLElement;
  const checkbox = within(muteLabel).getByRole("checkbox");
  await waitFor(() => assert.equal((checkbox as HTMLInputElement).disabled, false));

  fireEvent.click(checkbox); // check → serverPushMuted true, enables Save
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  const banner = await screen.findByText(`Notifications from ${SERVER_NAME} are muted.`);
  assertResolved(banner.textContent, { contains: [SERVER_NAME], placeholders: ["{serverName}"] });
});

test("notifications.unmuted threads {serverName} after clearing a server mute", async () => {
  seed("owner");
  installGet([["/notification-settings", { serverPushMuted: true }]]);
  api.patch = (async (_url: string, body: { serverPushMuted?: boolean }) => ({
    data: { serverPushMuted: !!body?.serverPushMuted },
  })) as typeof api.patch;

  renderPanel(<SettingsPanel tab="notifications" />);

  const muteLabel = (await screen.findByText(
    `Stops web push notifications from ${SERVER_NAME} for your account. Other servers are unchanged.`,
  )).closest("label") as HTMLElement;
  const checkbox = within(muteLabel).getByRole("checkbox") as HTMLInputElement;
  await waitFor(() => assert.equal(checkbox.checked, true));

  fireEvent.click(checkbox); // uncheck → serverPushMuted false, enables Save
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  const banner = await screen.findByText(`Notifications from ${SERVER_NAME} are unmuted.`);
  assertResolved(banner.textContent, { contains: [SERVER_NAME], placeholders: ["{serverName}"] });
});

// ── Administration tab: invites ─────────────────────────────────────────────

test("invites.confirmMessage threads {email} into the revoke ConfirmDialog", async () => {
  seed("owner");
  installGet([
    ["/invites", [{ id: "inv-1", invitedEmail: REVOKE_EMAIL, createdAt: "2033-01-02T00:00:00.000Z" }]],
  ]);

  renderPanel(<SettingsPanel tab="administration" />);

  const revokeButton = await screen.findByRole("button", { name: "Revoke invite" });
  fireEvent.click(revokeButton);

  const message = await screen.findByText(
    `Are you sure you want to revoke the invite to ${REVOKE_EMAIL}? They will no longer be able to join using this invite link.`,
  );
  assertResolved(message.textContent, { contains: [REVOKE_EMAIL], placeholders: ["{email}"] });
});

// ── Administration tab: join links ──────────────────────────────────────────

test("joinLinks usesWithMax / uses / expires thread {used},{max},{when}", async () => {
  seed("owner");
  // Pin the time formatter so `expires {when}` is deterministic and can be
  // computed identically here.
  useTranslationStore.setState({
    settings: { ...originalTranslationSettings, effectiveTimezone: "UTC", effectiveTimeFormat: "24h" },
  } as never);
  installGet([
    ["/join-links", [
      { id: "jl-max", token: "tok-max", createdAt: "2033-01-01T00:00:00.000Z", expiresAt: JOIN_EXPIRES_ISO, maxUses: 20, useCount: 7, revokedAt: null },
      { id: "jl-open", token: "tok-open", createdAt: "2033-01-01T00:00:00.000Z", expiresAt: null, maxUses: null, useCount: 7, revokedAt: null },
    ]],
  ]);

  const { container } = renderPanel(<SettingsPanel tab="administration" />);

  await screen.findByText(/7\/20 uses/);
  const expectedWhen = formatShortDateTime(JOIN_EXPIRES_ISO, { locale: "en", timeZone: "UTC", timeFormat: "24h" });
  assert.ok(expectedWhen.length > 0);

  const text = container.textContent ?? "";
  // usesWithMax: both {used} and {max} present.
  assert.ok(text.includes("7/20 uses"), `expected "7/20 uses"; got: ${text.slice(0, 500)}`);
  // uses (maxUses null): standalone {used}.
  assert.ok(text.includes("7 uses"), `expected standalone "7 uses"; got: ${text.slice(0, 500)}`);
  // expires: formatted {when}.
  assert.ok(text.includes(`expires ${expectedWhen}`), `expected "expires ${expectedWhen}"; got: ${text.slice(0, 500)}`);
  assertResolved(text, { contains: [], placeholders: ["{used}", "{max}", "{when}"] });
});

// ── Server tab: danger zone ─────────────────────────────────────────────────

test("dangerZone.leaveConfirmMessage threads {serverName} into the leave dialog", async () => {
  // Only admin/member see Leave Server (owner sees Delete Server instead).
  seed("admin");
  installGet([]);

  renderPanel(<SettingsPanel tab="server" />);

  fireEvent.click(await screen.findByTestId("server-danger-leave-button"));

  const message = await screen.findByText(
    `You'll lose access to ${SERVER_NAME} and all of its channels. You can be re-invited later.`,
  );
  assertResolved(message.textContent, { contains: [SERVER_NAME], placeholders: ["{serverName}"] });
});

// ── Integrations tab: connected apps ────────────────────────────────────────

const marketplaceListing = {
  id: "mk-1",
  clientId: "mk-1",
  name: APP_NAME,
  description: "Sentinel marketplace description.",
  homepageUrl: null,
  returnUrl: null,
  logoUrl: null,
  category: APP_CATEGORY,
  dataAccessSummary: null,
  publisherName: null,
  publisherServerName: APP_DEVELOPER,
  installedAt: null,
  privateShared: false,
  allowedScopes: ["openid", "profile", "identity"],
};

test("connectedApps.byLine threads {category},{developer} in list + detail modal", async () => {
  seed("owner");
  installGet([["/integrations/marketplace", [marketplaceListing]]]);

  renderPanel(<SettingsPanel tab="integrations" />);

  await screen.findByText(APP_NAME);
  // Occurrence 1 — marketplace listing card (only match before the modal opens).
  const byLine = `${APP_CATEGORY} · by ${APP_DEVELOPER}`;
  const cardByLine = screen.getByText(byLine);
  assertResolved(cardByLine.textContent, {
    contains: [APP_CATEGORY, APP_DEVELOPER],
    placeholders: ["{category}", "{developer}"],
  });

  // Occurrence 2 — marketplace listing detail modal.
  fireEvent.click(screen.getByText(APP_NAME));
  const modal = (await screen.findByText("Profile")).closest(".card-brutal") as HTMLElement;
  const modalByLine = within(modal).getByText(byLine);
  assertResolved(modalByLine.textContent, {
    contains: [APP_CATEGORY, APP_DEVELOPER],
    placeholders: ["{category}", "{developer}"],
  });
});

const privateClient = {
  id: "c-1",
  serverId: "s1",
  clientId: "sentinel-client",
  appType: "server_local",
  publishStatus: "private",
  category: "Productivity",
  dataAccessSummary: null,
  publishRejectionReason: null,
  name: APP_NAME,
  description: "Sentinel private app.",
  homepageUrl: null,
  returnUrl: null,
  agentManifestUrl: null,
  allowedScopes: ["openid", "profile", "identity"],
  logoUrl: null,
  humanMarketplaceVisible: false,
  createdByUserId: "user-1",
  createdAt: "2033-01-01T00:00:00.000Z",
  updatedAt: "2033-01-01T00:00:00.000Z",
};

test("connectedApps.activeLinkExpires threads {when} into the share-link card", async () => {
  seed("owner");
  installGet([
    // Share-link URL keys on the client record id, and "/integrations/clients"
    // is a substring of it — match "/share-link" first.
    ["/share-link", {
      id: "sl-1", clientId: "sentinel-client", expiresAt: SHARE_EXPIRES_ISO,
      revokedAt: null, lastUsedAt: null, createdAt: "2033-01-01T00:00:00.000Z", updatedAt: "2033-01-01T00:00:00.000Z",
    }],
    ["/integrations/clients", [privateClient]],
  ]);

  renderPanel(<SettingsPanel tab="integrations" />);

  fireEvent.click(await screen.findByTestId("connected-apps-tab-my-apps"));
  const myApps = await screen.findByTestId("connected-apps-my-apps-tab");
  fireEvent.click(within(myApps).getByRole("button", { name: "Edit" }));

  const expectedWhen = formatAppDate(SHARE_EXPIRES_ISO);
  const line = await screen.findByText(`Active link expires ${expectedWhen}.`);
  assertResolved(line.textContent, { contains: [expectedWhen], placeholders: ["{when}"] });
});

test("connectedApps.deleteAppTitle threads {name} into the delete ConfirmDialog", async () => {
  seed("owner");
  installGet([
    ["/integrations/clients/c-1/share-link", null],
    ["/integrations/clients/c-1/app-notifications", {
      request_revision: 0,
      current_revision_id: null,
      current_groups: [],
      current_events: [],
      pending_revision: null,
      webhook: null,
    }],
    ["/integrations/clients", [privateClient]],
  ]);

  renderPanel(<SettingsPanel tab="integrations" />);

  fireEvent.click(await screen.findByTestId("connected-apps-tab-my-apps"));
  const myApps = await screen.findByTestId("connected-apps-my-apps-tab");
  fireEvent.click(within(myApps).getByRole("button", { name: "Edit" }));
  const editor = await screen.findByTestId("connected-app-editor");
  fireEvent.click(within(editor).getByRole("button", { name: "Delete" }));

  const title = await screen.findByText(`Delete ${APP_NAME}?`);
  assertResolved(title.textContent, { contains: [APP_NAME], placeholders: ["{name}"] });
});

test("connectedApps.uninstallAppTitle threads {name} into the uninstall ConfirmDialog", async () => {
  seed("owner");
  const installedListing = {
    ...marketplaceListing,
    id: "mk-installed",
    clientId: "mk-installed",
    installedAt: "2033-01-01T00:00:00.000Z",
  };
  installGet([["/integrations/marketplace", [installedListing]]]);

  renderPanel(<SettingsPanel tab="integrations" />);

  fireEvent.click(await screen.findByTestId("connected-apps-tab-installed"));
  const installed = await screen.findByTestId("connected-apps-installed-tab");
  fireEvent.click(within(installed).getByRole("button", { name: "Uninstall" }));

  const title = await screen.findByText(`Uninstall ${APP_NAME}?`);
  assertResolved(title.textContent, { contains: [APP_NAME], placeholders: ["{name}"] });
});

// ── Administration tab: pre-join agreement ──────────────────────────────────

test("preJoinAgreement.bodyTooLong threads {max} into the over-limit error", async () => {
  seed("owner");
  installGet([["/agreement", { enabled: false }]]);

  const { container } = renderPanel(<SettingsPanel tab="administration" />);

  const section = (await screen.findByText("Require agreement before joining"))
    .closest("div.mb-6") as HTMLElement;
  // Enable the agreement so the body textarea mounts.
  fireEvent.click(within(section).getByRole("checkbox"));

  const textarea = section.querySelector("textarea") as HTMLTextAreaElement;
  assert.ok(textarea, "agreement body textarea should mount once enabled");
  fireEvent.change(textarea, { target: { value: "x".repeat(5001) } });

  const error = await within(section).findByText(
    `Agreement body must be ${BODY_MAX_LABEL} characters or fewer`,
  );
  assertResolved(error.textContent, { contains: [BODY_MAX_LABEL], placeholders: ["{max}"] });
  assertResolved(container.textContent, { contains: [BODY_MAX_LABEL], placeholders: ["{max}"] });
});
