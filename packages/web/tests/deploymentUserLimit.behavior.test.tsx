import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DEPLOYMENT_USER_LIMIT_REACHED_CODE } from "@botiverse/raft-shared";

import api from "../src/api/client";
import { TestIntlProvider } from "./helpers/intl";
import InviteAcceptPage from "../src/components/auth/InviteAcceptPage";
import RegisterPage from "../src/components/auth/RegisterPage";
import { inviteeErrorMessage } from "../src/components/externalInvite/externalInviteAccept";
import { __resetAuthProvidersForTest } from "../src/hooks/useAuthProviders";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { isDeploymentUserLimitRefusal } from "../src/utils/deploymentUserLimit";
import type { Locale } from "../src/i18n/locale";

// The Raft License's user limit (source-available, Part I §2): the server
// refuses one more person with deployment_user_limit_reached; the web says so
// with the contact address as a mail link, and warns before Join and on the
// sign-up page (which never stops anyone signing up).

const MAILTO = "mailto:contact@raft.build";
const refusal = (code = DEPLOYMENT_USER_LIMIT_REACHED_CODE) => Object.assign(new Error("http"), {
  response: { status: 403, data: { code, errorCode: code, error: "This Raft Community Edition deployment already has 5 people, the Raft License limit." } },
});

const initialAuthState = useAuthStore.getInitialState();
const originalGet = api.get;

beforeEach(() => {
  __resetAuthProvidersForTest();
});

afterEach(() => {
  cleanup();
  api.get = originalGet;
  vi.restoreAllMocks();
  localStorage.clear();
  __resetAuthProvidersForTest();
  useAuthStore.setState(initialAuthState, true);
  useServerStore.setState({ current: null, servers: [], members: [] } as never);
});

function mailLink(): HTMLAnchorElement {
  const link = screen.getByRole("link", { name: "contact@raft.build" }) as HTMLAnchorElement;
  assert.equal(link.getAttribute("href"), MAILTO);
  return link;
}

test("the refusal is recognised by its code, and the external invite page maps it to its sentence", () => {
  assert.equal(isDeploymentUserLimitRefusal(refusal()), true);
  assert.equal(isDeploymentUserLimitRefusal(refusal("human_seat_limit_reached")), false);
  assert.equal(isDeploymentUserLimitRefusal(new Error("network")), false);
  assert.deepEqual(inviteeErrorMessage(refusal(), "guest", null), { id: "deploymentUserLimit.refused", upgrade: false });
  assert.deepEqual(inviteeErrorMessage(refusal(), "newServer", null), { id: "deploymentUserLimit.refused", upgrade: false });
});

function renderRegister(locale: Locale, deploymentUserLimitReached: boolean) {
  api.get = (async () => ({ data: { providers: [], sso: false, deploymentUserLimitReached } })) as typeof api.get;
  return render(
    <TestIntlProvider locale={locale}>
      <RegisterPage onSwitchToLogin={() => {}} />
    </TestIntlProvider>,
  );
}

test("the sign-up page says the deployment is full, and still lets the person sign up", async () => {
  renderRegister("en", true);
  const notice = await screen.findByTestId("register-user-limit-notice");
  assert.match(notice.textContent ?? "", /already has 5 people, the Raft License limit\. You can still create an account/);
  assert.ok(notice.contains(mailLink()));
  const submit = screen.getByRole("button", { name: "Continue" });
  assert.ok(submit.closest("form") !== null, "the sign-up form is still there");
});

test("the sign-up page has no notice below the limit, and the notice reads in Chinese", async () => {
  renderRegister("en", false);
  await screen.findByRole("button", { name: "Continue" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(screen.queryByTestId("register-user-limit-notice") === null, "no notice below the limit");
  cleanup();
  __resetAuthProvidersForTest();

  renderRegister("zh-cn", true);
  const notice = await screen.findByTestId("register-user-limit-notice");
  assert.match(notice.textContent ?? "", /Raft 社区版部署已有 5 人/);
  assert.ok(notice.contains(mailLink()));
});

const INVITE = {
  kind: "join_link",
  serverName: "Echo",
  inviterName: null,
  memberCount: 0,
  agentCount: 0,
  insideCountsHidden: false,
  humanSeatLimitReached: false,
  humanSeatLimitMessage: null,
  agreement: null,
};

function renderInvite(info: Record<string, unknown>, acceptInvite: () => Promise<unknown>) {
  api.get = (async () => ({ data: info })) as typeof api.get;
  useAuthStore.setState({
    user: { id: "u1", name: "u", displayName: "U" },
    initialized: true,
    acceptInvite,
  } as never);
  useServerStore.setState({ servers: [], current: null, members: [], loading: false, loadServers: async () => {} } as never);
  return render(
    <TestIntlProvider locale="en">
      <MemoryRouter>
        <InviteAcceptPage token="invite-token" onInviteConsumed={() => {}} onSwitchToLogin={() => {}} onSwitchToRegister={() => {}} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

test("the invite page warns before Join at the limit, keeps Join, and says a refused accept with the mail link", async () => {
  renderInvite({ ...INVITE, deploymentUserLimitReached: true }, async () => { throw refusal(); });
  const notice = await screen.findByTestId("invite-user-limit-notice");
  assert.match(notice.textContent ?? "", /only someone already among them can join this server/);
  assert.ok(notice.contains(mailLink()));

  fireEvent.click(screen.getByRole("button", { name: "Join server" }));
  const refused = await screen.findByTestId("invite-user-limit-refused");
  assert.match(refused.textContent ?? "", /To go above it, email contact@raft\.build for a separate license\./);
  assert.ok(refused.contains(mailLink()));
  assert.ok(screen.queryByRole("button", { name: "Join server" }) === null, "no Join after the refusal");
});

test("the invite page has no limit notice below the limit", async () => {
  renderInvite({ ...INVITE, deploymentUserLimitReached: false }, async () => ({ serverName: "Echo", serverId: "s1" }));
  await screen.findByRole("button", { name: "Join server" });
  assert.ok(screen.queryByTestId("invite-user-limit-notice") === null, "no notice below the limit");
});
