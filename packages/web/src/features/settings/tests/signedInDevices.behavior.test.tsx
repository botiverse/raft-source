// Settings › Account › Signed-in devices (server routes/mySessions.ts): the
// person's own sign-ins, This device without an action, and Sign out for the
// others, one at a time or all at once. Signing out asks why when it would
// leave something the sign-in approved working (Sign out, or I no longer have
// it, which says how much it disconnects), and only then; the server's proof
// refusals (reauth_required, second_factor_step_up_required: I no longer
// have it only) open the password or "Verify it's you" dialog and the choice
// goes again; Can't verify? there also offers signing out with the password
// alone (sign_out). The API is stubbed at the axios client.
import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../../../api/client";
import SecondFactorStepUpHost from "../../../components/settings/SecondFactorStepUpHost";
import { resetSecondFactorStepUpForTests } from "../../../components/settings/secondFactorStepUp";
import { IntlProviderWrapper } from "../../../i18n/IntlProviderWrapper";
import { LocaleProvider } from "../../../i18n/LocaleProvider";
import { useAuthStore } from "../../../store/authStore";
import { SignedInDevicesSection } from "../account/SignedInDevicesSection";

const CURRENT = "11111111-1111-4111-8111-111111111111";
const LAPTOP = "22222222-2222-4222-8222-222222222222";
const PHONE = "33333333-3333-4333-8333-333333333333";
const NO_REACH = { computers: 0, agentKeys: 0 };

const originalGet = api.get;
const originalPost = api.post;
const originalDelete = api.delete;

afterEach(() => {
  cleanup();
  resetSecondFactorStepUpForTests();
  api.get = originalGet;
  api.post = originalPost;
  api.delete = originalDelete;
  useAuthStore.setState({ user: null } as never);
});

function session(id: string, platform: string | null, current: boolean, reach = NO_REACH) {
  return {
    id,
    platform,
    version: platform ? "2.4.1" : null,
    createdAt: "2026-11-01T10:00:00.000Z",
    lastActiveAt: "2026-11-13T10:00:00.000Z",
    current,
    secondFactorVerified: false,
    lostDeviceReach: reach,
  };
}

type Call = { method: string; url: string; body: unknown };
type Handler = (body: unknown) => unknown;

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

function fail(err: Error): Handler {
  return () => {
    throw err;
  };
}

/** GET /me/sessions answers `list()` each time; writes by "METHOD url", each queue in turn (the last repeats). */
function stubApi(list: () => unknown, handlers: Record<string, Handler[]>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  api.get = (async (url: string) => {
    calls.push({ method: "GET", url, body: undefined });
    if (url === "/me/sessions") return { data: list() };
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
  const answer = (method: string, url: string, body: unknown) => {
    calls.push({ method, url, body });
    const key = `${method} ${url}`;
    const queue = handlers[key];
    if (!queue) throw new Error(`Unexpected ${key}`);
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    return { data: queue[Math.min(n, queue.length - 1)]!(body) };
  };
  api.post = (async (url: string, body?: unknown) => answer("POST", url, body)) as typeof api.post;
  api.delete = (async (url: string, config?: { data?: unknown }) => answer("DELETE", url, config?.data)) as typeof api.delete;
  return calls;
}

function writes(calls: Call[]) {
  return calls.filter((call) => call.method !== "GET");
}

function renderSection(passwordConfigured: boolean | null = true) {
  return render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <MemoryRouter>
          <SignedInDevicesSection passwordConfigured={passwordConfigured} />
          <SecondFactorStepUpHost />
        </MemoryRouter>
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

async function clickWhenEnabled(button: HTMLElement) {
  await waitFor(() => assert.equal(button.hasAttribute("disabled"), false));
  fireEvent.click(button);
}

async function openRowSignOut(id: string) {
  fireEvent.click(await screen.findByTestId(`signed-in-device-sign-out-${id}`));
  return screen.findByTestId("sign-out-device-dialog");
}

async function confirm(dialog: HTMLElement) {
  await clickWhenEnabled(within(dialog).getByTestId("sign-out-device-confirm"));
}

async function dialogGone() {
  await waitFor(() => assert.equal(screen.queryByTestId("sign-out-device-dialog") === null, true));
}

const LAPTOP_REACH = { computers: 2, agentKeys: 1 };
const twoDevices = () => ({
  sessions: [session(CURRENT, "browser", true), session(LAPTOP, "desktop_app", false, LAPTOP_REACH), session(PHONE, "ios", false)],
  othersLostDeviceReach: { computers: 3, agentKeys: 1 },
});

test("the list: This device first with its badge and no action, the others with Sign out; Computers are elsewhere", async () => {
  stubApi(twoDevices, {});
  renderSection();

  const current = await screen.findByTestId(`signed-in-device-${CURRENT}`);
  assert.ok(within(current).getByText("Web"));
  assert.ok(within(current).getByText("This device"));
  assert.ok(within(current).getByText(/Version 2\.4\.1 · Signed in .* · Active now/));
  assert.equal(within(current).queryByRole("button") === null, true);

  const laptop = screen.getByTestId(`signed-in-device-${LAPTOP}`);
  assert.ok(within(laptop).getByText("Desktop"));
  assert.equal(within(laptop).queryByText("This device") === null, true);
  assert.ok(within(laptop).getByRole("button", { name: "Sign out" }));
  assert.ok(within(screen.getByTestId(`signed-in-device-${PHONE}`)).getByText("iOS"));

  assert.ok(screen.getByText(/the raft CLI are managed on the/));
  assert.ok(screen.getByRole("button", { name: "Computers" }));
  assert.ok(screen.getByRole("button", { name: "Sign out of all other devices" }));
});

test("an unknown client is Unknown device", async () => {
  stubApi(() => ({ sessions: [session(CURRENT, "browser", true), session(LAPTOP, null, false)], othersLostDeviceReach: NO_REACH }), {});
  renderSection();
  assert.ok(within(await screen.findByTestId(`signed-in-device-${LAPTOP}`)).getByText("Unknown device"));
});

test("Sign out (the default answer) sends sign_out, then reads the list again", async () => {
  const calls = stubApi(twoDevices, { [`DELETE /me/sessions/${LAPTOP}`]: [() => ({ cascade: "none" })] });
  renderSection();

  const dialog = await openRowSignOut(LAPTOP);
  assert.ok(screen.getByRole("dialog", { name: "Sign out of Desktop" }));
  const radios = within(dialog).getAllByRole("radio");
  assert.equal(radios.length, 2);
  assert.equal(radios[0]!.getAttribute("aria-checked"), "true", "Sign out is chosen by default");
  assert.ok(within(dialog).getByText(/If this device might be in someone else's hands/));
  assert.equal(within(dialog).getByTestId("sign-out-device-confirm").textContent, "Sign out");
  await confirm(dialog);

  await dialogGone();
  assert.deepEqual(writes(calls), [{ method: "DELETE", url: `/me/sessions/${LAPTOP}`, body: { reason: "sign_out" } }]);
  await waitFor(() => assert.equal(calls.filter((call) => call.url === "/me/sessions").length, 2));
});

test("I no longer have it says what it disconnects and sends lost_device", async () => {
  const calls = stubApi(twoDevices, { [`DELETE /me/sessions/${LAPTOP}`]: [() => ({ cascade: "done" })] });
  renderSection();

  const dialog = await openRowSignOut(LAPTOP);
  assert.equal(
    within(dialog).getByTestId("sign-out-device-lost-reach").textContent,
    "Also disconnects 2 computers and 1 agent key approved from this device.",
  );
  fireEvent.click(within(dialog).getAllByRole("radio")[1]!);
  await waitFor(() => assert.equal(within(dialog).getByTestId("sign-out-device-confirm").textContent, "Sign out and disconnect"));
  await confirm(dialog);

  await dialogGone();
  assert.deepEqual(writes(calls), [{ method: "DELETE", url: `/me/sessions/${LAPTOP}`, body: { reason: "lost_device" } }]);
});

test("nothing approved from the device: one question, Sign out, no choice", async () => {
  const calls = stubApi(twoDevices, { [`DELETE /me/sessions/${PHONE}`]: [() => ({ cascade: "none" })] });
  renderSection();

  const dialog = await openRowSignOut(PHONE);
  assert.ok(screen.getByRole("dialog", { name: "Sign out of iOS?" }));
  assert.equal(within(dialog).queryAllByRole("radio").length, 0);
  assert.equal(within(dialog).queryByText("I no longer have it") === null, true);
  await confirm(dialog);

  await dialogGone();
  assert.deepEqual(writes(calls), [{ method: "DELETE", url: `/me/sessions/${PHONE}`, body: { reason: "sign_out" } }]);
});

test("reauth_required asks for the password, then signs out once more", async () => {
  const calls = stubApi(twoDevices, {
    [`DELETE /me/sessions/${PHONE}`]: [
      fail(httpError(403, { error: "Confirm it's you again before signing out a sign-in.", code: "reauth_required" })),
      () => ({ cascade: "none" }),
    ],
    "POST /auth/second-factor/reauth/password": [() => undefined],
  });
  renderSection();

  await confirm(await openRowSignOut(PHONE));
  const reauth = await screen.findByTestId("signed-in-devices-reauth-dialog");
  assert.ok(within(reauth).getByText(/Enter your password to sign out a device/));
  // The code picks the words; the server's sentence is never shown.
  assert.equal(screen.queryByText(/before signing out a sign-in/) === null, true);
  fireEvent.change(within(reauth).getByLabelText("Password"), { target: { value: "hunter2-password" } });
  await clickWhenEnabled(within(reauth).getByRole("button", { name: "Verify" }));

  await dialogGone();
  assert.deepEqual(writes(calls), [
    { method: "DELETE", url: `/me/sessions/${PHONE}`, body: { reason: "sign_out" } },
    { method: "POST", url: "/auth/second-factor/reauth/password", body: { password: "hunter2-password" } },
    { method: "DELETE", url: `/me/sessions/${PHONE}`, body: { reason: "sign_out" } },
  ]);
});

test("reauth_required without a password says to sign in again; closing it leaves the choice open", async () => {
  const calls = stubApi(twoDevices, {
    [`DELETE /me/sessions/${PHONE}`]: [fail(httpError(403, { code: "reauth_required" }))],
  });
  renderSection(false);

  const dialog = await openRowSignOut(PHONE);
  await confirm(dialog);
  const reauth = await screen.findByTestId("signed-in-devices-reauth-dialog");
  assert.ok(within(reauth).getByText(/signs in without a password/));
  fireEvent.click(within(reauth).getByRole("button", { name: "Done" }));

  await waitFor(() => assert.equal(screen.queryByTestId("signed-in-devices-reauth-dialog") === null, true));
  assert.ok(screen.getByTestId("sign-out-device-dialog"));
  assert.equal(writes(calls).length, 1);
});

/** Row Sign out, I no longer have it, Sign out and disconnect. */
async function confirmLost(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getAllByRole("radio")[1]!);
  await waitFor(() => assert.equal(within(dialog).getByTestId("sign-out-device-confirm").textContent, "Sign out and disconnect"));
  await confirm(dialog);
}

const STEP_UP = (methods: string[] = ["totp", "backup_code"]) => fail(httpError(403, { code: "second_factor_step_up_required", methods }));

async function openCantVerify() {
  const verify = await screen.findByRole("dialog", { name: "Verify it's you" }, { timeout: 5000 });
  fireEvent.click(within(verify).getByRole("button", { name: "Lost the device with your authenticator?" }));
  return screen.findByRole("dialog", { name: "Can't verify?" });
}

test("second_factor_step_up_required (I no longer have it) opens Verify it's you, then signs out once more", async () => {
  const calls = stubApi(twoDevices, {
    [`DELETE /me/sessions/${LAPTOP}`]: [STEP_UP(), () => ({ cascade: "done" })],
    "POST /auth/second-factor/step-up": [() => ({ verified: true })],
  });
  renderSection();

  await confirmLost(await openRowSignOut(LAPTOP));
  const verify = await screen.findByRole("dialog", { name: "Verify it's you" }, { timeout: 5000 });
  assert.ok(within(verify).getByText("Signing out a lost device and disconnecting what it approved needs a fresh second step. It lasts 10 minutes."));
  fireEvent.change(within(verify).getByLabelText("Authenticator code"), { target: { value: "123 456" } });
  await clickWhenEnabled(within(verify).getByRole("button", { name: "Verify" }));

  await dialogGone();
  assert.deepEqual(writes(calls), [
    { method: "DELETE", url: `/me/sessions/${LAPTOP}`, body: { reason: "lost_device" } },
    { method: "POST", url: "/auth/second-factor/step-up", body: { code: "123456" } },
    { method: "DELETE", url: `/me/sessions/${LAPTOP}`, body: { reason: "lost_device" } },
  ]);
});

test("Can't verify? (I no longer have it) offers a backup code, Reset your password by email first, signing it out now with the password, and the two-step reset as a link", async () => {
  useAuthStore.setState({ user: { id: "user-1", email: "owner@example.com" } } as never);
  const calls = stubApi(twoDevices, {
    [`DELETE /me/sessions/${LAPTOP}`]: [STEP_UP()],
    "POST /auth/second-factor/recovery": [() => ({ ok: true })],
  });
  renderSection();

  await confirmLost(await openRowSignOut(LAPTOP));
  const lost = await openCantVerify();
  assert.ok(within(lost).getByRole("button", { name: /backup code/i }));
  assert.equal(
    within(lost).getByTestId("step-up-password-email-body").textContent,
    "Signs out every device right away, this one included, and disconnects what they approved. You'll need your second step, or the two-step reset, to sign back in."
      + " Once this device is signed out, you can start the two-step reset from the sign-in page.",
  );
  assert.equal(within(lost).getByTestId("step-up-password-email").textContent, "Reset your password by email");
  assert.equal(
    within(lost).getByTestId("step-up-sign-out-instead-offer").textContent,
    "You can still sign it out now with your password alone. The computers and agent keys it approved keep working until you disconnect them with your second step."
      + "Sign it out now with your password",
  );
  // No passkey among the ways in: no passkey warning.
  assert.equal(within(lost).queryByTestId("step-up-lost-passkey") === null, true);

  // The two-step reset stays: a link, the way back in afterwards.
  fireEvent.click(within(lost).getByRole("button", { name: "Reset two-step verification by email" }));
  const sent = await screen.findByRole("dialog", { name: "Check your email" });
  assert.ok(within(sent).getByText(/owner@example\.com/));
  assert.ok(within(sent).getByText("When the reset finishes, every device is signed out, including that one."));
  assert.deepEqual(writes(calls).at(-1), { method: "POST", url: "/auth/second-factor/recovery", body: { email: "owner@example.com" } });
});

test("Reset your password by email sends the forgot-password email to the person's own address", async () => {
  useAuthStore.setState({ user: { id: "user-1", email: "owner@example.com" } } as never);
  const calls = stubApi(twoDevices, {
    [`DELETE /me/sessions/${LAPTOP}`]: [STEP_UP()],
    "POST /auth/forgot-password": [() => ({ ok: true })],
  });
  renderSection();

  await confirmLost(await openRowSignOut(LAPTOP));
  const lost = await openCantVerify();
  await clickWhenEnabled(within(lost).getByRole("button", { name: "Reset your password by email" }));

  const sent = await screen.findByRole("dialog", { name: "Check your email" });
  assert.ok(within(sent).getByText(
    "We sent a link to owner@example.com. When you set the new password, every device is signed out, this one included.",
  ));
  assert.deepEqual(writes(calls), [
    { method: "DELETE", url: `/me/sessions/${LAPTOP}`, body: { reason: "lost_device" } },
    { method: "POST", url: "/auth/forgot-password", body: { email: "owner@example.com" } },
  ]);
});

test("with a passkey enrolled, Can't verify? warns that a passkey on the lost device still signs in until it is removed", async () => {
  useAuthStore.setState({ user: { id: "user-1", email: "owner@example.com" } } as never);
  stubApi(twoDevices, { [`DELETE /me/sessions/${LAPTOP}`]: [STEP_UP(["totp", "passkey", "backup_code"])] });
  renderSection();

  await confirmLost(await openRowSignOut(LAPTOP));
  const lost = await openCantVerify();
  assert.equal(
    within(lost).getByTestId("step-up-lost-passkey").textContent,
    "If the lost device holds a passkey for Raft, it can still sign in until you remove that passkey in Settings › Account › Passkeys.",
  );
});

test("Can't verify? › Sign it out now with your password sends sign_out (the password asked first), and the device leaves without a second step", async () => {
  useAuthStore.setState({ user: { id: "user-1", email: "owner@example.com" } } as never);
  const calls = stubApi(twoDevices, {
    [`DELETE /me/sessions/${LAPTOP}`]: [
      STEP_UP(["totp"]),
      fail(httpError(403, { code: "reauth_required" })),
      () => ({ cascade: "none" }),
    ],
    "POST /auth/second-factor/reauth/password": [() => undefined],
  });
  renderSection();

  await confirmLost(await openRowSignOut(LAPTOP));
  const lost = await openCantVerify();
  fireEvent.click(within(lost).getByRole("button", { name: "Sign it out now with your password" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Can't verify?" }) === null, true));

  const reauth = await screen.findByTestId("signed-in-devices-reauth-dialog");
  fireEvent.change(within(reauth).getByLabelText("Password"), { target: { value: "hunter2-password" } });
  await clickWhenEnabled(within(reauth).getByRole("button", { name: "Verify" }));

  await dialogGone();
  assert.deepEqual(writes(calls), [
    { method: "DELETE", url: `/me/sessions/${LAPTOP}`, body: { reason: "lost_device" } },
    { method: "DELETE", url: `/me/sessions/${LAPTOP}`, body: { reason: "sign_out" } },
    { method: "POST", url: "/auth/second-factor/reauth/password", body: { password: "hunter2-password" } },
    { method: "DELETE", url: `/me/sessions/${LAPTOP}`, body: { reason: "sign_out" } },
  ]);
});

test("Can't verify? for every other device offers Sign them out now with your password, which sends revoke-others sign_out", async () => {
  useAuthStore.setState({ user: { id: "user-1", email: "owner@example.com" } } as never);
  const calls = stubApi(twoDevices, {
    "POST /me/sessions/revoke-others": [STEP_UP(), () => ({ revoked: 2, cascade: "none" })],
  });
  renderSection();

  fireEvent.click(await screen.findByRole("button", { name: "Sign out of all other devices" }));
  await confirmLost(await screen.findByTestId("sign-out-device-dialog"));
  const lost = await openCantVerify();
  fireEvent.click(within(lost).getByRole("button", { name: "Sign them out now with your password" }));

  await dialogGone();
  assert.deepEqual(writes(calls), [
    { method: "POST", url: "/me/sessions/revoke-others", body: { reason: "lost_device" } },
    { method: "POST", url: "/me/sessions/revoke-others", body: { reason: "sign_out" } },
  ]);
});

test("without a password, Can't verify? offers Set a password by email (the forgot-password email), not signing out with a password", async () => {
  useAuthStore.setState({ user: { id: "user-1", email: "owner@example.com" } } as never);
  const calls = stubApi(twoDevices, {
    [`DELETE /me/sessions/${LAPTOP}`]: [STEP_UP()],
    "POST /auth/forgot-password": [() => ({ ok: true })],
  });
  renderSection(false);

  await confirmLost(await openRowSignOut(LAPTOP));
  const lost = await openCantVerify();
  assert.equal(within(lost).queryByRole("button", { name: "Sign it out now with your password" }) === null, true);
  assert.match(within(lost).getByTestId("step-up-password-email-body").textContent ?? "", /^Your account has no password yet\. Setting one by email signs out every device right away/);
  await clickWhenEnabled(within(lost).getByRole("button", { name: "Set a password by email" }));

  await screen.findByRole("dialog", { name: "Check your email" });
  assert.deepEqual(writes(calls).at(-1), { method: "POST", url: "/auth/forgot-password", body: { email: "owner@example.com" } });
});

test("a sign-in already gone closes the dialog and refreshes the list without an error", async () => {
  let gone = false;
  const calls = stubApi(() => (gone
    ? { sessions: [session(CURRENT, "browser", true), session(LAPTOP, "desktop_app", false, LAPTOP_REACH)], othersLostDeviceReach: NO_REACH }
    : twoDevices()), {
    [`DELETE /me/sessions/${PHONE}`]: [() => {
      gone = true;
      throw httpError(404, { error: "That sign-in was not found.", code: "session_not_found" });
    }],
  });
  renderSection();

  await confirm(await openRowSignOut(PHONE));
  await dialogGone();
  await waitFor(() => assert.equal(screen.queryByTestId(`signed-in-device-${PHONE}`) === null, true));
  assert.equal(screen.queryByText(/not found/i) === null, true);
  assert.equal(calls.filter((call) => call.url === "/me/sessions").length, 2);
});

test("Sign out of all other devices: Sign out sends sign_out; I no longer have one of them sends lost_device with the others' count", async () => {
  const calls = stubApi(twoDevices, { "POST /me/sessions/revoke-others": [() => ({ revoked: 2, cascade: "none" }), () => ({ revoked: 0, cascade: "done" })] });
  renderSection();

  fireEvent.click(await screen.findByRole("button", { name: "Sign out of all other devices" }));
  let dialog = await screen.findByTestId("sign-out-device-dialog");
  assert.ok(screen.getByRole("dialog", { name: "Sign out of all other devices" }));
  await confirm(dialog);
  await dialogGone();

  fireEvent.click(await screen.findByRole("button", { name: "Sign out of all other devices" }));
  dialog = await screen.findByTestId("sign-out-device-dialog");
  assert.equal(
    within(dialog).getByTestId("sign-out-device-lost-reach").textContent,
    "Also disconnects 3 computers and 1 agent key approved from any device but this one.",
  );
  fireEvent.click(within(dialog).getAllByRole("radio")[1]!);
  await waitFor(() => assert.equal(within(dialog).getByTestId("sign-out-device-confirm").textContent, "Sign out and disconnect"));
  await confirm(dialog);
  await dialogGone();

  assert.deepEqual(writes(calls), [
    { method: "POST", url: "/me/sessions/revoke-others", body: { reason: "sign_out" } },
    { method: "POST", url: "/me/sessions/revoke-others", body: { reason: "lost_device" } },
  ]);
});

test("a failure other than a refusal stays in the dialog", async () => {
  stubApi(twoDevices, { [`DELETE /me/sessions/${PHONE}`]: [fail(httpError(500, { error: "boom" }))] });
  renderSection();

  const dialog = await openRowSignOut(PHONE);
  await confirm(dialog);
  assert.ok(await within(dialog).findByText("Couldn't sign out. Try again."));
  assert.equal(within(dialog).queryByText("boom") === null, true);
});

test("no other sign-in listed, but earlier signed-out ones still have things working: one red question that only disconnects them", async () => {
  const calls = stubApi(() => ({ sessions: [session(CURRENT, "browser", true)], othersLostDeviceReach: { computers: 1, agentKeys: 2 } }), {
    "POST /me/sessions/revoke-others": [() => ({ revoked: 0, cascade: "done" })],
  });
  renderSection();

  assert.equal(screen.queryByRole("button", { name: "Sign out of all other devices" }) === null, true);
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect what signed-out devices approved" }));
  const dialog = await screen.findByTestId("sign-out-device-dialog");
  assert.ok(screen.getByRole("dialog", { name: "Disconnect what signed-out devices approved?" }));
  assert.equal(within(dialog).queryAllByRole("radio").length, 0);
  assert.equal(
    within(dialog).getByTestId("sign-out-device-lost-reach").textContent,
    "Disconnects 1 computer and 2 agent keys that devices you signed out earlier approved.",
  );
  const commit = within(dialog).getByTestId("sign-out-device-confirm");
  assert.equal(commit.textContent, "Disconnect");
  await confirm(dialog);

  await dialogGone();
  assert.deepEqual(writes(calls), [{ method: "POST", url: "/me/sessions/revoke-others", body: { reason: "lost_device" } }]);
});
