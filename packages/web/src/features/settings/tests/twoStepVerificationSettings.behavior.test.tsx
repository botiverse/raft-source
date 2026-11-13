import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../../../api/client";
import { AccountSection } from "../account/AccountSection";
import type { SecondFactorStatus } from "../../../components/settings/secondFactorApi";
import { __resetAuthProvidersForTest } from "../../../hooks/useAuthProviders";
import { IntlProviderWrapper } from "../../../i18n/IntlProviderWrapper";
import { LocaleProvider } from "../../../i18n/LocaleProvider";
import { useAuthStore } from "../../../store/authStore";
import {
  resetServerFeatureFlagsForTests,
  resolveServerFeatureFlagsForTests,
} from "../../../store/serverFeatureFlags";
import { useServerStore } from "../../../store/serverStore";

// Settings › Account › Two-step verification (#triage:#135). The API is
// stubbed at the axios client, like the other Account tests.

const SERVER_ID = "server-2fa";
const STATUS_URL = "/auth/second-factor/status";
const BACKUP_CODES = [
  "k7p2m-9qztx", "4mxae-n83vb", "w2c9h-h7r0d", "p0vd3-kse6g", "b8tyq-2mnfj",
  "z5r7w-wkcpa", "j3e6d-pa9ts", "g9kxv-41yhc", "c6nbt-8yh2r", "r1sm0-zqe5k",
];

const originalApiGet = api.get;
const originalApiPost = api.post;

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  api.post = originalApiPost;
  __resetAuthProvidersForTest();
  resetServerFeatureFlagsForTests();
  useAuthStore.setState({ user: null } as never);
  useServerStore.setState({ current: null, servers: [] } as never);
});

function seed() {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "owner@example.com",
      name: "owner",
      displayName: "Owner",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      displayLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationMode: "off",
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
  useServerStore.setState({
    servers: [{ id: SERVER_ID, slug: "acme", name: "Acme" }],
    current: { id: SERVER_ID, slug: "acme", name: "Acme" },
    members: [],
    loading: false,
  } as never);
  resolveServerFeatureFlagsForTests(SERVER_ID);
}

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

function offStatus(): SecondFactorStatus {
  return { enabled: false, methods: { totp: false, passkeys: 0, backupCodesRemaining: 0 } };
}

function onStatus(backupCodesRemaining: number): SecondFactorStatus {
  return { enabled: true, methods: { totp: true, passkeys: 0, backupCodesRemaining } };
}

/** GETs answered from `status()`; a status of `null` answers 404. */
function stubGets(status: () => SecondFactorStatus | null) {
  const gets: string[] = [];
  api.get = (async (url: string) => {
    gets.push(url);
    if (url === "/auth/providers") return { data: { providers: [] } };
    if (url === "/auth/identities") return { data: { identities: [], passwordConfigured: true } };
    if (url === STATUS_URL) {
      const current = status();
      if (!current) throw httpError(404, { error: "Not found", code: "not_found", path: "/api/auth/second-factor/status" });
      return { data: current };
    }
    // The Passkeys section beside it (tests/passkeysSettings.behavior.test.tsx (removed in the 2026-11 web DOM test prune)).
    if (url === "/auth/second-factor/passkeys") {
      if (!status()) throw httpError(404, { error: "Not found", code: "not_found", path: "/api/auth/second-factor/passkeys" });
      return { data: { passkeys: [] } };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
  return gets;
}

type PostHandler = (body: unknown) => unknown;

/** Each URL answers with its handlers in turn (the last one repeats); a thrown value is the failure. */
function stubPosts(handlers: Record<string, PostHandler[]>) {
  const posts: Array<{ url: string; body: unknown }> = [];
  const calls = new Map<string, number>();
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    const queue = handlers[url];
    if (!queue) throw new Error(`Unexpected POST ${url}`);
    const n = calls.get(url) ?? 0;
    calls.set(url, n + 1);
    return { data: queue[Math.min(n, queue.length - 1)]!(body) };
  }) as typeof api.post;
  return posts;
}

function renderAccount() {
  return render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <MemoryRouter>
          <AccountSection />
        </MemoryRouter>
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

function typeInto(dialog: HTMLElement, label: string, value: string) {
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
}

test("the server's 404 keeps the section away", async () => {
  seed();
  const gets = stubGets(() => null);
  stubPosts({});

  renderAccount();
  await waitFor(() => assert.ok(gets.includes(STATUS_URL)));

  assert.ok(screen.queryByTestId("two-step-verification-section") === null);
  assert.ok(screen.queryByText("Two-step verification") === null);
});

test("turning on: password again, QR and key, one code to turn on, backup codes once, never /totp/confirm", async () => {
  seed();
  let status = offStatus();
  stubGets(() => status);
  const secret = "JBSWY3DPEHPK3PXP";
  const posts = stubPosts({
    "/auth/second-factor/totp/setup": [
      () => { throw httpError(403, { error: "Confirm your password to set up an authenticator app.", code: "reauth_required" }); },
      () => ({ secret, otpauthUri: `otpauth://totp/Raft:owner%40example.com?secret=${secret}&issuer=Raft` }),
    ],
    "/auth/second-factor/reauth/password": [() => ""],
    "/auth/second-factor/enable": [() => {
      status = onStatus(10);
      return { backupCodes: BACKUP_CODES };
    }],
  });

  renderAccount();
  const section = await screen.findByTestId("two-step-verification-section");
  assert.ok(within(section).getByText("Off"));
  fireEvent.click(within(section).getByRole("button", { name: "Turn on" }));

  // The server wants a fresh proof: the password, then setup again.
  const reauth = await screen.findByRole("dialog", { name: "Verify it's you" });
  assert.ok(within(reauth).getByText("Enter your password to set up an authenticator app. You won't be asked again for 10 minutes."));
  typeInto(reauth, "Password", "hunter2-correct");
  fireEvent.click(within(reauth).getByRole("button", { name: "Verify" }));

  const setup = await screen.findByRole("dialog", { name: "Set up authenticator app" });
  await waitFor(() => assert.equal(within(setup).getByTestId("two-step-totp-secret").textContent, secret));
  assert.ok(within(setup).getByText("Turning it on signs you out of your other browsers. Computers and the raft CLI stay connected."));
  typeInto(setup, "Authenticator code", "123 456");
  fireEvent.click(within(setup).getByRole("button", { name: "Turn on" }));

  const done = await screen.findByText("Two-step verification is on.");
  const codesDialog = screen.getByRole("dialog", { name: "Turn on two-step verification" });
  assert.ok(codesDialog.contains(done));
  const codes = within(codesDialog).getByTestId("two-step-backup-codes");
  for (const code of BACKUP_CODES) assert.ok(within(codes).getByText(code));
  assert.ok(within(codesDialog).getByRole("button", { name: "Copy" }));
  assert.ok(within(codesDialog).getByRole("button", { name: "Download" }));

  assert.deepEqual(posts, [
    { url: "/auth/second-factor/totp/setup", body: {} },
    { url: "/auth/second-factor/reauth/password", body: { password: "hunter2-correct" } },
    { url: "/auth/second-factor/totp/setup", body: {} },
    { url: "/auth/second-factor/enable", body: { code: "123456" } },
  ]);
  assert.ok(!posts.some((post) => post.url === "/auth/second-factor/totp/confirm"), "turning on never calls /totp/confirm");

  fireEvent.click(within(codesDialog).getByRole("button", { name: "Done" }));
  await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
  await waitFor(() => assert.ok(within(section).getByText("On")));
  assert.ok(within(section).getByText("10 of 10 left"));
  assert.ok(within(section).getByRole("button", { name: "Turn off" }));
  for (const code of BACKUP_CODES) assert.ok(screen.queryByText(code) === null, "backup codes are shown once");
});

test("regenerating backup codes needs an authenticator code and shows the new set once", async () => {
  seed();
  let status = onStatus(2);
  stubGets(() => status);
  const posts = stubPosts({
    "/auth/second-factor/backup-codes/regenerate": [
      () => { throw httpError(400, { error: "That code didn't work.", code: "second_factor_code_invalid" }); },
      () => {
        status = onStatus(10);
        return { backupCodes: BACKUP_CODES };
      },
    ],
  });

  renderAccount();
  const section = await screen.findByTestId("two-step-verification-section");
  assert.ok(within(section).getByText("2 of 10 left"));
  assert.ok(within(section).getByText("Only 2 backup codes left. Regenerate them so you don't get locked out."));
  // DS Forms › A setting's row: the setting, then a row per method, ListRows of
  // one ListRowGroup; the low-codes warning sits in the Backup codes row's body.
  const group = within(section).getByTestId("two-step-verification-rows");
  assert.equal(group.getAttribute("data-slot"), "list-row-group");
  const backup = within(section).getByRole("group", { name: "Backup codes" });
  assert.equal(backup.getAttribute("data-slot"), "list-row");
  assert.ok(backup.parentElement === group, "Backup codes is a row of the group");
  assert.ok(within(backup).getByText("Only 2 backup codes left. Regenerate them so you don't get locked out.").closest("[data-slot=list-row-body]"));
  assert.ok(within(section).getByTestId("two-step-verification-state").closest("[data-slot=list-row]")?.parentElement === group, "the setting is the group's first row");
  assert.ok(section.querySelector("[data-slot=card]") === null, "no cards inside a card");

  fireEvent.click(within(section).getByRole("button", { name: "Regenerate" }));
  const confirm = await screen.findByRole("dialog", { name: "Regenerate backup codes?" });
  assert.ok(within(confirm).getByText("Your old backup codes stop working right away, and your other browsers are signed out. Computers and the raft CLI stay connected. You'll get 10 new ones to save."));

  typeInto(confirm, "Authenticator code", "111111");
  fireEvent.click(within(confirm).getByRole("button", { name: "Regenerate" }));
  assert.ok(await within(confirm).findByText(
    "That code didn't work. Check the time on your phone is set automatically, then try the newest code.",
  ));

  typeInto(confirm, "Authenticator code", "222222");
  fireEvent.click(within(confirm).getByRole("button", { name: "Regenerate" }));
  const fresh = await screen.findByRole("dialog", { name: "New backup codes" });
  for (const code of BACKUP_CODES) assert.ok(within(fresh).getByText(code));
  assert.deepEqual(posts, [
    { url: "/auth/second-factor/backup-codes/regenerate", body: { code: "111111" } },
    { url: "/auth/second-factor/backup-codes/regenerate", body: { code: "222222" } },
  ]);

  fireEvent.click(within(fresh).getByRole("button", { name: "Done" }));
  await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
  await waitFor(() => assert.ok(within(section).getByText("10 of 10 left")));
  assert.ok(within(section).queryByText(/backup codes left/) === null, "the low-codes warning is gone");
  for (const code of BACKUP_CODES) assert.ok(screen.queryByText(code) === null, "backup codes are shown once");
});

test("turning off with a backup code says when a code was already used, then turns it off", async () => {
  seed();
  let status = onStatus(8);
  stubGets(() => status);
  const posts = stubPosts({
    "/auth/second-factor/disable": [
      () => { throw httpError(400, { error: "That backup code was already used.", code: "backup_code_used" }); },
      () => {
        status = offStatus();
        return { enabled: false };
      },
    ],
  });

  renderAccount();
  const section = await screen.findByTestId("two-step-verification-section");
  fireEvent.click(within(section).getByRole("button", { name: "Turn off" }));

  const dialog = await screen.findByRole("dialog", { name: "Turn off two-step verification?" });
  assert.ok(within(dialog).getByLabelText("Authenticator code"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Use a backup code" }));
  // The field is its label; no format hint under it (HelperText step 1).
  assert.ok(!dialog.textContent?.includes("Capitals and the hyphen are optional"), dialog.textContent ?? "");

  typeInto(dialog, "Backup code", "abcde-12345");
  fireEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));
  assert.ok(await within(dialog).findByText("That backup code was already used. Each code works once, so try another one."));

  typeInto(dialog, "Backup code", " fghij-67890 ");
  fireEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));
  await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
  await waitFor(() => assert.ok(within(section).getByText("Off")));
  assert.ok(within(section).getByRole("button", { name: "Turn on" }));

  assert.deepEqual(posts, [
    { url: "/auth/second-factor/disable", body: { backupCode: "abcde-12345" } },
    { url: "/auth/second-factor/disable", body: { backupCode: "fghij-67890" } },
  ]);
});

test("a locked password check says until when and goes no further", async () => {
  seed();
  stubGets(() => offStatus());
  const posts = stubPosts({
    "/auth/second-factor/totp/setup": [
      () => { throw httpError(403, { error: "Confirm your password to set up an authenticator app.", code: "reauth_required" }); },
    ],
    "/auth/second-factor/reauth/password": [
      () => { throw httpError(429, { error: "Too many wrong passwords. Try again later.", code: "reauth_locked", lockedUntil: "2026-10-31T12:15:00.000Z" }); },
    ],
  });

  renderAccount();
  const section = await screen.findByTestId("two-step-verification-section");
  fireEvent.click(within(section).getByRole("button", { name: "Turn on" }));

  const reauth = await screen.findByRole("dialog", { name: "Verify it's you" });
  typeInto(reauth, "Password", "guess");
  fireEvent.click(within(reauth).getByRole("button", { name: "Verify" }));

  const locked = await within(reauth).findByText(/^Too many wrong passwords\. Try again after .+\.$/);
  assert.ok(locked);
  assert.ok(screen.getByRole("dialog", { name: "Verify it's you" }), "the dialog stays on the password step");
  assert.deepEqual(posts.map((post) => post.url), [
    "/auth/second-factor/totp/setup",
    "/auth/second-factor/reauth/password",
  ]);
});
