import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { LocaleProvider, useLocale } from "../src/i18n/LocaleProvider";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { DISPLAY_LOCALE_STORAGE_KEY, LOCALE_LABELS, SUPPORTED_LOCALES } from "../src/i18n/locale";
import { persistDisplayLanguage } from "../src/i18n/persistDisplayLanguage";
import { TestIntlProvider } from "./helpers/intl";
import SettingsPanel from "../src/components/settings/SettingsPanel";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { useTranslationStore } from "../src/store/translationStore";
import api from "../src/api/client";

// Behavior teeth for the display_language persistence loop (react-intl i18n
// foundation). The loop is: server-persisted user.displayLanguage → App
// reconcile → LocaleProvider.setLocaleFromUser → active UI locale; and the
// reverse writeback lives in Settings (covered by typecheck + the render smoke
// below). These pin the CLIENT reconcile contract 赵梓淇 asked for:
//   (1) after login, the server preference OVERRIDES the stored pre-auth choice;
//   (2) a null / unsupported server value is not an explicit preference, so it
//       must preserve the locale already resolved from storage/browser state.

afterEach(() => {
  cleanup();
  document.documentElement.lang = "en";
  try {
    window.localStorage.clear();
  } catch {
    // ignore storageless environments
  }
});

// Capture the live locale context so a test can call setLocaleFromUser the way
// App.tsx's reconcile effect does, and read back the resulting locale.
let ctx: ReturnType<typeof useLocale> | null = null;
function LocaleProbe() {
  ctx = useLocale();
  return <span data-testid="locale">{ctx.locale}</span>;
}
function mountProvider() {
  ctx = null;
  return render(
    <LocaleProvider>
      <LocaleProbe />
    </LocaleProvider>,
  );
}

test("after login the server displayLanguage overrides the stored pre-auth choice", () => {
  // Storage guess = en (what a first visit resolved to).
  window.localStorage.setItem(DISPLAY_LOCALE_STORAGE_KEY, "en");
  const { getByTestId } = mountProvider();
  assert.equal(getByTestId("locale").textContent, "en", "seeds from storage");
  assert.equal(document.documentElement.lang, "en", "initial metadata follows storage");

  // The signed-in user's server-persisted preference arrives (App reconcile).
  act(() => ctx!.setLocaleFromUser("zh-cn"));
  assert.equal(getByTestId("locale").textContent, "zh-cn", "server preference wins over storage");
  assert.equal(document.documentElement.lang, "zh-CN", "metadata follows the account preference");
  // And it is persisted back to storage so it survives reload.
  assert.equal(window.localStorage.getItem(DISPLAY_LOCALE_STORAGE_KEY), "zh-cn");
});

test("document lang follows initial storage and Settings display-language switches", () => {
  window.localStorage.setItem(DISPLAY_LOCALE_STORAGE_KEY, "zh-cn");
  const { getByTestId } = mountProvider();
  assert.equal(getByTestId("locale").textContent, "zh-cn", "seeds app locale from storage");
  assert.equal(document.documentElement.lang, "zh-CN", "zh-cn app locale uses canonical HTML lang");

  act(() => ctx!.setLocale("en"));
  assert.equal(getByTestId("locale").textContent, "en", "Settings switch applies English");
  assert.equal(document.documentElement.lang, "en", "English switch restores HTML lang");

  act(() => ctx!.setLocale("zh-cn"));
  assert.equal(getByTestId("locale").textContent, "zh-cn", "Settings switch applies Chinese");
  assert.equal(document.documentElement.lang, "zh-CN", "Chinese switch restores canonical HTML lang");
});

test("a null or unsupported server displayLanguage preserves the resolved locale", () => {
  window.localStorage.setItem(DISPLAY_LOCALE_STORAGE_KEY, "zh-cn");
  const { getByTestId } = mountProvider();
  assert.equal(getByTestId("locale").textContent, "zh-cn");
  assert.equal(document.documentElement.lang, "zh-CN");

  // Legacy user with no server preference → keep the automatic/explicit
  // client-side resolution and do not manufacture a server preference.
  act(() => ctx!.setLocaleFromUser(null));
  assert.equal(getByTestId("locale").textContent, "zh-cn", "null preserves the resolved locale");
  assert.equal(document.documentElement.lang, "zh-CN", "null server value preserves metadata");
  assert.equal(window.localStorage.getItem(DISPLAY_LOCALE_STORAGE_KEY), "zh-cn");

  // Unknown legacy values are also not valid explicit choices.
  act(() => ctx!.setLocale("en"));
  act(() => ctx!.setLocaleFromUser("xx-not-a-locale"));
  assert.equal(getByTestId("locale").textContent, "en", "unsupported preserves the resolved locale");
  assert.equal(document.documentElement.lang, "en", "unsupported server value preserves metadata");

  act(() => ctx!.setLocale("zh-cn"));
  act(() => ctx!.setLocaleFromUser(undefined));
  assert.equal(getByTestId("locale").textContent, "zh-cn", "undefined preserves the resolved locale");
  assert.equal(document.documentElement.lang, "zh-CN", "undefined server value preserves metadata");
});

// Tooth 3 — the writeback / read-back half. `persistDisplayLanguage` is what the
// Settings selector calls; testing it directly exercises the real loop without
// depending on the Select popover's jsdom behavior.
const originalPatch = api.patch;
const originalTranslationSettings = useTranslationStore.getState().settings;
afterEach(() => {
  api.patch = originalPatch;
  useAuthStore.setState({ user: null } as never);
  useServerStore.setState({ current: null } as never);
  useTranslationStore.setState({
    settings: originalTranslationSettings,
    settingsServerId: null,
    settingsLoading: false,
    settingsError: null,
  } as never);
});

function seedUser() {
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
}

test("switching display language persists to the account and reflects the server echo", async () => {
  seedUser();
  const calls: Array<{ url: string; body: unknown }> = [];
  api.patch = (async (url: string, body: unknown) => {
    calls.push({ url, body });
    return { data: { displayLanguage: "zh-cn" } }; // server echoes the normalized value
  }) as typeof api.patch;

  const applied: string[] = [];
  await persistDisplayLanguage("zh-cn", (l) => applied.push(l));

  // Applied locally first (instant switch)…
  assert.deepEqual(applied, ["zh-cn"], "local locale applied immediately");
  // …persisted to the account…
  assert.equal(calls.length, 1, "PATCH /auth/me called once");
  assert.equal(calls[0].url, "/auth/me");
  assert.deepEqual(calls[0].body, { displayLanguage: "zh-cn" });
  // …and the server echo merged back so a read is consistent.
  assert.equal(useAuthStore.getState().user?.displayLanguage, "zh-cn");
});

test("a failed persist keeps the local switch and does not corrupt the auth store", async () => {
  seedUser();
  api.patch = (async () => {
    throw new Error("network blip");
  }) as typeof api.patch;

  const applied: string[] = [];
  await persistDisplayLanguage("zh-cn", (l) => applied.push(l)); // must not throw
  assert.deepEqual(applied, ["zh-cn"], "local switch still applied on server failure");
  // Auth store user is left intact (not overwritten with undefined/garbage).
  assert.equal(useAuthStore.getState().user?.id, "user-1");
  assert.equal(useAuthStore.getState().user?.displayLanguage, null);
});

function makeUser(id: string, displayLanguage: string | null) {
  return {
    id, email: `${id}@example.com`, gravatarHash: "", name: id, displayName: id,
    description: null, avatarUrl: null, emailVerified: true,
    preferredLanguage: null, displayLanguage, preferredTimezone: null,
    autoTranslationEnabled: false, preferredTranslationDisplay: "translated",
    preferredTimeFormat: null, preferredMessageBodyFontSize: null,
    referralSource: null, referralSourceOther: null, referralSourceSkippedAt: null,
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("an in-flight persist across a logout/login does NOT splice user A's echo into user B", async () => {
  // User A is signed in and switches language; the PATCH is left in flight.
  useAuthStore.setState({ user: makeUser("A", null), loading: false, initialized: true } as never);
  const gate = deferred<{ data: unknown }>();
  api.patch = (async () => gate.promise) as typeof api.patch;

  const pending = persistDisplayLanguage("zh-cn", () => {});

  // Before A's request returns, the session swaps to user B (logout → login B).
  useAuthStore.setState({ user: makeUser("B", "en"), loading: false, initialized: true } as never);

  // A's response finally lands, echoing A's preference.
  gate.resolve({ data: { displayLanguage: "zh-cn" } });
  await pending;

  // B must be untouched — no cross-principal splice, no locale flip-back.
  const user = useAuthStore.getState().user;
  assert.equal(user?.id, "B", "still user B");
  assert.equal(user?.displayLanguage, "en", "B's displayLanguage is not polluted by A's echo");
});

test("rapid toggling persists in order so the last selection wins (no stale-echo clobber)", async () => {
  useAuthStore.setState({ user: makeUser("T", null), loading: false, initialized: true } as never);
  const gates = [deferred<{ data: unknown }>(), deferred<{ data: unknown }>()];
  const bodies: unknown[] = [];
  let call = 0;
  api.patch = (async (_url: string, body: unknown) => {
    const i = call++;
    bodies.push(body);
    return gates[i].promise;
  }) as typeof api.patch;

  const tick = () => new Promise((r) => setTimeout(r, 0));

  const applied: string[] = [];
  const p1 = persistDisplayLanguage("zh-cn", (l) => applied.push(l));
  const p2 = persistDisplayLanguage("en", (l) => applied.push(l));

  // Release responses OUT OF ORDER — the later intent (en) resolves first, the
  // earlier (zh-cn) last. A naive "spread whatever echo lands into the current
  // user" would end on zh-cn (stale clobber); the serialized + intent-guarded
  // impl must end on en. Serialization also means the 2nd PATCH is only sent
  // after the 1st resolves, so the server sees them in intent order.
  await tick(); // let the 1st PATCH be sent
  gates[1].resolve({ data: { displayLanguage: "en" } }); // later intent's echo ready first
  await tick();
  gates[0].resolve({ data: { displayLanguage: "zh-cn" } }); // earlier intent's echo lands last
  await Promise.all([p1, p2]);

  assert.deepEqual(bodies, [{ displayLanguage: "zh-cn" }, { displayLanguage: "en" }], "PATCHes sent in intent order");
  assert.deepEqual(applied, ["zh-cn", "en"], "local switch applied both, ending on the last");
  // Auth store ends on the LAST selection — the earlier echo must not clobber it.
  assert.equal(useAuthStore.getState().user?.displayLanguage, "en");
});

test("the Settings display-language selector renders the current value and is wired to all supported locales", async () => {
  seedUser();
  seedServer();

  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="language-region" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  const selector = await screen.findByTestId("display-language-select");
  // Closed selector reflects the active locale (en) via its label.
  assert.ok(within(selector).getByText("English"), "shows the active locale label");
  // The rendered selector consumes the canonical locale list; the writeback is
  // covered by persistDisplayLanguage above, without relying on raft-ui popover
  // behavior in jsdom.
  assert.deepEqual(SUPPORTED_LOCALES.map((code) => LOCALE_LABELS[code]), ["English", "简体中文"]);
});

test("an existing Manual preference renders selected without dirtying or rewriting the mode", async () => {
  seedUser();
  seedServer();
  useTranslationStore.setState((state) => ({
    settings: {
      ...state.settings,
      preferredLanguage: "en",
      effectiveLanguage: "en",
      preferredTranslationMode: "manual",
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "translated",
      available: true,
      serverTranslationEnabled: true,
      providerAvailable: true,
    },
    settingsServerId: "s1",
    settingsLoading: false,
    settingsError: null,
  }));

  const calls: Array<{ url: string; body: any }> = [];
  api.patch = (async (url: string, body: any) => {
    calls.push({ url, body });
    return { data: body };
  }) as typeof api.patch;

  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SettingsPanel tab="language-region" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  const manual = await screen.findByTestId("translation-mode-manual");
  assert.equal(manual.getAttribute("aria-checked"), "true");
  const saveButtons = screen.getAllByRole("button", { name: "Save" });
  const languageSave = saveButtons[0] as HTMLButtonElement;
  assert.equal(languageSave.disabled, true, "loading persisted Manual must not dirty the form");

  fireEvent.click(screen.getByTestId("translation-display-original"));
  assert.equal(languageSave.disabled, false);
  fireEvent.click(languageSave);

  await waitFor(() => assert.equal(calls.length, 1));
  assert.deepEqual(calls[0], {
    url: "/auth/me",
    body: { preferredTranslationDisplay: "original" },
  });
  assert.equal(
    calls.some((call) => Object.hasOwn(call.body, "preferredTranslationMode")),
    false,
    "saving another language preference must not rewrite Manual to Off",
  );
});

// Rollout coverage notice (first-wave acceptance): while Chinese ships
// namespace-by-namespace, the Settings display-language selector warns that some
// pages may still be English — but ONLY when the active locale is zh-cn.
function seedServer() {
  useServerStore.setState({
    servers: [{ id: "s1", slug: "s1", name: "S1" }], current: { id: "s1", slug: "s1", name: "S1" },
    members: [], loading: false,
  } as never);
  useTranslationStore.setState({
    settingsServerId: "s1",
    settingsLoading: false,
    settingsError: null,
  } as never);
}
function renderSettingsInLocale() {
  return render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <MemoryRouter>
          <SettingsPanel tab="language-region" />
        </MemoryRouter>
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

test("Settings shows the zh coverage notice only when the active locale is zh-cn", async () => {
  seedUser();
  seedServer();
  window.localStorage.setItem(DISPLAY_LOCALE_STORAGE_KEY, "zh-cn");
  renderSettingsInLocale();
  await screen.findByTestId("display-language-select");
  const notice = screen.getByTestId("zh-coverage-notice");
  assert.match(notice.textContent ?? "", /简体中文仍在完善/);
});

test("Settings hides the coverage notice when the active locale is en", async () => {
  seedUser();
  seedServer();
  window.localStorage.setItem(DISPLAY_LOCALE_STORAGE_KEY, "en");
  renderSettingsInLocale();
  await screen.findByTestId("display-language-select");
  assert.equal(screen.queryByTestId("zh-coverage-notice"), null);
});
