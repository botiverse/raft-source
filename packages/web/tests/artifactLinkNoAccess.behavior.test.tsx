// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
// A canonical Artifact link (`/artifacts/<id>`) that can't open, signed in or out:
// - Tenny's rule: private (`open`'s 404 NOT_VISIBLE), nonexistent and a malformed id render the same page (the
//   same HTML, text and document title), naming nothing of the Artifact; signed out, the same sign-in page with
//   "Sign in to open this Artifact" (back after #250: it says what's happening; xxchan, Kirby); the private and
//   nonexistent links make the same calls;
// - the "can't open" page: what to do (ask whoever shared it), who is signed in, Go to Raft (the last server),
//   Switch Account (sign-in at the same address), Back only with an in-app page behind (on a phone, in a header);
// - `open`'s 404 is the page at once: not after the server list and `locate`, which still runs behind it for a
//   joint channel's Artifact, and whose 404 (or failure) leaves the page as it is;
// - the loading splash with "Loading Artifact" while it loads (the app's boot, the public view's read), never "Loading…" or a bare spinner;
// - the sign-in page keeps the third-party buttons' space while they load; social sign-in returns to the link.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@botiverse/raft-ui";
import type { NavigateFunction } from "react-router-dom";
import { artifactLinkId, asArtifactId } from "@botiverse/raft-shared";
import type { ArtifactWebOpen } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import { signInReaderForTests, signOutReaderForTests } from "./helpers/artifactReader";
import api from "../src/api/client";
import { AppShell } from "../src/App";
import { artifactLinkLeaveServer } from "../src/apps/artifacts";
import ArtifactPermalink from "../src/apps/artifacts/ArtifactPermalink";
import type { ArtifactLinkTarget } from "../src/apps/artifacts/artifactLinks";
import { setArtifactSourceForTests } from "../src/apps/artifacts/artifactSource";
import { resetArtifactOpenEarlyForTests } from "../src/apps/artifacts/artifactOpenEarly";
import { fakeArtifactSource, resetFakeArtifactSourceForTests } from "../src/apps/artifacts/fakeArtifactSource";
import LoginPage from "../src/components/auth/LoginPage";
import { hasInAppPageBehind, UNKNOWN_NAVIGATION_ENTRY } from "../src/hooks/useAppNavigate";
import { __resetAuthProvidersForTest, SIGN_IN_PROVIDER_COUNT_STORAGE } from "../src/hooks/useAuthProviders";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { buildSocialAuthStartUrl, getCurrentReturnTo, sanitizeReturnTo } from "../src/utils/socialAuth";

const PRIVATE = asArtifactId("pt_3c10b4ed-d947-49df-9031-91ae837f010a");
const NONEXISTENT = asArtifactId("pt_00000000-0000-4000-8000-000000000000");
const MALFORMED = "not-an-id";
const HOME = { id: "server-home", slug: "home", name: "Home" };
const ACME = { id: "server-acme", slug: "acme", name: "Acme" };
const user = {
  id: "link-user", email: "link@example.com", name: "linker",
  displayName: "Link User", description: null, avatarUrl: null, emailVerified: true,
  profileSetupCompletedAt: "2026-08-21T00:00:00.000Z",
};

/** Each call to the Artifacts source: `open`s and `locate`s, in order. */
let calls: string[] = [];
/** `open` refuses with 404 (the server's code for that id), `locate` as `locateAnswer` says. */
let openRefusal: Record<string, string> = {};
let locateAnswer: () => Promise<{ serverSlug: string; serverArtifactsOff?: boolean }> = async () => { throw { status: 404, code: "NOT_VISIBLE" }; };

function useSource() {
  calls = [];
  setArtifactSourceForTests({
    ...fakeArtifactSource,
    open: async (target: ArtifactLinkTarget): Promise<ArtifactWebOpen> => {
      calls.push("open");
      throw { status: 404, code: openRefusal[target.id] ?? "NOT_VISIBLE" };
    },
    locate: async () => {
      calls.push("locate");
      return locateAnswer();
    },
  });
}

let navigateFromTest: NavigateFunction = () => {};
function TestNavigator() {
  navigateFromTest = useNavigate();
  const location = useLocation();
  return <output hidden data-testid="location">{location.pathname + location.search}</output>;
}

function mountApp(path: string, initialEntries: string[] = [path]) {
  window.history.replaceState({}, "", path);
  document.title = "Raft";
  return render(<TestIntlProvider><MemoryRouter initialEntries={initialEntries}><AppShell /><TestNavigator /></MemoryRouter></TestIntlProvider>);
}

/** What a reader could compare between two links: the page's HTML, its text and the document's title. */
/**
 * What a reader could compare between two links: the page's HTML, its text and the document's title. React's
 * generated ids (`useId`, `_r_7_`) count every mount in this test process, not anything about the link: one id.
 */
function snapshot(): { html: string; text: string; title: string } {
  const body = document.body.cloneNode(true) as HTMLElement;
  body.querySelector('[data-testid="location"]')?.remove();
  return { html: body.innerHTML.replace(/_r_[0-9a-z]+_/g, "_r_id_"), text: body.textContent ?? "", title: document.title };
}

/** Every scroll area on the page has drawn its gutters at least once (raft-ui does it in an animation frame). */
function scrollAreasDrawn(): boolean {
  const gutters = [...document.querySelectorAll('[data-slot="scroll-area-gutters"]')];
  return gutters.length > 0 && gutters.every((layer) => layer.hasAttribute("style"));
}

const originalGet = api.get;
const originalPost = api.post;
const originalRequest = api.request;
const originalMatchMedia = window.matchMedia;
function phone(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: matches && query.includes("max-width"), media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

/** The public view (signed out) answers 404 for every id: not public. */
function publicViewRefuses() {
  api.request = (async () => {
    throw Object.assign(new Error("HTTP 404"), { isAxiosError: true, response: { status: 404, data: { code: "NOT_VISIBLE" }, headers: {} } });
  }) as typeof api.request;
}

function signedIn() {
  useAuthStore.setState({ user, initialized: true, restoreState: "authenticated", accessToken: "test-access", refreshToken: "test-refresh", loadUser: async () => {} } as never);
}
function signedOut() {
  useAuthStore.setState({ user: null, initialized: true, restoreState: "anonymous", accessToken: null, refreshToken: null, loadUser: async () => {} } as never);
}

// The Artifact's page lays out its content with ResizeObserver, which jsdom lacks.
const originalResizeObserver = globalThis.ResizeObserver;
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
  localStorage.clear();
  signInReaderForTests();
  resetFakeArtifactSourceForTests();
  __resetAuthProvidersForTest();
  phone(false);
  openRefusal = { [PRIVATE]: "NOT_VISIBLE", [NONEXISTENT]: "TARGET_NOT_FOUND" };
  locateAnswer = async () => { throw { status: 404, code: "NOT_VISIBLE" }; };
  useSource();
  useServerStore.setState({
    current: null, loading: true, servers: [],
    loadServers: async () => { useServerStore.setState({ servers: [HOME, ACME], loading: false } as never); },
    loadServerUnreadSummary: async () => {},
  } as never);
  api.get = (async (url: string) => {
    if (url === "/auth/providers") return { data: { providers: [] } };
    return new Promise(() => {});
  }) as typeof api.get;
  api.post = (async () => ({ data: {} })) as typeof api.post;
  publicViewRefuses();
});

afterEach(() => {
  cleanup();
  setArtifactSourceForTests(null);
  resetArtifactOpenEarlyForTests();
  signOutReaderForTests();
  api.get = originalGet;
  api.post = originalPost;
  api.request = originalRequest;
  window.matchMedia = originalMatchMedia;
  globalThis.ResizeObserver = originalResizeObserver;
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

// ---- Tenny's rule ----------------------------------------------------------------------

test("signed in: a private, a nonexistent and a malformed link are the same page (HTML, text, title); private and nonexistent make the same calls", async () => {
  const pages: Array<ReturnType<typeof snapshot>> = [];
  const callsPer: string[][] = [];
  for (const id of [PRIVATE, NONEXISTENT, MALFORMED]) {
    useSource();
    signedIn();
    mountApp(`/artifacts/${id}`);
    await screen.findByTestId("artifact-permalink-unavailable");
    // `locate` behind it, once the server list is in, answers too.
    await act(async () => {});
    await act(async () => {});
    pages.push(snapshot());
    callsPer.push([...calls]);
    cleanup();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    useServerStore.setState({ current: null, loading: true, servers: [] } as never);
  }
  const [privatePage, nonexistentPage, malformedPage] = pages;
  assert.equal(nonexistentPage!.html, privatePage!.html, "nonexistent: the same HTML as private");
  assert.equal(malformedPage!.html, privatePage!.html, "malformed: the same HTML as private");
  assert.equal(new Set(pages.map((page) => page.text)).size, 1);
  assert.equal(new Set(pages.map((page) => page.title)).size, 1, "the same document title");
  assert.deepEqual(callsPer[0], ["open", "locate"]);
  assert.deepEqual(callsPer[1], callsPer[0], "nonexistent asks what private asks");
  assert.deepEqual(callsPer[2], [], "a malformed address isn't an Artifact's: nothing to ask");
  // What it says, and nothing of the Artifact.
  const text = privatePage!.text;
  assert.match(text, /Can't open this Artifact/);
  assert.match(text, /If someone shared it with you, ask them for access\./);
  assert.match(text, /Signed in as link@example\.com/);
  for (const leak of [PRIVATE, NONEXISTENT, "Acme", "Home"]) assert.ok(!privatePage!.html.includes(leak), `never ${leak}`);
});

test("signed out: a private, a nonexistent and a malformed link are the same sign-in page, \"Sign in to open this Artifact\" above the form", async () => {
  const pages: Array<ReturnType<typeof snapshot>> = [];
  for (const id of [PRIVATE, NONEXISTENT, MALFORMED]) {
    signedOut();
    const { container } = mountApp(`/artifacts/${id}`);
    await waitFor(() => assert.ok(container.querySelector('input[type="email"]'), "the sign-in form"));
    await waitFor(() => assert.ok(screen.queryByTestId("social-providers-reserved") === null, "providers in"));
    // The page's scroll area draws its gutters in an animation frame (their sizes in a `style`): compare each page
    // once that frame has run, not whichever side of it the waits above happened to land on.
    await waitFor(() => assert.ok(scrollAreasDrawn(), "the scroll area drawn"));
    // Back after #250: it tells someone signed out why they see sign-in (xxchan, Kirby).
    const purpose = screen.getByTestId("login-purpose");
    assert.equal(purpose.textContent, "Sign in to open this Artifact");
    const form = container.querySelector("form");
    assert.ok(form && (purpose.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING), "above the form");
    assert.equal(screen.getByTestId("location").textContent, `/artifacts/${id}`, "sign-in at the link's own address");
    pages.push(snapshot());
    cleanup();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  }
  assert.equal(pages[1]!.html, pages[0]!.html);
  assert.equal(pages[2]!.html, pages[0]!.html);
  assert.equal(new Set(pages.map((page) => page.title)).size, 1);
  assert.deepEqual(calls, [], "signed out, `open` is never asked");
});

test("the sign-in line only on an Artifact link", async () => {
  signedOut();
  const { container } = mountApp("/login");
  await waitFor(() => assert.ok(container.querySelector('input[type="email"]')));
  assert.ok(screen.queryByTestId("login-purpose") === null);
});

// ---- the "can't open" page ------------------------------------------------------------

test("`open`'s 404 is the page at once: it doesn't wait for the server list or `locate`, whose 404 leaves it as it is", async () => {
  let listIn: () => void = () => {};
  useServerStore.setState({
    loadServers: () => new Promise<void>((resolve) => {
      listIn = () => { useServerStore.setState({ servers: [HOME, ACME], loading: false } as never); resolve(); };
    }),
  } as never);
  signedIn();
  mountApp(`/artifacts/${PRIVATE}`);
  const card = await screen.findByTestId("artifact-permalink-unavailable");
  assert.deepEqual(calls, ["open"], "shown before the list is in and before `locate`");
  let removed = false;
  const watch = new MutationObserver(() => { if (!card.isConnected) removed = true; });
  watch.observe(document.body, { childList: true, subtree: true });
  await act(async () => { listIn(); });
  await act(async () => {});
  watch.disconnect();
  assert.deepEqual(calls, ["open", "locate"], "`locate` once, behind the page");
  assert.ok(!removed && card.isConnected, "the page never went away (no flash)");
});

test("`locate` failing otherwise (offline, too many) leaves \"can't open\", not a failure", async () => {
  locateAnswer = async () => { throw { status: 429, code: "RATE_LIMITED" }; };
  signedIn();
  mountApp(`/artifacts/${PRIVATE}`);
  await screen.findByTestId("artifact-permalink-unavailable");
  await act(async () => {});
  await act(async () => {});
  assert.deepEqual(calls, ["open", "locate"]);
  assert.ok(screen.getByTestId("artifact-permalink-unavailable"));
  assert.ok(screen.queryByTestId("artifact-permalink-failed") === null);
});

test("`locate` finding it (a joint channel's Artifact seen from the reader's other server): the page there", async () => {
  locateAnswer = async () => ({ serverSlug: "acme" });
  signedIn();
  mountApp(`/artifacts/${asArtifactId("pt_fake-runbook")}`);
  await screen.findByTestId("artifact-page");
  assert.equal(useServerStore.getState().current?.slug, "acme");
});

test("a link with the short id: the same Artifact, asked once, at the address as written", async () => {
  useSource();
  signedIn();
  const short = artifactLinkId(PRIVATE);
  mountApp(`/artifacts/${short}`);
  await screen.findByTestId("artifact-permalink-unavailable");
  await act(async () => {});
  await act(async () => {});
  assert.deepEqual(calls, ["open", "locate"], "what the pt_ link asks");
  assert.equal(screen.getByTestId("location").textContent, `/artifacts/${short}`);
});

test("Switch Account signs out: sign-in at the same address, with the line", async () => {
  signedIn();
  mountApp(`/artifacts/${PRIVATE}`);
  const card = await screen.findByTestId("artifact-permalink-unavailable");
  fireEvent.click(within(card).getByRole("button", { name: "Switch account" }));
  await screen.findByTestId("login-purpose");
  assert.equal(useAuthStore.getState().user, null);
  // The same address, as links are written now: the route showed the older link's pt_ id as its short id.
  assert.equal(screen.getByTestId("location").textContent, `/artifacts/${artifactLinkId(PRIVATE)}`);
});

test("an older link's pt_ id, followed in the app: the address shows its short id in place, and the page asks about the same Artifact once", async () => {
  useSource();
  signedIn();
  mountApp(`/artifacts/${PRIVATE}?embed=1`);
  await screen.findByTestId("artifact-permalink-unavailable");
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, `/artifacts/${artifactLinkId(PRIVATE)}?embed=1`, "the query kept"));
  await act(async () => {});
  await act(async () => {});
  assert.deepEqual(calls, ["open", "locate"], "one open for both addresses: the short one names the same Artifact");
});

test("Go to Raft: the last server, else the only one, else the chooser", async () => {
  assert.equal(artifactLinkLeaveServer([HOME, ACME], "acme"), "acme");
  assert.equal(artifactLinkLeaveServer([HOME, ACME], "gone"), null);
  assert.equal(artifactLinkLeaveServer([HOME, ACME], null), null);
  assert.equal(artifactLinkLeaveServer([HOME], null), "home");
  assert.equal(artifactLinkLeaveServer([], null), null);
  localStorage.setItem("slock_last_server_slug", "acme");
  signedIn();
  mountApp(`/artifacts/${MALFORMED}`);
  const card = await screen.findByTestId("artifact-permalink-unavailable");
  const goToRaft = within(card).getByRole("button", { name: "Go to Raft" });
  await act(async () => { fireEvent.click(goToRaft); });
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/s/acme"));
});

test("Back only with an in-app page behind: none for a link opened from outside, and it goes back", async () => {
  signedIn();
  mountApp(`/artifacts/${MALFORMED}`);
  const card = await screen.findByTestId("artifact-permalink-unavailable");
  assert.ok(within(card).queryByRole("button", { name: "Back" }) === null, "opened from outside: no Back");
  cleanup();
  useServerStore.setState({ current: null, loading: true, servers: [] } as never);
  signedIn();
  mountApp("/servers");
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/servers"));
  await act(async () => { navigateFromTest(`/artifacts/${MALFORMED}`); });
  const back = within(await screen.findByTestId("artifact-permalink-unavailable")).getByRole("button", { name: "Back" });
  await act(async () => { fireEvent.click(back); });
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/servers"));
});

test("hasInAppPageBehind: only a page this document has shown", () => {
  assert.equal(hasInAppPageBehind([]), false);
  assert.equal(hasInAppPageBehind(["/artifacts/x"]), false);
  assert.equal(hasInAppPageBehind([UNKNOWN_NAVIGATION_ENTRY, "/artifacts/x"]), false);
  assert.equal(hasInAppPageBehind(["/s/acme", "/artifacts/x"]), true);
});

function renderCard({ onGoBack }: { onGoBack?: () => void }) {
  const left = { count: 0 };
  render(
    <TestIntlProvider>
      <ArtifactPermalink
        id={MALFORMED}
        version={undefined}
        onOpen={() => {}}
        enterServer={async () => false}
        locateFrom={async () => null}
        enterLocated={() => null}
        onBack={() => {}}
        onShowVersion={() => {}}
        onLeave={() => { left.count += 1; }}
        account="link@example.com"
        onSwitchAccount={() => {}}
        onGoBack={onGoBack}
      />
    </TestIntlProvider>,
  );
  return left;
}

test("the page's actions: Go to Raft the one primary, Switch Account and Back secondary; on a phone Back is a header's top-left arrow", async () => {
  let back = 0;
  renderCard({ onGoBack: () => { back += 1; } });
  const card = screen.getByTestId("artifact-permalink-unavailable");
  const labels = within(card).getAllByRole("button").map((button) => button.textContent);
  assert.deepEqual(labels, ["Go to Raft", "Switch account", "Back"], "Title Case");
  // raft-ui's Button: a pink sticker for the one primary action, an ink outline for the rest (the DS's rule).
  const looks = within(card).getAllByRole("button").map((button) => button.className);
  const reference = render(<><Button size="lg" variant="primary">p</Button><Button size="lg" variant="outline">s</Button><Button size="lg" variant="ghost">t</Button></>).container;
  const [primaryLook, outlineLook, ghostLook] = [...reference.querySelectorAll("button")].map((button) => button.className);
  assert.notEqual(primaryLook, outlineLook, "the primary look differs from the outline one");
  assert.deepEqual(looks, [primaryLook, outlineLook, ghostLook], "one primary action: Go to Raft");
  assert.notEqual(looks[1], looks[0], "Switch Account doesn't look primary");
  reference.remove();
  assert.ok(screen.queryByTestId("artifact-permalink-header") === null, "no header on a desktop");
  cleanup();
  phone(true);
  renderCard({ onGoBack: () => { back += 1; } });
  const header = screen.getByTestId("artifact-permalink-header");
  assert.ok(within(screen.getByTestId("artifact-permalink-unavailable")).queryByRole("button", { name: "Back" }) === null, "not in the card on a phone");
  fireEvent.click(within(header).getByRole("button", { name: "Back" }));
  assert.equal(back, 1);
  cleanup();
  renderCard({});
  assert.ok(screen.queryByTestId("artifact-permalink-header") === null, "no page behind: no header");
});

// ---- loading -------------------------------------------------------------------------

// The link's screen is the Artifact loading splash (#proj-workspace:#145): blank for its first second, then the
// pixel icon with "Loading Artifact" as its line.
test("while the app signs in again, an Artifact link shows the loading splash, then \"Loading Artifact\", never \"Loading…\"", async () => {
  useAuthStore.setState({ user: null, initialized: false, restoreState: "restoring", loadUser: () => new Promise(() => {}) } as never);
  localStorage.setItem("slock_access_token", "stored");
  mountApp(`/artifacts/${PRIVATE}`);
  assert.equal(screen.getByTestId("artifact-link-loading-status").getAttribute("role"), "status");
  assert.ok(screen.queryByText("Loading…") === null);
  await waitFor(() => assert.equal(screen.getByTestId("artifact-link-loading-status").textContent, "Loading Artifact"), { timeout: 2500 });
  assert.ok(screen.getByTestId("artifact-splash-pixels"), "with the icon, never bare words");
  assert.ok(screen.queryByText("Loading…") === null);
});

test("signed out, while the public view is read: the same splash, \"Loading Artifact\" under the icon, never a bare spinner", async () => {
  api.request = (() => new Promise(() => {})) as typeof api.request;
  signedOut();
  mountApp(`/artifacts/${PRIVATE}`);
  const status = await screen.findByTestId("artifact-link-loading-status");
  assert.equal(status.getAttribute("role"), "status");
  await waitFor(() => assert.equal(screen.getByTestId("artifact-link-loading-status").textContent, "Loading Artifact"), { timeout: 2500 });
  assert.equal(screen.getByTestId("artifact-link-loading-status").getAttribute("aria-label"), "Loading Artifact");
  assert.ok(screen.getByTestId("artifact-splash-pixels"));
});

// ---- sign-in -------------------------------------------------------------------------

test("the sign-in page keeps the third-party buttons' space while they load (as many as last time), then shows them", async () => {
  let answer: (value: unknown) => void = () => {};
  api.get = ((url: string) => new Promise((resolve) => { if (url === "/auth/providers") answer = resolve; })) as typeof api.get;
  // An earlier page's providers read, still settling, caches its answer: let it, then forget it.
  await act(async () => {});
  __resetAuthProvidersForTest();
  localStorage.removeItem(SIGN_IN_PROVIDER_COUNT_STORAGE);
  render(<TestIntlProvider><LoginPage onForgotPassword={() => {}} /></TestIntlProvider>);
  const reserved = screen.getByTestId("social-providers-reserved");
  assert.equal(reserved.getAttribute("aria-hidden"), "true");
  assert.equal(reserved.querySelectorAll("button").length, 3, "never seen here: all three");
  await act(async () => { answer({ data: { providers: [{ id: "google", label: "Google", enabled: true }, { id: "apple", label: "Apple", enabled: false }] } }); });
  assert.ok(screen.queryByTestId("social-providers-reserved") === null);
  assert.ok(screen.getByRole("button", { name: "Continue with Google" }));
  assert.equal(localStorage.getItem(SIGN_IN_PROVIDER_COUNT_STORAGE), "1", "remembered for next time");
  cleanup();
  __resetAuthProvidersForTest();
  render(<TestIntlProvider><LoginPage onForgotPassword={() => {}} /></TestIntlProvider>);
  assert.equal(screen.getByTestId("social-providers-reserved").querySelectorAll("button").length, 1);
  cleanup();
  __resetAuthProvidersForTest();
  localStorage.setItem(SIGN_IN_PROVIDER_COUNT_STORAGE, "0");
  render(<TestIntlProvider><LoginPage onForgotPassword={() => {}} /></TestIntlProvider>);
  assert.ok(screen.queryByTestId("social-providers-reserved") === null, "none last time: no space kept");
});

test("social sign-in and sign-up from the link return to it (the start URL's returnTo, kept by the callback)", () => {
  window.history.replaceState({}, "", `/artifacts/${PRIVATE}/v/2`);
  const start = new URL(buildSocialAuthStartUrl("google", getCurrentReturnTo()));
  assert.equal(start.searchParams.get("returnTo"), `/artifacts/${PRIVATE}/v/2`);
  // SocialAuthCallbackPage goes to `sanitizeReturnTo(returnTo)`.
  assert.equal(sanitizeReturnTo(start.searchParams.get("returnTo")), `/artifacts/${PRIVATE}/v/2`);
});

test("sign-up from the link: Create one, then the link opens once the account is in", async () => {
  signedOut();
  api.post = (async (url: string) => {
    if (url === "/auth/register") return { data: { user, accessToken: "test-access", refreshToken: "test-refresh" } };
    return { data: {} };
  }) as typeof api.post;
  locateAnswer = async () => ({ serverSlug: "acme" });
  const { container } = mountApp(`/artifacts/${asArtifactId("pt_fake-runbook")}`);
  await screen.findByTestId("login-purpose");
  fireEvent.click(screen.getByRole("button", { name: "Create one" }));
  // The sign-up page loads on demand (a landing page outside the startup bundle): wait for its form.
  const email = await waitFor(() => {
    const input = container.querySelector<HTMLInputElement>('input[type="email"]');
    assert.ok(input, "the sign-up form");
    return input;
  });
  fireEvent.change(email, { target: { value: "link@example.com" } });
  fireEvent.change(container.querySelector<HTMLInputElement>('input[type="password"]')!, { target: { value: "long-enough-password" } });
  fireEvent.click(container.querySelector<HTMLInputElement>('input[type="checkbox"], button[role="checkbox"]')!);
  await act(async () => { fireEvent.submit(container.querySelector("form")!); });
  await screen.findByTestId("artifact-page");
  assert.equal(screen.getByTestId("location").textContent, `/artifacts/${asArtifactId("pt_fake-runbook")}`);
});
