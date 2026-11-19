import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ReferralSourcePrompt } from "../src/components/onboarding/ReferralSourcePrompt";
import { useReferralSourcePromptSession } from "../src/components/onboarding/referralSourcePromptRule";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import { useOnboardingAnnouncementGateStore } from "../src/store/onboardingAnnouncementGateStore";
import {
  REFERRAL_SOURCE_PROMPT_FEATURE_FLAG_KEY,
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";

// The card's wiring: what Submit, Skip and Escape send (or do not send) through
// the auth store's updateProfile, and that the user record alone takes it down.
// The show/hide rule itself is referralSourcePromptRule.test.ts.

const originalAuthState = useAuthStore.getState();
const originalServerState = useServerStore.getState();

const SERVER: Server = {
  id: "server-1",
  name: "Launch Lab",
  avatarUrl: null,
  slug: "launch-lab",
  ownerId: "someone-else",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "starter",
  planDowngradedAt: null,
  role: "member",
  createdAt: "2026-07-10T00:00:00.000Z",
};

function newUser(): User {
  return {
    id: "user-1",
    email: "nova@example.com",
    name: "nova",
    displayName: null,
    description: null,
    avatarUrl: null,
    emailVerified: true,
    // Just created: the rule reads the account's age from this stamp.
    profileSetupCompletedAt: new Date().toISOString(),
    preferredLanguage: null,
    displayLanguage: null,
    preferredTimezone: null,
    autoTranslationEnabled: false,
    preferredTranslationMode: "manual",
    preferredTranslationDisplay: "translated",
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
  };
}

type ProfileFields = Parameters<ReturnType<typeof useAuthStore.getState>["updateProfile"]>[0];

/** Stands in for PATCH /api/auth/me: records the fields and answers as the server would. */
function arrange(options: { flag?: boolean; failing?: boolean; hold?: Promise<void> } = {}) {
  const calls: ProfileFields[] = [];
  const updateProfile = async (fields: ProfileFields) => {
    calls.push(fields);
    await options.hold;
    if (options.failing) throw new Error("offline");
    const user = useAuthStore.getState().user!;
    useAuthStore.setState({
      user: {
        ...user,
        referralSource: fields.referralSource ?? user.referralSource,
        referralSourceOther: fields.referralSourceOther ?? null,
        referralSourceSkippedAt: fields.referralSourceSkipped ? new Date().toISOString() : null,
      },
    });
  };
  useAuthStore.setState({ user: newUser(), updateProfile } as never);
  useServerStore.setState({ servers: [SERVER], current: SERVER } as never);
  useOnboardingAnnouncementGateStore.getState().setForServer(SERVER.id, "ready");
  setServerFeatureFlagForTests(SERVER.id, REFERRAL_SOURCE_PROMPT_FEATURE_FLAG_KEY, options.flag ?? true);
  render(
    <MemoryRouter initialEntries={[`/s/${SERVER.slug}`]}>
      <LocaleProvider>
        <IntlProviderWrapper>
          <ReferralSourcePrompt />
        </IntlProviderWrapper>
      </LocaleProvider>
    </MemoryRouter>,
  );
  return calls;
}

function promptShown(): boolean {
  return screen.queryByTestId("referral-source-prompt") !== null;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetServerFeatureFlagsForTests();
  useOnboardingAnnouncementGateStore.getState().reset();
  useReferralSourcePromptSession.setState({ dismissedForUserId: null });
  useAuthStore.setState(originalAuthState, true);
  useServerStore.setState(originalServerState, true);
});

test("with the flag off nothing is asked", async () => {
  const calls = arrange({ flag: false });
  // Let the catalogs load, so "not shown" is not just "not rendered yet".
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.ok(!promptShown(), "no card while referral_source_prompt_v0 is off");
  assert.deepEqual(calls, []);
});

test("Submit saves the chosen source through updateProfile, and the answer takes the card down", async () => {
  const calls = arrange();
  const submit = await screen.findByTestId("referral-source-prompt-submit");
  assert.ok(submit.hasAttribute("disabled"), "nothing to submit before a choice");

  fireEvent.click(screen.getByTestId("referral-source-prompt-option-other"));
  fireEvent.change(await screen.findByTestId("referral-source-prompt-other"), { target: { value: " Vancouver meetup " } });
  fireEvent.click(screen.getByTestId("referral-source-prompt-submit"));

  await waitFor(() => assert.ok(!promptShown(), "the card leaves once the user record has an answer"));
  assert.deepEqual(calls, [{ referralSource: "other", referralSourceOther: "Vancouver meetup" }]);
  assert.equal(useReferralSourcePromptSession.getState().dismissedForUserId, null);
});

test("Skip records the skip and sends no answer", async () => {
  const calls = arrange();
  fireEvent.click(await screen.findByTestId("referral-source-prompt-option-search"));
  fireEvent.click(screen.getByTestId("referral-source-prompt-skip"));

  await waitFor(() => assert.ok(!promptShown(), "the card leaves once the skip is on the user record"));
  assert.deepEqual(calls, [{ referralSourceSkipped: true }]);
  assert.ok(useAuthStore.getState().user?.referralSourceSkippedAt, "skip stamped");
});

test("Escape closes it for this session and writes nothing", async () => {
  const calls = arrange();
  const card = await screen.findByTestId("referral-source-prompt");
  fireEvent.keyDown(card, { key: "Escape" });

  await waitFor(() => assert.ok(!promptShown(), "closed"));
  assert.deepEqual(calls, []);
  assert.equal(useAuthStore.getState().user?.referralSourceSkippedAt, null);
  assert.equal(useReferralSourcePromptSession.getState().dismissedForUserId, "user-1");
});

test("the close button is the same not-now, and a failed save keeps the card up", async () => {
  const calls = arrange({ failing: true });
  fireEvent.click(await screen.findByTestId("referral-source-prompt-skip"));
  await screen.findByText("Couldn't save your answers. Try again.");
  assert.ok(promptShown(), "a skip that did not land is not treated as recorded");
  assert.deepEqual(calls, [{ referralSourceSkipped: true }]);

  // Changing the choice is a new attempt: the old failure no longer shows.
  fireEvent.click(screen.getByTestId("referral-source-prompt-option-linkedin"));
  await waitFor(() => assert.ok(screen.queryByText("Couldn't save your answers. Try again.") === null, "failure cleared"));

  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  await waitFor(() => assert.ok(!promptShown(), "closed"));
  assert.equal(calls.length, 1);
});

test("while a skip is being saved, Submit keeps its own label and both buttons wait", async () => {
  let release = () => {};
  const hold = new Promise<void>((resolve) => { release = resolve; });
  arrange({ hold });
  fireEvent.click(await screen.findByTestId("referral-source-prompt-option-search"));
  fireEvent.click(screen.getByTestId("referral-source-prompt-skip"));

  const submit = screen.getByTestId("referral-source-prompt-submit");
  await waitFor(() => assert.ok(submit.hasAttribute("disabled"), "Submit waits for the skip"));
  assert.equal(submit.textContent, "Submit");
  assert.ok(screen.getByTestId("referral-source-prompt-skip").hasAttribute("disabled"), "no second skip");

  release();
  await waitFor(() => assert.ok(!promptShown(), "closed once the skip landed"));
});

test("it is a labelled region with a polite announcement, not a dialog", async () => {
  arrange();
  const card = await screen.findByTestId("referral-source-prompt");
  assert.equal(card.tagName, "ASIDE");
  assert.ok(card.getAttribute("role") !== "dialog", "a dialog that never takes focus is announced to nobody");
  const title = document.getElementById(card.getAttribute("aria-labelledby") ?? "");
  assert.equal(title?.textContent, "How did you hear about Raft?");
  const live = screen.getByTestId("referral-source-prompt-live");
  assert.equal(live.getAttribute("aria-live"), "polite");
  assert.equal(live.textContent, "How did you hear about Raft?");

  fireEvent.keyDown(card, { key: "Escape" });
  await waitFor(() => assert.equal(screen.getByTestId("referral-source-prompt-live").textContent, ""));
});
