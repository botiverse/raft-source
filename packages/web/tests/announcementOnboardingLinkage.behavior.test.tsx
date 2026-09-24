/**
 * Onboarding ⇄ announcement exclusivity (task #4, items ② and ③).
 *
 * The pre-existing modal test only proved that PASSING `suppressed` hides the
 * modal. That stays green even if nothing ever derives `suppressed` from
 * onboarding state — so it pins the prop, not the linkage. These tests pin the
 * linkage: onboarding state → suppression decision → render.
 *
 * ⚠️ Structural reason this lives in the client at all: the front end knows
 * whether the setup dialog is open right now, but not that one closed a moment
 * ago, and that memory dies on refresh. The server cannot do it either — its
 * old check was account-global while onboarding is per-server, and
 * `GET /api/announcements/active` carries no serverId. Accepted trade-off
 * (Cindy, 2026-08-07); after a reload the user is by definition on a new entry.
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { readFileSync } from "node:fs";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import api from "../src/api/client";
import AnnouncementModal from "../src/components/AnnouncementModal";
import { useAnnouncementStore } from "../src/store/announcementStore";
import {
  shouldSuppressAnnouncements,
  useOnboardingAnnouncementGateStore,
} from "../src/store/onboardingAnnouncementGateStore";
import { TestIntlProvider } from "./helpers/intl";

const SERVER = "server-1";

const announcement = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "Product update",
  pages: [{ body: "Only page" }],
  publishedAt: "2026-07-27T00:00:00.000Z",
  startsAt: "2026-07-27T00:00:00.000Z",
  endsAt: null,
  locale: "en" as const,
};

/** Mirrors MainLayout's binding; the source pin below keeps it from drifting. */
function suppressionForServer(): boolean {
  const { byServerId, sawOnboardingServerIds } = useOnboardingAnnouncementGateStore.getState();
  return shouldSuppressAnnouncements(
    byServerId[SERVER] ?? "pending",
    sawOnboardingServerIds.includes(SERVER),
  );
}

function renderAsMainLayoutDoes() {
  const suppressed = suppressionForServer();
  return render(
    <TestIntlProvider>
      <AnnouncementModal suppressed={suppressed} />
    </TestIntlProvider>,
  );
}

afterEach(() => {
  cleanup();
  useAnnouncementStore.getState().reset();
  useOnboardingAnnouncementGateStore.getState().reset();
});

// The suppression cases assert on the DECISION, not on the modal's absence.
// Asserting absence means that when the rule regresses the modal IS mounted at
// the moment the assertion fails, and this file then dies as an opaque ~24s
// SIGKILL instead of a named failure. The prop -> render direction is already
// covered by announcementModal.behavior.test.tsx ("onboarding suppression keeps
// a pending announcement out of the takeover layer"); what is missing, and what
// these pin, is onboarding state -> decision.
test("onboarding still in progress suppresses announcements", () => {
  useOnboardingAnnouncementGateStore.getState().setForServer(SERVER, "blocked");
  assert.equal(suppressionForServer(), true);
});

test("an unresolved gate suppresses announcements rather than flashing them", () => {
  useOnboardingAnnouncementGateStore.getState().setForServer(SERVER, "pending");
  assert.equal(suppressionForServer(), true);
});

test("a settled user with no onboarding this session sees announcements", (t) => {
  t.mock.method(api, "post", async () => ({ data: {} }));
  useAnnouncementStore.setState({ pending: [announcement], loaded: true });
  useOnboardingAnnouncementGateStore.getState().setForServer(SERVER, "ready");

  renderAsMainLayoutDoes();

  assert.ok(screen.getByTestId("announcement-modal"));
});

test("finishing onboarding does NOT pop an announcement in the same session", () => {
  const gate = useOnboardingAnnouncementGateStore.getState();
  // The whole point of the next-entry rule: the gate legitimately turns ready
  // the moment setup completes, and without the session memory the announcement
  // would land the instant the setup dialog closes.
  gate.setForServer(SERVER, "blocked");
  gate.setForServer(SERVER, "ready");

  assert.equal(suppressionForServer(), true);
  assert.deepEqual(useOnboardingAnnouncementGateStore.getState().sawOnboardingServerIds, [SERVER]);
});

test("switching away and back does not launder away the next-entry rule", () => {
  const gate = useOnboardingAnnouncementGateStore.getState();
  gate.setForServer(SERVER, "blocked");
  gate.setForServer(SERVER, "ready");
  // ServerSetupProjectionGate unmounts on every server switch and clears its
  // live reading. If that also dropped the session memory, a just-onboarded
  // user could collect the announcement by switching servers and returning.
  gate.clearForServer(SERVER);
  gate.setForServer(SERVER, "ready");

  assert.equal(suppressionForServer(), true);
});

test("a server that never blocked is not marked, so other servers stay unaffected", (t) => {
  t.mock.method(api, "post", async () => ({ data: {} }));
  const gate = useOnboardingAnnouncementGateStore.getState();
  gate.setForServer("other-server", "blocked");
  gate.setForServer(SERVER, "pending");
  gate.setForServer(SERVER, "ready");

  assert.deepEqual(
    useOnboardingAnnouncementGateStore.getState().sawOnboardingServerIds,
    ["other-server"],
    "pending must not count as onboarding — every server passes through it",
  );
  assert.equal(shouldSuppressAnnouncements("ready", false), false);
});

test("MainLayout derives suppression from the shared helper, not a local comparison", (t) => {
  t.mock.method(api, "post", async () => ({ data: {} }));
  // Source pin, and named as one. The harness above mirrors MainLayout's
  // binding; without this, someone could rewrite MainLayout to
  // `suppressed={gateState !== "ready"}` — dropping the next-entry rule — and
  // every behavior test here would still pass, because they never render
  // MainLayout itself.
  const source = readFileSync(
    new URL("../src/components/layout/MainLayout.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /suppressed=\{shouldSuppressAnnouncements\(announcementGateState, sawOnboardingThisSession\)\}/,
    "MainLayout must pass both inputs through shouldSuppressAnnouncements",
  );
});
