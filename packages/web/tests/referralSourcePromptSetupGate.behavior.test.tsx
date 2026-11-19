import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import { ServerOnboardingSurfaces } from "../src/components/onboarding/ServerOnboardingSurfaces";
import { useReferralSourcePromptSession } from "../src/components/onboarding/referralSourcePromptRule";
import { useServerSetupRevision } from "../src/components/onboarding/serverSetupProjection";
import { __setEmbedModeForTests } from "../src/embed";
import { useAnnouncementStore } from "../src/store/announcementStore";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import { useMachineStore } from "../src/store/machineStore";
import { useOnboardingAnnouncementGateStore } from "../src/store/onboardingAnnouncementGateStore";
import type { OnboardingAnnouncementGateState } from "../src/store/onboardingAnnouncementGateStore";
import {
  REFERRAL_SOURCE_PROMPT_FEATURE_FLAG_KEY,
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

// The card beside the REAL owner setup gate (ServerOnboardingSurfaces, what
// MainLayout mounts), with the setup projection stubbed at the HTTP seam: the
// card must never be on screen with a setup step, the owner survey, or in the
// gap between them. The rule's own table is referralSourcePromptRule.test.ts.

const originalGet = api.get.bind(api);
const originalAuthState = useAuthStore.getState();
const originalServerState = useServerStore.getState();
let restoreEmbed: (() => void) | null = null;

const SERVER_ID = "server-1";
const SLUG = "launch-lab";

const MID_SETUP = {
  surface: "computer_runtime",
  phase: "in_progress",
  currentStep: "computer_runtime",
  blocksChat: true,
  allowedExits: ["return_to_server"],
  sideEffectState: { transitions: "enabled", completion: "disabled" },
  gateReason: "runtime_checking",
  computerStatus: "online",
  runtimeStatus: "checking",
  postSetup: { surveyPending: false, upgradePending: false, handoffPending: false },
};
const COMPLETE = {
  ...MID_SETUP,
  surface: "complete",
  phase: "complete",
  currentStep: null,
  blocksChat: false,
  gateReason: "setup_complete",
};
const SURVEY_OWED = { ...COMPLETE, postSetup: { surveyPending: true, upgradePending: false, handoffPending: true } };
// What a non-owner gets (insufficient_permission): no setup of theirs to show.
const NOT_THE_OWNER = { ...COMPLETE, surface: "none", phase: null, gateReason: "insufficient_permission" };
// An owner whose setup state could not be read (resolver_error / state_not_found).
const OWNER_RETRY = { ...NOT_THE_OWNER, surface: "retry", allowedExits: ["retry", "return_to_server"], gateReason: "resolver_error" };

function arrange(options: { role: Server["role"]; projection: Record<string, unknown>; path?: string }) {
  const user = {
    id: "user-1",
    email: "nova@example.com",
    name: "nova",
    displayName: null,
    description: null,
    avatarUrl: null,
    emailVerified: true,
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
  } satisfies User;
  const server: Server = {
    id: SERVER_ID,
    name: "Launch Lab",
    avatarUrl: null,
    slug: SLUG,
    ownerId: options.role === "owner" ? user.id : "someone-else",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "starter",
    planDowngradedAt: null,
    role: options.role,
    createdAt: "2026-07-10T00:00:00.000Z",
  };
  const state = { projection: options.projection };
  api.get = (async (url: string) => {
    if (!url.includes("/setup-projection")) return { data: [] };
    return { data: state.projection };
  }) as typeof api.get;
  useAuthStore.setState({ user, loading: false } as never);
  useServerStore.setState({ servers: [server], current: server } as never);
  setServerFeatureFlagForTests(SERVER_ID, REFERRAL_SOURCE_PROMPT_FEATURE_FLAG_KEY, true);
  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[options.path ?? `/s/${SLUG}`]}>
        <ServerOnboardingSurfaces serverId={SERVER_ID} serverSlug={SLUG} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  return state;
}

function cardShown(): boolean {
  return screen.queryByTestId("referral-source-prompt") !== null;
}

/** Waits for the gate's reading, then gives the card every chance to (wrongly) appear. */
async function gateReads(expected: OnboardingAnnouncementGateState) {
  await waitFor(() => assert.equal(useOnboardingAnnouncementGateStore.getState().byServerId[SERVER_ID], expected));
  // The card renders in the same commit as the reading; one more turn of the
  // loop also lets a lazy setup step finish mounting before "no card" is read.
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 20); }); });
}

beforeEach(() => {
  useServerSetupRevision.setState({ revision: 0 });
  useOnboardingAnnouncementGateStore.getState().reset();
});

afterEach(() => {
  api.get = originalGet as typeof api.get;
  cleanup();
  restoreEmbed?.();
  restoreEmbed = null;
  localStorage.clear();
  resetServerFeatureFlagsForTests();
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useOnboardingAnnouncementGateStore.getState().reset();
  useAnnouncementStore.getState().reset();
  useReferralSourcePromptSession.setState({ dismissedForUserId: null });
  useAuthStore.setState(originalAuthState, true);
  useServerStore.setState(originalServerState, true);
});

test("a member of someone else's server gets the card once the gate has answered", async () => {
  arrange({ role: "member", projection: NOT_THE_OWNER });
  assert.ok(!cardShown(), "not before the gate has read the projection (pending)");
  await waitFor(() => assert.ok(cardShown(), "card for the member"));
  assert.equal(screen.getByTestId("referral-source-prompt-live").textContent, "How did you hear about Raft?");
});

test("an owner in the middle of setup gets no card", async () => {
  arrange({ role: "owner", projection: MID_SETUP });
  await gateReads("blocked");
  assert.ok(!cardShown(), "no card over a setup step");
});

test("an owner who is owed the survey gets the survey, not the card", async () => {
  arrange({ role: "owner", projection: SURVEY_OWED });
  await gateReads("blocked");
  await screen.findByTestId("server-setup-survey");
  assert.ok(!cardShown(), "no card over the owner survey");
});

test("no card in the gap after a setup step closes, before the server says the survey is owed", async () => {
  // What closeCompletedSetup leaves on screen: phase complete with the previous
  // step's postSetup (nothing owed), so the gate reads ready for a moment.
  const state = arrange({ role: "owner", projection: MID_SETUP });
  await gateReads("blocked");
  state.projection = COMPLETE;
  await act(async () => { useServerSetupRevision.getState().bump(); });
  await gateReads("ready");
  assert.ok(!cardShown(), "ready right after setup is not an invitation");

  state.projection = SURVEY_OWED;
  await act(async () => { useServerSetupRevision.getState().bump(); });
  await gateReads("blocked");
  assert.ok(!cardShown(), "nor once the survey is known to be owed");
});

test("an owner whose setup state could not be read (retry, phase null) is treated as the gate treats them: nothing owed on screen, so the card may show", async () => {
  // Decided, not overlooked. On this projection the gate draws nothing, so the
  // card cannot stack on a setup step, and it reads the gate's own "ready", the
  // reading announcements follow. If a later read finds setup owed, the gate
  // turns blocked: the card leaves and stays away for the session.
  const state = arrange({ role: "owner", projection: OWNER_RETRY });
  await waitFor(() => assert.ok(cardShown(), "card while nothing of setup is on screen"));

  state.projection = MID_SETUP;
  await act(async () => { useServerSetupRevision.getState().bump(); });
  await gateReads("blocked");
  assert.ok(!cardShown(), "gone as soon as setup turns out to be owed");
});

test("no card on a Settings page, where the gate stays down but still reads ready", async () => {
  arrange({ role: "member", projection: NOT_THE_OWNER, path: `/s/${SLUG}/settings/account` });
  await gateReads("ready");
  assert.ok(!cardShown(), "no card on Settings");
});

test("no card inside the mobile app's WebView (host shell)", async () => {
  restoreEmbed = __setEmbedModeForTests({ embedded: true, shell: "host" } as never);
  arrange({ role: "member", projection: NOT_THE_OWNER });
  await gateReads("ready");
  assert.ok(!cardShown(), "no card in a client WebView");
});

test("no card while an announcement is waiting for this server", async () => {
  useAnnouncementStore.setState({ pending: [{ id: "a-1", pages: [] }] } as never);
  arrange({ role: "member", projection: NOT_THE_OWNER });
  await gateReads("ready");
  assert.ok(!cardShown(), "the announcement goes first");

  await act(async () => { useAnnouncementStore.setState({ pending: [] }); });
  await waitFor(() => assert.ok(cardShown(), "the card follows once it is read"));
});
