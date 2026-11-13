import "./helpers/domSetup";

import assert from "node:assert/strict";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import HumanDetailPanel from "../src/components/member/HumanDetailPanel";
import type { HumanProfile } from "../src/components/member/HumanDetailPanel";
import { TestIntlProvider } from "./helpers/intl";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { resetServerFeatureFlagsForTests, setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";

// Guests in joint channels (P3, #wg-rbac:#25), the profile card. Acme hosts
// the joint channel, Bravo is connected to it. The card is what
// GET /servers/:id/members/:memberId/profile answers for each viewer:
// - a Guest of Acme opening Bravo's person: the simplified card (identity
//   only, channel_summary) with "From Bravo";
// - Bravo opening Acme's Guest: the same simplified card, "From Acme", no role
//   (the server sends none), so no Guest label;
// - Acme opening its own Guest: the full card with the Guest label.
// Each case runs with the host's external_channels_v1 on and off: the card
// reads no flag, the server decides what it may see.

const ACME = { id: "s-acme", name: "Acme", slug: "acme" };
const BRAVO = { id: "s-bravo", name: "Bravo", slug: "bravo" };

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null } as never);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState({ dmChannels: [] } as never);
  resetServerFeatureFlagsForTests();
});

/** A channel_summary profile, as toChannelScopedHumanProfile / the computed joint path build it. */
function summary(userId: string, displayName: string, from: typeof ACME, overrides: Partial<HumanProfile> = {}): HumanProfile {
  return {
    userId, serverId: from.id, serverName: from.name, serverSlug: from.slug,
    email: null, name: displayName.toLowerCase(), displayName,
    description: "Works on the launch", avatarUrl: null, role: null, joinedAt: null,
    membershipStatus: "active", createdAgents: [], profileProjection: "channel_summary",
    ...overrides,
  };
}

function seed(viewer: typeof ACME, role: "owner" | "member" | "guest", flag: boolean, members: Array<{ userId: string; role: string }> = []) {
  useAuthStore.setState({ user: { id: "viewer-1", name: "viewer" }, loading: false, initialized: true } as never);
  useServerStore.setState({
    current: { id: viewer.id, name: viewer.name, slug: viewer.slug, role },
    members: [{ userId: "viewer-1", role }, ...members],
    loading: false,
  } as never);
  resetServerFeatureFlagsForTests();
  setServerFeatureFlagForTests(viewer.id, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, flag);
}

function renderCard(human: HumanProfile) {
  return render(
    <TestIntlProvider locale="en">
      <MemoryRouter>
        <HumanDetailPanel human={human} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

/** The "From" section's text, or null when the card has none. */
function fromSection(): string | null {
  const eyebrow = screen.queryByText("From");
  return eyebrow ? eyebrow.parentElement?.textContent ?? "" : null;
}

for (const flag of [true, false]) {
  const state = `flag ${flag ? "on" : "off"}`;

  test(`${state}: a Guest of the host opens another server's person: the simplified card, from that server`, () => {
    seed(ACME, "guest", flag);
    renderCard(summary("dana", "Dana Lee", BRAVO));
    assert.equal(fromSection(), "FromBravo");
    assert.ok(screen.getAllByText("Dana Lee").length > 0);
    assert.ok(screen.getByText("Works on the launch"));
    assert.ok(screen.queryByText("Role") === null, "identity only: no role");
    assert.ok(screen.queryByText("Info") === null, "identity only: no Info section");
    assert.ok(screen.queryByRole("button", { name: /Message/ }) === null, "a Guest has no DMs");
  });

  test(`${state}: another server opens the host's Guest: from the host, with no Guest label`, () => {
    seed(BRAVO, "owner", flag);
    renderCard(summary("gus", "Gus Park", ACME));
    assert.equal(fromSection(), "FromAcme");
    assert.ok(screen.queryByText("Guest") === null);
    assert.ok(screen.queryByText(/Guest in #/) === null);
  });

  test(`${state}: another server never shows Guest for the host's person, even if a role came along`, () => {
    // Not what the server sends: the card keys the role on the viewer's own server.
    seed(BRAVO, "owner", flag);
    renderCard(summary("gus", "Gus Park", ACME, {
      role: "guest", profileProjection: undefined, guestChannel: { id: "c-launch", name: "launch" },
    }));
    assert.equal(fromSection(), "FromAcme");
    assert.ok(screen.queryByText("Guest") === null);
    assert.ok(screen.queryByText(/Guest in #/) === null);
  });

  test(`${state}: the host opens its own Guest: the Guest label and its channel`, () => {
    seed(ACME, "owner", flag, [{ userId: "gus", role: "guest" }]);
    renderCard({
      ...summary("gus", "Gus Park", ACME),
      email: "gus@contoso.com", role: "guest", joinedAt: "2026-11-01T00:00:00.000Z",
      profileProjection: undefined, guestChannel: { id: "c-launch", name: "launch" },
    });
    assert.equal(fromSection(), null, "the host's own person: no From");
    assert.ok(screen.getByText("Guest"));
    assert.ok(screen.getByText("Guest in #launch"));
  });
}
