import { create } from "zustand";

export type OnboardingAnnouncementGateState = "pending" | "blocked" | "ready";

type StoreState = {
  byServerId: Record<string, OnboardingAnnouncementGateState>;
  /**
   * Servers whose onboarding was seen IN PROGRESS at some point this browser
   * session. Membership is sticky for the session: once a server lands here it
   * keeps suppressing announcements even after its gate turns `ready`.
   *
   * This is the next-entry rule. A user who has just finished onboarding should
   * meet an announcement on their NEXT entry, not the instant the setup dialog
   * closes. The server used to enforce it by comparing the login session family
   * that first completed onboarding; that check
   * (`isEligibleAfterOnboarding`) was account-global while onboarding is
   * per-server, so it was removed and the rule moved here.
   *
   * ⚠️ The front end only knows whether the dialog is open right now — it does
   * not know that one closed a moment ago, and this memory dies on refresh.
   * That trade-off is accepted (Cindy, 2026-08-07: "前端刷新后就没的这个没问题"):
   * after a reload the user is, by definition, on a new entry.
   */
  sawOnboardingServerIds: string[];
  setForServer: (serverId: string, state: OnboardingAnnouncementGateState) => void;
  clearForServer: (serverId: string) => void;
  reset: () => void;
};

/**
 * Suppression is `gate is not ready` OR `onboarding happened here this session`.
 * Extracted so the LINKAGE is testable: the pre-existing modal test only proved
 * that passing `suppressed` hides the modal, which stays green even if nothing
 * ever computes `suppressed` from onboarding state.
 */
export function shouldSuppressAnnouncements(
  gateState: OnboardingAnnouncementGateState,
  sawOnboardingThisSession: boolean,
): boolean {
  return gateState !== "ready" || sawOnboardingThisSession;
}

export const useOnboardingAnnouncementGateStore = create<StoreState>((set) => ({
  byServerId: {},
  sawOnboardingServerIds: [],

  setForServer: (serverId, state) => set((current) => {
    const alreadySaw = current.sawOnboardingServerIds.includes(serverId);
    // Only `blocked` marks the session. `pending` means "not resolved yet",
    // which every server passes through on mount — treating it as evidence of
    // onboarding would suppress announcements for everyone, forever.
    const sawOnboardingServerIds = state === "blocked" && !alreadySaw
      ? [...current.sawOnboardingServerIds, serverId]
      : current.sawOnboardingServerIds;
    if (current.byServerId[serverId] === state && sawOnboardingServerIds === current.sawOnboardingServerIds) {
      return current;
    }
    return {
      byServerId: { ...current.byServerId, [serverId]: state },
      sawOnboardingServerIds,
    };
  }),

  // Unmount clears the live gate reading, NOT the session memory: the gate
  // component unmounts on every server switch, and forgetting there would let
  // a just-onboarded user pick up an announcement by switching away and back.
  clearForServer: (serverId) => set((current) => {
    if (!(serverId in current.byServerId)) return current;
    const next = { ...current.byServerId };
    delete next[serverId];
    return { byServerId: next };
  }),

  reset: () => set({ byServerId: {}, sawOnboardingServerIds: [] }),
}));
