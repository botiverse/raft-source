import { create } from "zustand";

interface ProfileState {
  /** Type of profile currently open */
  profileType: "agent" | "human" | null;
  /** ID of the entity whose profile is open */
  profileId: string | null;
  /** Timestamp when the profile was last opened, used to decide view-stack ordering */
  openedAt: number;
  /** Surface that opened the overlay, used only for reversible shell layout. */
  openSource: "channel" | "thread" | null;
  /** One-shot open intent for agent profile tabs. URL sync consumes this into agentTab. */
  /**
   * Which agent tab the panel should land on: "ordered-first" defers to the
   * user's tab order, and any other value is a specific tab id requested by
   * the opener. Consumed once by `rightPanelUrlSync` and then cleared.
   */
  defaultAgentTabIntent: string | null;

  /** Open a profile panel */
  openProfile: (
    type: "agent" | "human",
    id: string,
    options?: {
      /**
       * Which agent tab the panel should land on. "ordered-first" defers to the
       * user's tab order; a literal tab id (e.g. "activity") targets that tab,
       * which is what the hover card's recent-activity heading needs.
       */
      defaultAgentTabIntent?: string;
      openSource?: "channel" | "thread";
    },
  ) => void;
  /** Clear the one-shot agent tab intent after URL sync has consumed it */
  clearDefaultAgentTabIntent: () => void;
  /** Close the profile panel */
  closeProfile: () => void;
}

export const useProfileStore = create<ProfileState>((set) => ({
  profileType: null,
  profileId: null,
  openedAt: 0,
  openSource: null,
  defaultAgentTabIntent: null,

  openProfile: (type, id, options) => {
    set((state) => ({
      profileType: type,
      profileId: id,
      openedAt: Date.now(),
      // Nested profile navigation stays in the same shell surface unless a
      // conversation entry explicitly supplies a new source.
      openSource: options?.openSource ?? state.openSource,
      defaultAgentTabIntent: type === "agent" ? options?.defaultAgentTabIntent ?? null : null,
    }));
  },

  clearDefaultAgentTabIntent: () => {
    set({ defaultAgentTabIntent: null });
  },

  closeProfile: () => {
    set({ profileType: null, profileId: null, openSource: null, defaultAgentTabIntent: null });
  },
}));
