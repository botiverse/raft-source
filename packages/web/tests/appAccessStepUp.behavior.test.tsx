/**
 * "Verify it's you" before giving an app access and before a new secret
 * (#12297, #12302): with two-step verification on, the server refuses these
 * with 403 second_factor_step_up_required. Login with Raft consent (POST
 * /oauth/authorize/human), approving an app's request for an agent, installing
 * a Marketplace app or an invite-link app, adding an installed app's bot and
 * approving an installed app's update need a sign-in that passed the second
 * step; regenerating an OAuth client secret, rotating a webhook signing secret
 * and registering an app (its first secret) need a fresh one. The one dialog
 * (SecondFactorStepUpHost) asks, POST /step-up marks the sign-in, and the
 * refused request goes once more. Closing the dialog cancels with nothing
 * reported. The API is stubbed at the axios client.
 */
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import api from "../src/api/client";
import AgentAppAccessTab from "../src/components/agent/AgentAppAccessTab";
import { DeveloperAppNotifications } from "../src/components/settings/AppNotificationsControls";
import type { AppNotificationSelection, AppNotificationsDeveloperState } from "../src/components/settings/AppNotificationsControls";
import SecondFactorStepUpHost from "../src/components/settings/SecondFactorStepUpHost";
import { SettingsPanel } from "../src/components/settings/SettingsPanel";
import { resetSecondFactorStepUpForTests } from "../src/components/settings/secondFactorStepUp";
import { en } from "../src/i18n/messages/en";
import HumanLoginSetupPage from "../src/pages/HumanLoginSetupPage";
import IntegrationInvitePage from "../src/pages/IntegrationInvitePage";
import { useAuthStore } from "../src/store/authStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";
import { serveMarketplaceListingsFromAppRecords } from "./helpers/marketplaceListings";
import { chooseRegisterAppMenuItem } from "./helpers/registerAppMenu";

// jsdom cannot navigate to the app's origin: the page's return URL is recorded
// here and the page goes to a fragment of itself instead, which jsdom can do.
const authorizedReturnUrls = vi.hoisted(() => [] as string[]);
vi.mock("@botiverse/raft-shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@botiverse/raft-shared")>();
  return {
    ...actual,
    appendOAuthAuthorizationParams: (...args: Parameters<typeof actual.appendOAuthAuthorizationParams>) => {
      authorizedReturnUrls.push(actual.appendOAuthAuthorizationParams(...args));
      return "#authorized";
    },
  };
});

// The Apps page's Marketplace tab reads pages of listings; answered from the App records.
serveMarketplaceListingsFromAppRecords();

const STEP_UP_URL = "/auth/second-factor/step-up";
const FEATURE_FLAGS_URL = "/feature-flags/evaluate";
const REFUSAL = "Verify it's you first.";
const APP_ACCESS_DESCRIPTION = en["settings.twoStep.stepUpAppAccessDescription"];
const AGENT_ACCESS_DESCRIPTION = en["settings.twoStep.stepUpAgentAccessDescription"];
const SECRET_DESCRIPTION = en["settings.twoStep.stepUpSecretDescription"];

const originalApiGet = api.get;
const originalApiPost = api.post;
const originalApiPut = api.put;

type Handler = (body: unknown) => unknown;
type Call = { url: string; body: unknown };

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

function stepUpRequired() {
  return httpError(403, { error: REFUSAL, code: "second_factor_step_up_required", methods: ["totp", "backup_code"] });
}

function fail(err: Error): Handler {
  return () => {
    throw err;
  };
}

/** Each URL answers with its handlers in turn (the last one repeats); a thrown value is the failure. Feature flags are answered (none on), not recorded. */
function stubPosts(handlers: Record<string, Handler[]>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  api.post = (async (url: string, body?: unknown) => {
    if (url === FEATURE_FLAGS_URL) return { data: { evaluations: [] } };
    calls.push({ url, body });
    const queue = handlers[url];
    if (!queue) throw new Error(`Unexpected POST ${url}`);
    const n = counts.get(url) ?? 0;
    counts.set(url, n + 1);
    return { data: queue[Math.min(n, queue.length - 1)]!(body) };
  }) as typeof api.post;
  return calls;
}

function renderWithHost(ui: ReactNode) {
  return render(
    <TestIntlProvider>
      {ui}
      <SecondFactorStepUpHost />
    </TestIntlProvider>,
  );
}

async function clickWhenEnabled(button: HTMLElement) {
  await waitFor(() => assert.equal(button.hasAttribute("disabled"), false));
  fireEvent.click(button);
}

/** The dialog is loaded on first use (lazy), so it may take a moment. */
function findVerifyDialog() {
  return screen.findByRole("dialog", { name: "Verify it's you" }, { timeout: 5000 });
}

async function verifyWithCode(dialog: HTMLElement, code: string) {
  fireEvent.change(within(dialog).getByLabelText("Authenticator code"), { target: { value: code } });
  await clickWhenEnabled(within(dialog).getByRole("button", { name: "Verify" }));
}

async function cancelDialog(dialog: HTMLElement) {
  await clickWhenEnabled(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(screen.queryByRole("dialog", { name: "Verify it's you" }) === null));
}

function bodyText() {
  return document.body.textContent ?? "";
}

const launch: Server = {
  id: "server-1",
  name: "Launch Server",
  avatarUrl: null,
  slug: "launch",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "pro",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-06-25T00:00:00.000Z",
};

function seedStores() {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "owner@example.com",
      name: "Owner",
      displayName: "Owner",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({ servers: [launch], current: launch, members: [], loading: false } as never);
}

beforeEach(() => {
  seedStores();
  resetServerFeatureFlagsForTests();
  authorizedReturnUrls.length = 0;
});

afterEach(() => {
  cleanup();
  resetSecondFactorStepUpForTests();
  api.get = originalApiGet;
  api.post = originalApiPost;
  api.put = originalApiPut;
  localStorage.clear();
  window.history.pushState({}, "", "/");
});

// ── Login with Raft consent ──────────────────────────────────────────────

const AUTHORIZE_URL = "/oauth/authorize/human";

function setupLoginWithRaft() {
  window.history.pushState({}, "", "/login-with-raft/setup?client_id=orbital-notes&return_to=https%3A%2F%2Forbital.example.com%2Freturn");
  api.get = (async (url: string) => {
    if (url !== "/oauth/clients/lookup") throw new Error(`unexpected GET ${url}`);
    return {
      data: {
        id: "app-1",
        clientId: "orbital-notes",
        appType: "third_party_global",
        name: "Orbital Notes",
        description: "Review launch notes from Raft.",
        homepageUrl: null,
        returnUrl: "https://orbital.example.com/return",
        logoUrl: null,
        availability: "ready",
      },
    };
  }) as typeof api.get;
}

async function clickLoginWithRaft() {
  await clickWhenEnabled(await screen.findByRole("button", { name: "Login with Raft" }));
}

test("Login with Raft asks for the second step, then authorizes once more and returns to the app", async () => {
  setupLoginWithRaft();
  const calls = stubPosts({
    [AUTHORIZE_URL]: [fail(stepUpRequired()), () => ({ returnUrl: "https://orbital.example.com/return", code: "code-after-step-up" })],
    [STEP_UP_URL]: [() => ({ verified: true })],
  });
  renderWithHost(<HumanLoginSetupPage />);

  await clickLoginWithRaft();
  const dialog = await findVerifyDialog();
  assert.ok(dialog.textContent?.includes(APP_ACCESS_DESCRIPTION));
  await verifyWithCode(dialog, "123456");

  await waitFor(() => assert.equal(window.location.hash, "#authorized"));
  assert.equal(authorizedReturnUrls.length, 1);
  assert.match(authorizedReturnUrls[0]!, /^https:\/\/orbital\.example\.com\/return\?.*code=code-after-step-up/);
  assert.deepEqual(calls.map((call) => call.url), [AUTHORIZE_URL, STEP_UP_URL, AUTHORIZE_URL]);
  assert.deepEqual(calls[1]!.body, { code: "123456" });
  assert.deepEqual(calls[2]!.body, calls[0]!.body, "the same request goes once more");
});

test("closing the dialog on Login with Raft stays on the page with nothing reported", async () => {
  setupLoginWithRaft();
  const calls = stubPosts({ [AUTHORIZE_URL]: [fail(stepUpRequired())] });
  renderWithHost(<HumanLoginSetupPage />);

  await clickLoginWithRaft();
  await cancelDialog(await findVerifyDialog());

  const login = screen.getByRole("button", { name: "Login with Raft" });
  await waitFor(() => assert.equal(login.hasAttribute("disabled"), false));
  assert.equal(bodyText().includes(REFUSAL), false);
  assert.equal(bodyText().includes(en["pages.humanLogin.continueFailed"]), false);
  assert.ok(screen.queryByTestId("app-not-available") === null);
  assert.equal(authorizedReturnUrls.length, 0);
  assert.equal(window.location.hash, "");
  assert.deepEqual(calls.map((call) => call.url), [AUTHORIZE_URL]);
});

// ── Approving an app's request for an agent ──────────────────────────────

const APPROVE_URL = "/integrations/requests/req-1/approve";

/** The agent's Apps tab; the request is pending until `approved()` says otherwise. */
function stubAgentApps(approved: () => boolean) {
  api.get = (async (url: string) => {
    if (url === "/integrations/agents/agent-1") {
      return {
        data: [{
          id: approved() ? "grant-2" : "req-1",
          type: approved() ? "active" : "pending",
          clientId: "client-2",
          clientName: "Notes App",
          clientDescription: null,
          clientHomepageUrl: null,
          clientAgentManifestUrl: null,
          scopes: ["agent:event:write"],
          createdAt: "2026-10-05T02:00:00.000Z",
          grantSource: null,
        }],
      };
    }
    if (url === "/integrations/agents/agent-1/events") return { data: { events: [], nextCursor: null } };
    if (url === "/mcp/agents/agent-1") return { data: { servers: [], recommendations: [] } };
    if (url === "/integrations/agents/agent-1/grantable-apps") return { data: { apps: [] } };
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
}

function renderAgentApps() {
  renderWithHost(<AgentAppAccessTab agentId="agent-1" canManageAgentAccess />);
}

test("approving an app's request asks for the second step, then approves once more", async () => {
  let approvals = 0;
  stubAgentApps(() => approvals > 0);
  const calls = stubPosts({
    [APPROVE_URL]: [fail(stepUpRequired()), () => {
      approvals += 1;
      return {};
    }],
    [STEP_UP_URL]: [() => ({ verified: true })],
  });
  renderAgentApps();

  await screen.findByTestId("agent-app-pending");
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  const dialog = await findVerifyDialog();
  assert.ok(dialog.textContent?.includes(AGENT_ACCESS_DESCRIPTION));
  await verifyWithCode(dialog, "654321");

  await waitFor(() => assert.ok(screen.queryByTestId("agent-app-pending") === null, "the request is approved"));
  assert.equal(approvals, 1);
  assert.deepEqual(calls.map((call) => call.url), [APPROVE_URL, STEP_UP_URL, APPROVE_URL]);
  assert.deepEqual(calls[1]!.body, { code: "654321" });
  assert.deepEqual(calls[2]!.body, calls[0]!.body);
  assert.equal(bodyText().includes(en["agent.apps.approveFailed"]), false);
});

test("closing the dialog on Approve leaves the request pending with nothing reported", async () => {
  stubAgentApps(() => false);
  const calls = stubPosts({ [APPROVE_URL]: [fail(stepUpRequired())] });
  renderAgentApps();

  await screen.findByTestId("agent-app-pending");
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await cancelDialog(await findVerifyDialog());

  assert.ok(screen.queryByTestId("agent-app-pending") !== null, "the request is still pending");
  assert.equal(bodyText().includes(REFUSAL), false);
  assert.equal(bodyText().includes(en["agent.apps.approveFailed"]), false);
  assert.deepEqual(calls.map((call) => call.url), [APPROVE_URL]);
});

// ── Regenerating an OAuth client secret ──────────────────────────────────

const REGENERATE_URL = "/integrations/clients/private-client/regenerate-secret";

const privateClient = {
  id: "private-client",
  clientId: "private-client",
  appType: "server_local",
  name: "Private Reports",
  description: "Shared private reporting workflows.",
  homepageUrl: "https://reports.example.com/private",
  returnUrl: "https://reports.example.com/callback",
  logoUrl: null,
  publishStatus: "private",
  category: "Productivity & Collaboration",
  dataAccessSummary: null,
  agentManifestUrl: null,
  allowedScopes: ["openid", "profile", "identity"],
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z",
};

function stubConnectedApps() {
  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: [privateClient] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/marketplace") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/integrations/clients/private-client/share-links") {
      throw { response: { status: 404, data: { error: "not found" } } };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
}

async function confirmRegenerate() {
  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
      <SecondFactorStepUpHost />
    </TestIntlProvider>,
  );
  fireEvent.click(await screen.findByTestId("connected-apps-tab-my-apps"));
  const myAppsTab = await screen.findByTestId("connected-apps-my-apps-tab");
  fireEvent.click(within(myAppsTab).getByRole("button", { name: "Edit" }));
  fireEvent.click(await screen.findByTestId("connected-app-regenerate-secret-button"));
  fireEvent.click(await screen.findByTestId("connected-app-regenerate-secret-confirm-button"));
}

test("regenerating a client secret asks for the second step, then regenerates once more and shows it", async () => {
  stubConnectedApps();
  const calls = stubPosts({
    [REGENERATE_URL]: [fail(stepUpRequired()), () => ({
      client: { ...privateClient, updatedAt: "2026-07-09T00:00:00.000Z" },
      clientSecret: "raft_secret_after_step_up",
    })],
    [STEP_UP_URL]: [() => ({ verified: true })],
  });
  await confirmRegenerate();

  const dialog = await findVerifyDialog();
  assert.ok(dialog.textContent?.includes(SECRET_DESCRIPTION));
  await verifyWithCode(dialog, "246810");

  assert.ok((await screen.findByText("raft_secret_after_step_up")) !== null);
  assert.deepEqual(calls, [
    { url: REGENERATE_URL, body: undefined },
    { url: STEP_UP_URL, body: { code: "246810" } },
    { url: REGENERATE_URL, body: undefined },
  ]);
  assert.equal(bodyText().includes(en["settings.connectedApps.regenerateSecretFailed"]), false);
});

test("closing the dialog on Regenerate Client Secret makes no secret and reports nothing", async () => {
  stubConnectedApps();
  const calls = stubPosts({ [REGENERATE_URL]: [fail(stepUpRequired())] });
  await confirmRegenerate();

  await cancelDialog(await findVerifyDialog());

  assert.equal(bodyText().includes(REFUSAL), false);
  assert.equal(bodyText().includes(en["settings.connectedApps.regenerateSecretFailed"]), false);
  assert.ok(screen.queryByTestId("connected-app-secret-copy-button") === null);
  assert.deepEqual(calls.map((call) => call.url), [REGENERATE_URL]);
});

// ── Rotating a webhook signing secret ────────────────────────────────────

const ROTATE_URL = "/integrations/clients/client-1/app-notifications/webhook/rotate-secret";

const NOTIFICATIONS_STATE: AppNotificationsDeveloperState = {
  request_revision: 1,
  current_revision_id: "revision-1",
  current_groups: [],
  current_events: [],
  pending_revision: null,
  webhook: { endpoint_url: "https://alerts.example.com/raft", config_revision: 3, enabled: true, previous_valid_until: null, updated_at: "2026-10-01T00:00:00.000Z" },
};

const NO_SELECTION: AppNotificationSelection = { groups: [], events: [] };

/** The developer's App Notifications, with the error it reports shown the way its page does. */
function NotificationsHarness() {
  const [state, setState] = useState(NOTIFICATIONS_STATE);
  const [error, setError] = useState("");
  const handleChange = useCallback(() => undefined, []);
  return (
    <>
      <DeveloperAppNotifications
        embedded
        clientId="client-1"
        value={NO_SELECTION}
        onChange={handleChange}
        state={state}
        loading={false}
        onStateChange={setState}
        onError={setError}
      />
      <output data-testid="harness-error">{error}</output>
    </>
  );
}

async function confirmRotate() {
  api.get = (async () => ({ data: NOTIFICATIONS_STATE })) as typeof api.get;
  renderWithHost(<NotificationsHarness />);
  fireEvent.click(await screen.findByTestId("app-notifications-rotate-secret"));
  fireEvent.click(await screen.findByTestId("app-notifications-rotate-secret-confirm"));
}

test("rotating the webhook signing secret asks for the second step, then rotates once more and shows it", async () => {
  const calls = stubPosts({
    [ROTATE_URL]: [fail(stepUpRequired()), () => ({ signing_secret: "whsec-after-step-up" })],
    [STEP_UP_URL]: [() => ({ verified: true })],
  });
  await confirmRotate();

  const dialog = await findVerifyDialog();
  assert.ok(dialog.textContent?.includes(SECRET_DESCRIPTION));
  await verifyWithCode(dialog, "135791");

  await waitFor(() => assert.ok(screen.getByTestId("app-notifications-secret").textContent?.includes("whsec-after-step-up")));
  assert.deepEqual(calls, [
    { url: ROTATE_URL, body: undefined },
    { url: STEP_UP_URL, body: { code: "135791" } },
    { url: ROTATE_URL, body: undefined },
  ]);
  assert.equal(screen.getByTestId("harness-error").textContent, "");
});

test("closing the dialog on Rotate Secret rotates nothing and reports nothing", async () => {
  const calls = stubPosts({ [ROTATE_URL]: [fail(stepUpRequired())] });
  await confirmRotate();

  await cancelDialog(await findVerifyDialog());

  assert.equal(screen.getByTestId("harness-error").textContent, "");
  assert.equal(bodyText().includes(REFUSAL), false);
  assert.equal(bodyText().includes(en["settings.connectedApps.appNotifications.failedRotateSecret"]), false);
  assert.ok(screen.queryByTestId("app-notifications-secret-reveal") === null);
  assert.deepEqual(calls.map((call) => call.url), [ROTATE_URL]);
});

// ── Installing a Marketplace app; approving an installed app's update ────

const MARKETPLACE_INSTALL_URL = "/integrations/marketplace/listing-1/install";
const GRANT_URL = "/integrations/marketplace/listing-1/install/app-notifications/grant";
const INSTALL_FAILED = en["settings.connectedApps.failedInstall"];
const GRANT_FAILED = en["settings.connectedApps.appNotifications.failedUpdateInstalled"];

function marketplaceListing(overrides: Record<string, unknown> = {}) {
  return {
    id: "listing-1",
    clientId: "orbital-notes",
    appType: "third_party_global",
    name: "Orbital Notes",
    description: "Review launch notes.",
    whenToUse: null,
    homepageUrl: "https://orbital.example.com",
    returnUrl: "https://orbital.example.com/callback",
    logoUrl: null,
    category: "Productivity & Collaboration",
    dataAccessSummary: null,
    publisherName: "Orbital",
    publisherServerName: "Orbital HQ",
    installedAt: null,
    privateShared: false,
    allowedScopes: ["openid", "profile"],
    appNotificationGroups: [],
    appNotificationEvents: [],
    ...overrides,
  };
}

function installationState(approvalRequired: boolean) {
  return {
    installation_id: "install-1",
    status: "active",
    approved_request_revision_id: "perm-1",
    requested_groups: ["agent", "server"],
    requested_events: [],
    requested_scopes: ["openid", "profile"],
    new_scopes: [],
    approved_groups: ["server"],
    subscribed_events: [],
    effective_groups: ["server"],
    effective_events: [],
    grant_revision: 1,
    subscription_revision: 1,
    app_review_pending: false,
    approval_required: approvalRequired,
  };
}

function stubMarketplaceGets(routes: Record<string, () => unknown>) {
  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: [] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    const route = routes[url];
    if (route) return { data: route() };
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
}

function renderIntegrations() {
  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="integrations" />
      </MemoryRouter>
      <SecondFactorStepUpHost />
    </TestIntlProvider>,
  );
}

function detailDialog(): HTMLElement | null {
  return document.getElementById("connected-app-detail-title")?.closest<HTMLElement>('[data-slot="dialog-content"]') ?? null;
}

async function clickInstallToServer() {
  renderIntegrations();
  fireEvent.click(await screen.findByTestId("connected-apps-tab-marketplace"));
  fireEvent.click(await screen.findByText("Orbital Notes"));
  await waitFor(() => assert.ok(detailDialog() !== null));
  const detail = detailDialog();
  if (!detail) throw new Error("no app detail");
  await clickWhenEnabled(within(detail).getByRole("button", { name: "Install to this server" }));
}

test("installing a Marketplace app asks for the second step, then installs once more", async () => {
  stubMarketplaceGets({ "/integrations/marketplace": () => [marketplaceListing()] });
  const calls = stubPosts({
    [MARKETPLACE_INSTALL_URL]: [fail(stepUpRequired()), () => ({})],
    [STEP_UP_URL]: [() => ({ verified: true })],
  });
  await clickInstallToServer();

  const dialog = await findVerifyDialog();
  assert.ok(dialog.textContent?.includes(APP_ACCESS_DESCRIPTION));
  await verifyWithCode(dialog, "246810");

  await waitFor(() => assert.equal(calls.filter((call) => call.url === MARKETPLACE_INSTALL_URL).length, 2));
  assert.deepEqual(calls.map((call) => call.url), [MARKETPLACE_INSTALL_URL, STEP_UP_URL, MARKETPLACE_INSTALL_URL]);
  assert.deepEqual(calls[1]?.body, { code: "246810" });
  assert.deepEqual(calls[2]?.body, calls[0]?.body);
  // Installed: the detail (no setup URL) closes, with nothing reported.
  await waitFor(() => assert.ok(detailDialog() === null));
  assert.equal(bodyText().includes(INSTALL_FAILED), false);
  assert.equal(bodyText().includes(REFUSAL), false);
});

test("closing the dialog on Install to This Server installs nothing and reports nothing", async () => {
  stubMarketplaceGets({ "/integrations/marketplace": () => [marketplaceListing()] });
  const calls = stubPosts({ [MARKETPLACE_INSTALL_URL]: [fail(stepUpRequired())] });
  await clickInstallToServer();

  await cancelDialog(await findVerifyDialog());

  assert.equal(bodyText().includes(REFUSAL), false);
  assert.equal(bodyText().includes(INSTALL_FAILED), false);
  // The detail stays open and its Install is usable again (not stuck saving).
  const detail = detailDialog();
  if (!detail) throw new Error("the app detail closed");
  const install = within(detail).getByRole("button", { name: "Install to this server" });
  await waitFor(() => assert.equal(install.hasAttribute("disabled"), false));
  assert.deepEqual(calls.map((call) => call.url), [MARKETPLACE_INSTALL_URL]);
});

/** The installed app's detail, with its Approve Update banner; PUT grant answers with `grant` in turn. */
async function clickApproveUpdate(grant: Handler[]) {
  let approved = false;
  stubMarketplaceGets({
    "/integrations/marketplace": () => [marketplaceListing({ installedAt: "2026-06-25T00:00:00.000Z" })],
    "/integrations/marketplace/listing-1/install/app-notifications": () => installationState(!approved),
  });
  stubPosts({});
  const puts: Call[] = [];
  api.put = (async (url: string, body?: unknown) => {
    if (url !== GRANT_URL) throw new Error(`unexpected PUT ${url}`);
    puts.push({ url, body });
    const answer = grant[Math.min(puts.length - 1, grant.length - 1)]!(body);
    approved = true;
    return { data: answer };
  }) as typeof api.put;
  // Step-up goes through POST: record it with the PUTs, in order.
  const post = api.post;
  api.post = (async (url: string, body?: unknown) => {
    if (url === STEP_UP_URL) {
      puts.push({ url, body });
      return { data: { verified: true } };
    }
    return (post as (url: string, body?: unknown) => Promise<unknown>)(url, body);
  }) as typeof api.post;

  renderIntegrations();
  fireEvent.click(await screen.findByTestId("connected-apps-tab-installed"));
  const installedTab = await screen.findByTestId("connected-apps-installed-tab");
  fireEvent.click(within(installedTab).getByRole("button", { name: "Orbital Notes" }));
  const banner = await screen.findByTestId("app-notifications-approval-required");
  await clickWhenEnabled(within(banner).getByRole("button", { name: "Approve update" }));
  return puts;
}

test("approving an installed app's update asks for the second step, then approves once more", async () => {
  const calls = await clickApproveUpdate([fail(stepUpRequired()), () => installationState(false)]);

  const dialog = await findVerifyDialog();
  assert.ok(dialog.textContent?.includes(APP_ACCESS_DESCRIPTION));
  await verifyWithCode(dialog, "135791");

  await waitFor(() => assert.ok(screen.queryByTestId("app-notifications-approval-required") === null));
  assert.deepEqual(calls.map((call) => call.url), [GRANT_URL, STEP_UP_URL, GRANT_URL]);
  assert.deepEqual(calls[1]?.body, { code: "135791" });
  assert.deepEqual(calls[2]?.body, calls[0]?.body);
  assert.equal(bodyText().includes(GRANT_FAILED), false);
});

test("closing the dialog on Approve Update approves nothing and reports nothing", async () => {
  const calls = await clickApproveUpdate([fail(stepUpRequired())]);

  await cancelDialog(await findVerifyDialog());

  assert.equal(bodyText().includes(REFUSAL), false);
  assert.equal(bodyText().includes(GRANT_FAILED), false);
  const banner = screen.getByTestId("app-notifications-approval-required");
  const approve = within(banner).getByRole("button", { name: "Approve update" });
  await waitFor(() => assert.equal(approve.hasAttribute("disabled"), false));
  assert.deepEqual(calls.map((call) => call.url), [GRANT_URL]);
});

// ── Installing an app from its invite link ───────────────────────────────

const INVITE_INSTALL_URL = "/integration-invites/share-token/install";
const INVITE_INSTALL_FAILED = en["pages.integrationInvite.installFailed"];

function inviteResponse(installedAt: string | null = null) {
  return {
    client: {
      id: "client-1",
      clientId: "orbital-notes",
      name: "Orbital Notes",
      description: "Review launch notes from Raft.",
      homepageUrl: "https://orbital.example.com/docs",
      returnUrl: "https://orbital.example.com/return",
      allowedScopes: ["openid", "profile", "identity"],
      appNotificationGroups: [],
      logoUrl: null,
      publisherName: "Orbital",
      sourceServerName: "Publisher Server",
      installedAt,
    },
    link: { id: "link-1", expiresAt: null },
    manageableServers: [{ id: launch.id, name: launch.name, slug: launch.slug, role: "owner", installedAt }],
  };
}

async function clickInstallApp() {
  api.get = (async (url: string) => {
    if (url === "/integration-invites/share-token") return { data: inviteResponse() };
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  renderWithHost(
    <MemoryRouter initialEntries={["/integration-invites/share-token"]}>
      <Routes>
        <Route path="/integration-invites/:token" element={<IntegrationInvitePage />} />
      </Routes>
    </MemoryRouter>,
  );
  await clickWhenEnabled(await screen.findByRole("button", { name: "Install app" }));
}

test("installing from an invite link asks for the second step, then installs once more", async () => {
  const calls = stubPosts({
    [INVITE_INSTALL_URL]: [fail(stepUpRequired()), () => inviteResponse("2026-11-01T00:00:00.000Z")],
    [STEP_UP_URL]: [() => ({ verified: true })],
  });
  await clickInstallApp();

  const dialog = await findVerifyDialog();
  assert.ok(dialog.textContent?.includes(APP_ACCESS_DESCRIPTION));
  await verifyWithCode(dialog, "112233");

  await waitFor(() => assert.ok(bodyText().includes("Orbital Notes is installed for Launch Server.")));
  assert.deepEqual(calls.map((call) => call.url), [INVITE_INSTALL_URL, STEP_UP_URL, INVITE_INSTALL_URL]);
  assert.deepEqual(calls[1]?.body, { code: "112233" });
  assert.deepEqual(calls[2]?.body, calls[0]?.body, "the same request goes once more");
  assert.equal(bodyText().includes(INVITE_INSTALL_FAILED), false);
  assert.equal(bodyText().includes(REFUSAL), false);
});

test("closing the dialog on Install App installs nothing and reports nothing", async () => {
  const calls = stubPosts({ [INVITE_INSTALL_URL]: [fail(stepUpRequired())] });
  await clickInstallApp();

  await cancelDialog(await findVerifyDialog());

  // Install App is usable again (not stuck installing).
  const install = await screen.findByRole("button", { name: "Install app" });
  await waitFor(() => assert.equal(install.hasAttribute("disabled"), false));
  assert.equal(bodyText().includes(REFUSAL), false);
  assert.equal(bodyText().includes(INVITE_INSTALL_FAILED), false);
  assert.equal(bodyText().includes("is installed for"), false);
  assert.deepEqual(calls.map((call) => call.url), [INVITE_INSTALL_URL]);
});

// ── Adding an installed app's bot ────────────────────────────────────────

const BOT_URL = "/integrations/clients/stamp-app/install/bot";
const BOT_FAILED = en["settings.connectedApps.appIdentityGrantFailed"];
const ADD_STAMP = en["settings.connectedApps.appIdentity.addToServer"].replace("{handle}", "stamp").replace("{server}", "Launch Server");

type BotOffer = { offered: true; grant: "pending" | "granted" | "revoked"; handle: string; agentId?: string };

/** Stamp (ships @stamp), installed on Launch Server. */
function stampApp(bot: BotOffer) {
  return marketplaceListing({
    id: "stamp-app",
    clientId: "stamp",
    name: "Stamp",
    description: "Code hosting, PR review and CI.",
    serverId: "publisher-server",
    publishStatus: "published",
    category: "Developer Tools",
    publisherServerName: "botiverse",
    publisherName: null,
    humanMarketplaceVisible: true,
    enabled: true,
    official: false,
    purpose: "",
    enableBot: true,
    bot,
    botGrant: null,
    installedAt: "2026-10-01T00:00:00.000Z",
    installationId: "install-1",
    installStatus: "active",
    setupUrl: null,
    setupDescription: null,
    createdByUserId: "dev",
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
  });
}

/** Opens installed Stamp and clicks its Bot section's Add; `bot()` is read on every load. */
async function clickAddBot(bot: () => BotOffer) {
  stubMarketplaceGets({
    "/integrations/marketplace": () => [stampApp(bot())],
    "/integrations/marketplace/stamp-app/install/app-notifications": () => installationState(false),
    "/mcp/apps": () => ({ apps: [] }),
  });
  renderIntegrations();
  fireEvent.click(await screen.findByTestId("connected-apps-tab-installed"));
  const row = await screen.findByTestId("connected-app-item-stamp-app");
  fireEvent.click(within(row).getByRole("button", { name: "Stamp" }));
  const section = await screen.findByTestId("connected-app-bot-section");
  await clickWhenEnabled(within(section).getByRole("button", { name: ADD_STAMP }));
}

test("adding an installed app's bot asks for the second step, then adds it once more", async () => {
  let bot: BotOffer = { offered: true, grant: "pending", handle: "stamp" };
  const calls = stubPosts({
    [BOT_URL]: [fail(stepUpRequired()), () => {
      bot = { offered: true, grant: "granted", handle: "stamp", agentId: "bot-agent-1" };
      return { installationId: "install-1", botGrant: "granted", bot: { agentId: "bot-agent-1", handle: "stamp", state: "active" } };
    }],
    [STEP_UP_URL]: [() => ({ verified: true })],
  });
  await clickAddBot(() => bot);

  const dialog = await findVerifyDialog();
  assert.ok(dialog.textContent?.includes(APP_ACCESS_DESCRIPTION));
  await verifyWithCode(dialog, "445566");

  await waitFor(() => assert.equal(screen.getByTestId("connected-app-bot-section").getAttribute("data-bot-grant"), "granted"));
  assert.ok(screen.queryByTestId("connected-app-bot-pending-banner") === null);
  assert.deepEqual(calls.map((call) => call.url), [BOT_URL, STEP_UP_URL, BOT_URL]);
  assert.deepEqual(calls[0]?.body, { action: "grant" });
  assert.deepEqual(calls[1]?.body, { code: "445566" });
  assert.deepEqual(calls[2]?.body, calls[0]?.body);
  assert.equal(bodyText().includes(BOT_FAILED), false);
  assert.equal(bodyText().includes(REFUSAL), false);
});

test("closing the dialog on Add bot adds nothing and reports nothing", async () => {
  const calls = stubPosts({ [BOT_URL]: [fail(stepUpRequired())] });
  await clickAddBot(() => ({ offered: true, grant: "pending", handle: "stamp" }));

  await cancelDialog(await findVerifyDialog());

  const section = screen.getByTestId("connected-app-bot-section");
  assert.equal(section.getAttribute("data-bot-grant"), "pending");
  // Its Add is usable again (not stuck busy).
  const add = within(section).getByRole("button", { name: ADD_STAMP });
  await waitFor(() => assert.equal(add.hasAttribute("disabled"), false));
  assert.equal(bodyText().includes(REFUSAL), false);
  assert.equal(bodyText().includes(BOT_FAILED), false);
  assert.deepEqual(calls.map((call) => call.url), [BOT_URL]);
});

// ── Registering an app (its first client secret) ─────────────────────────

const REGISTER_URL = "/integrations/clients";
const REGISTER_FAILED = en["settings.connectedApps.failedRegisterApp"];

const createdClient = {
  ...privateClient,
  id: "created-client",
  clientId: "created-client",
  name: "Created Alerts",
  description: null,
  homepageUrl: null,
  returnUrl: null,
  category: "Other",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

/** My Apps' new-app form, named and submitted with Create; `created()` says whether the list has it yet. */
async function clickCreateApp(created: () => boolean) {
  api.get = (async (url: string) => {
    if (url === "/integrations/clients") return { data: created() ? [createdClient] : [] };
    if (url === "/integrations/built-in") return { data: [] };
    if (url === "/integrations/marketplace") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/integrations/clients/created-client/share-links") {
      throw { response: { status: 404, data: { error: "not found" } } };
    }
    if (url === "/integrations/clients/created-client/app-notifications") {
      return { data: { request_revision: 0, current_revision_id: null, current_groups: [], current_events: [], pending_revision: null, webhook: null } };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  renderIntegrations();
  await chooseRegisterAppMenuItem("own-service");
  fireEvent.change(screen.getByRole("textbox", { name: "App name" }), { target: { value: "Created Alerts" } });
  const form = screen.getByRole("textbox", { name: "App name" }).closest("form");
  if (!form) throw new Error("no register form");
  await clickWhenEnabled(within(form).getByRole("button", { name: "Create" }));
}

test("registering an app asks for a fresh second step, then registers once more and shows its secret", async () => {
  let creates = 0;
  const calls = stubPosts({
    [REGISTER_URL]: [fail(stepUpRequired()), () => {
      creates += 1;
      return { client: createdClient, clientSecret: "raft_secret_register_after_step_up" };
    }],
    [STEP_UP_URL]: [() => ({ verified: true })],
  });
  await clickCreateApp(() => creates > 0);

  const dialog = await findVerifyDialog();
  assert.ok(dialog.textContent?.includes(SECRET_DESCRIPTION));
  await verifyWithCode(dialog, "778899");

  assert.ok((await screen.findByText("raft_secret_register_after_step_up")) !== null);
  assert.equal(creates, 1, "one app is registered");
  assert.deepEqual(calls.map((call) => call.url), [REGISTER_URL, STEP_UP_URL, REGISTER_URL]);
  assert.equal((calls[0]?.body as { name?: string }).name, "Created Alerts");
  assert.deepEqual(calls[1]?.body, { code: "778899" });
  assert.deepEqual(calls[2]?.body, calls[0]?.body, "the same request goes once more");
  assert.equal(bodyText().includes(REGISTER_FAILED), false);
  assert.equal(bodyText().includes(REFUSAL), false);
});

test("closing the dialog on Create registers nothing and reports nothing", async () => {
  const calls = stubPosts({ [REGISTER_URL]: [fail(stepUpRequired())] });
  await clickCreateApp(() => false);

  await cancelDialog(await findVerifyDialog());

  // The form stays open with what was typed, and its Create is usable again (not stuck saving).
  const name = screen.getByRole("textbox", { name: "App name" });
  assert.equal((name as HTMLInputElement).value, "Created Alerts");
  const form = name.closest("form");
  if (!form) throw new Error("the register form closed");
  const create = within(form).getByRole("button", { name: "Create" });
  await waitFor(() => assert.equal(create.hasAttribute("disabled"), false));
  assert.equal(bodyText().includes(REFUSAL), false);
  assert.equal(bodyText().includes(REGISTER_FAILED), false);
  assert.ok(screen.queryByTestId("connected-app-secret-copy-button") === null);
  assert.deepEqual(calls.map((call) => call.url), [REGISTER_URL]);
});
