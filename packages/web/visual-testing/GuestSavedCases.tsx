import { useMemo } from "react";
import { Route, Routes } from "react-router-dom";
import MainLayout from "../src/components/layout/MainLayout";
import { useChannelStore } from "../src/store/channelStore";
import { useSavedStore } from "../src/store/savedStore";
import { useServerStore } from "../src/store/serverStore";
import fixtureData from "../../visual-testing/shared/fixtureData.json";

// A Guest's Saved list (#triage:#551): the real MainLayout as a Guest of the
// fixture server, bound to its one channel (channel-home). A Guest has no
// navigation sidebar; its Saved list opens from the rail on desktop (an entry
// after the sortable tabs, above Help and Settings) and from the server tab's
// popover on a phone. The playwright spec answers /api/servers with the guest
// role, /api/channels with the bound channel and no DMs, and
// /api/channels/saved with the shared saved fixture, or nothing for the
// `.empty` cases (react-provider.spec.ts, every `screens.guest.` case). The harness
// serves no message loads, so the channel shows its loading rows.

const slug = fixtureData.server.slug;
const GUEST_BOUND_CHANNEL_ID = "channel-home";
const CHANNEL_PATH = `/s/${slug}/channel/${GUEST_BOUND_CHANNEL_ID}`;
const SAVED_PATH = `/s/${slug}/saved`;

const GUEST_SAVED_ROUTES = {
  // Desktop: the rail in the channel (Chat selected) and on Saved (Saved selected).
  "screens.guest.rail.channel": { path: CHANNEL_PATH, empty: false },
  "screens.guest.rail.channel.dark": { path: CHANNEL_PATH, empty: false },
  "screens.guest.rail.saved": { path: SAVED_PATH, empty: false },
  "screens.guest.rail.saved.dark": { path: SAVED_PATH, empty: false },
  "screens.guest.saved.empty": { path: SAVED_PATH, empty: true },
  // Phone: the server tab's popover over the Guest's Home (its channel), and the Saved page.
  "screens.guest.phone.server-tab": { path: CHANNEL_PATH, empty: false },
  "screens.guest.phone.saved": { path: SAVED_PATH, empty: false },
  "screens.guest.phone.saved.empty": { path: SAVED_PATH, empty: true },
} as const satisfies Record<string, { path: string; empty: boolean }>;

type GuestSavedCaseId = keyof typeof GUEST_SAVED_ROUTES;

export const GUEST_SAVED_CASE_IDS = Object.keys(GUEST_SAVED_ROUTES) as GuestSavedCaseId[];

export function isGuestSavedCase(caseId: string): caseId is GuestSavedCaseId {
  return Object.prototype.hasOwnProperty.call(GUEST_SAVED_ROUTES, caseId);
}

export function guestSavedCaseRoute(caseId: GuestSavedCaseId): { path: string } {
  return { path: GUEST_SAVED_ROUTES[caseId].path };
}

function prime(caseId: GuestSavedCaseId, primeShell: () => void) {
  primeShell();
  // The shared navigation stores, as a Guest: the fixture server's role, its one channel, no DMs.
  useServerStore.setState((store) => ({
    current: store.current ? { ...store.current, role: "guest" as const } : store.current,
    servers: store.servers.map((server) => (server.id === fixtureData.server.id ? { ...server, role: "guest" as const } : server)),
  }));
  useChannelStore.setState((store) => ({
    channels: store.channels.filter((channel) => channel.id === GUEST_BOUND_CHANNEL_ID),
    dmChannels: [],
  }));
  if (GUEST_SAVED_ROUTES[caseId].empty) {
    useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false, total: 0 });
  }
}

export function GuestSavedCase({ caseId, primeShell }: { caseId: GuestSavedCaseId; primeShell: () => void }) {
  useMemo(() => prime(caseId, primeShell), [caseId, primeShell]);
  if (window.location.pathname !== GUEST_SAVED_ROUTES[caseId].path) return null;
  return (
    <main className="h-dvh bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseId} className="flex h-full w-full flex-col overflow-hidden">
        <Routes>
          <Route path="/s/:serverSlug/*" element={<MainLayout />} />
        </Routes>
      </div>
    </main>
  );
}
