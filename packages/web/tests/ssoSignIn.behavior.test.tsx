// Single sign-on in the web app (rfcs/083-server-sso.md §5.1, §6.2): the
// sign-in page's "Continue with SSO" finds the connection by the typed email;
// `?auth_callback=sso` exchanges the one-time code (terms for a new account,
// the server's refusal reasons in words); a 403 SSO_REQUIRED or the owner's
// test result routes to the right place.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import LoginPage from "../src/components/auth/LoginPage";
import { SsoAuthCallbackPage } from "../src/components/auth/SsoAuthCallbackPage";
import { ssoServerStartUrl, ssoStartUrlWithReturnTo, ssoTestLandingPath } from "../src/utils/ssoSignIn";

const fixture = vi.hoisted(() => ({ post: vi.fn(), setTokens: vi.fn(), loadUser: vi.fn(), ssoOffered: true }));
vi.mock("../src/api/client", () => ({ default: { post: fixture.post } }));
vi.mock("../src/store/authStore", () => {
  const state = { login: vi.fn(), setTokens: fixture.setTokens, loadUser: fixture.loadUser, loading: false };
  return { useAuthStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }) };
});
vi.mock("../src/hooks/useAuthProviders", () => ({
  useAuthProviders: () => ({ loading: false, enabledProviders: [], expectedCount: 0, ssoOffered: fixture.ssoOffered }),
}));

const SERVER_ID = "6f1c2c1e-6d55-4c1b-9a59-2a4a3c4d5e6f";

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.ssoOffered = true;
  window.history.replaceState({}, "", "/");
});
afterEach(() => cleanup());

function renderLogin() {
  render(<TestIntlProvider><LoginPage onForgotPassword={vi.fn()} /></TestIntlProvider>);
}

test("Continue with SSO uses the typed email, and says so when no Server offers SSO for it", async () => {
  fixture.post.mockResolvedValue({ data: { connections: [] } });
  renderLogin();
  fireEvent.click(screen.getByRole("button", { name: "Continue with SSO" }));
  expect(fixture.post).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "sam@acme.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue with SSO" }));
  await screen.findByText("Single sign-on isn't set up for this email's domain. Sign in another way.");
  expect(fixture.post).toHaveBeenCalledWith("/auth/sso/discover", { email: "sam@acme.test" });
});

test("several organizations on one domain: the person picks one", async () => {
  fixture.post.mockResolvedValue({ data: { connections: [
    { displayName: "Acme Okta", startUrl: "https://api.raft.test/api/auth/sso/start?t=a" },
    { displayName: "Acme Labs", startUrl: "https://api.raft.test/api/auth/sso/start?t=b" },
  ] } });
  renderLogin();
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "sam@acme.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue with SSO" }));
  expect(await screen.findByRole("button", { name: "Acme Okta" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Acme Labs" })).toBeTruthy();
});

test("no Continue with SSO while no Server offers it", () => {
  fixture.ssoOffered = false;
  renderLogin();
  expect(screen.queryByRole("button", { name: "Continue with SSO" })).toBeNull();
});

test("the callback exchanges the code once and stores the session", async () => {
  window.history.replaceState({}, "", "/?auth_callback=sso&code=one-time&returnTo=%2Fs%2Facme");
  fixture.post.mockResolvedValue({ data: { accessToken: "access", refreshToken: "refresh", returnTo: "/s/acme" } });
  render(<TestIntlProvider><SsoAuthCallbackPage /></TestIntlProvider>);
  await waitFor(() => expect(fixture.setTokens).toHaveBeenCalledWith("access", "refresh"));
  expect(fixture.post).toHaveBeenCalledTimes(1);
  expect(fixture.post).toHaveBeenCalledWith("/auth/sso/complete", { code: "one-time" }, { withCredentials: true });
  // The one-time code leaves the address bar.
  expect(window.location.search).toBe("");
});

test("a new account accepts the terms, then the same code completes", async () => {
  window.history.replaceState({}, "", "/?auth_callback=sso&code=new-person");
  fixture.post
    .mockRejectedValueOnce(httpError(409, { code: "legal_acceptance_required" }))
    .mockResolvedValueOnce({ data: { accessToken: "access", refreshToken: "refresh" } });
  render(<TestIntlProvider><SsoAuthCallbackPage /></TestIntlProvider>);
  const accept = await screen.findByRole("checkbox");
  // cindyz, 2026-11-05: checkbox, Continue, then the usage-data notice directly under it.
  const submit = screen.getByRole("button", { name: "Continue" });
  const notice = screen.getByTestId("legal-acceptance-usage-data-notice");
  expect(accept.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(submit.nextElementSibling === notice).toBe(true);
  expect(submit.getAttribute("aria-describedby")).toBe(notice.id);
  fireEvent.click(accept);
  fireEvent.click(submit);
  await waitFor(() => expect(fixture.setTokens).toHaveBeenCalled());
  expect(fixture.post.mock.calls[1]![1]).toMatchObject({ code: "new-person", acceptTerms: true });
});

test("refusals and failed round-trips are explained, never shown raw", async () => {
  window.history.replaceState({}, "", "/?auth_callback=sso&code=existing");
  fixture.post.mockRejectedValue(httpError(403, { code: "email_link_not_attested", error: "Single sign-on can't sign you in." }));
  render(<TestIntlProvider><SsoAuthCallbackPage /></TestIntlProvider>);
  await screen.findByText("A Raft account with this email already exists. Sign in to it another way, or ask your administrator.");
  cleanup();

  window.history.replaceState({}, "", "/?auth_callback=sso&error=sso_cookie_missing");
  render(<TestIntlProvider><SsoAuthCallbackPage /></TestIntlProvider>);
  await screen.findByText("This sign-in was started in another browser or tab. Start again here.");
  cleanup();

  window.history.replaceState({}, "", "/?auth_callback=sso&error=something_new");
  render(<TestIntlProvider><SsoAuthCallbackPage /></TestIntlProvider>);
  await screen.findByText("Single sign-on couldn't sign you in. Try again.");
});

test("start links keep only an in-app return path; a test result lands on that Server's settings", () => {
  expect(new URL(ssoStartUrlWithReturnTo("https://api.raft.test/api/auth/sso/start?t=x", "/s/acme?x=1")).searchParams.get("returnTo")).toBe("/s/acme?x=1");
  expect(new URL(ssoStartUrlWithReturnTo("https://api.raft.test/api/auth/sso/start?t=x", "https://evil.test/")).searchParams.get("returnTo")).not.toContain("evil");
  expect(new URL(ssoServerStartUrl(SERVER_ID, "/s/acme"), window.location.origin).pathname).toMatch(new RegExp(`/auth/sso/servers/${SERVER_ID}/start$`, "u"));

  const servers = [{ id: SERVER_ID, slug: "acme" }];
  expect(ssoTestLandingPath(`?sso_test=ok&server=${SERVER_ID}`, servers)).toBe(`/s/acme/settings/administration?sso_test=ok&server=${SERVER_ID}`);
  expect(ssoTestLandingPath(`?sso_test=ok&server=${SERVER_ID}`, [])).toBeNull();
  expect(ssoTestLandingPath("?other=1", servers)).toBeNull();
});
