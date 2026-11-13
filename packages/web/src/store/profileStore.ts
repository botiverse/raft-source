import { create } from "zustand";
import type { ExternalMessageAuthorProjection } from "@botiverse/raft-shared";

export type ProfileType = "agent" | "human" | "computer" | "external";

interface ProfileState {
  /** Type of profile currently open */
  profileType: ProfileType | null;
  /** ID of the entity whose profile is open */
  profileId: string | null;
  /** The channel a person's profile was opened from: its profile names their
   *  servers in that channel (`?channelId=`, #wg-rbac:#58). Null when opened
   *  from no channel (a Computer's owner, the URL alone). */
  profileChannelId: string | null;
  /** Frozen attribution payload for an external-message identity detail. */
  externalProfile: ExternalMessageAuthorProjection | null;
  /** Channel anchor needed to restore an external identity from browser history. */
  externalProfileChannelId: string | null;
  /** Whether the current external profile was opened from a mention click
   *  (projection-id keyed) rather than a message author's avatar
   *  (message-id keyed). Drives the URL write so refresh/back restores the
   *  right shape. */
  externalProfileIsMention: boolean;
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
    type: "agent" | "human" | "computer",
    id: string,
    options?: {
      /**
       * Which agent tab the panel should land on. "ordered-first" defers to the
       * user's tab order; a literal tab id (e.g. "activity") targets that tab,
       * which is what the hover card's recent-activity heading needs.
       */
      defaultAgentTabIntent?: string;
      openSource?: "channel" | "thread";
      /** The channel (a thread's parent) the person was opened from. */
      channelId?: string | null;
    },
  ) => void;
  /** Open the standard profile panel for a provider-owned message author. */
  openExternalProfile: (
    id: string,
    profile: ExternalMessageAuthorProjection,
    options: { channelId: string; openSource?: "channel" | "thread"; isMention?: boolean },
  ) => void;
  /** Clear the one-shot agent tab intent after URL sync has consumed it */
  clearDefaultAgentTabIntent: () => void;
  /** Close the profile panel */
  closeProfile: () => void;
}

export const useProfileStore = create<ProfileState>((set) => ({
  profileType: null,
  profileId: null,
  profileChannelId: null,
  externalProfile: null,
  externalProfileChannelId: null,
  externalProfileIsMention: false,
  openedAt: 0,
  openSource: null,
  defaultAgentTabIntent: null,

  // Focus Mode stays on while a profile is open: the layout already shows the
  // channel beside the profile (isThreadMaximized), and closing the profile
  // returns to the focused thread.
  openProfile: (type, id, options) => {
    set((state) => ({
      profileType: type,
      profileId: id,
      profileChannelId: options?.channelId ?? null,
      externalProfile: null,
      externalProfileChannelId: null,
      externalProfileIsMention: false,
      openedAt: Date.now(),
      // Nested profile navigation stays in the same shell surface unless a
      // conversation entry explicitly supplies a new source.
      openSource: options?.openSource ?? state.openSource,
      defaultAgentTabIntent: type === "agent" ? options?.defaultAgentTabIntent ?? null : null,
    }));
  },

  openExternalProfile: (id, profile, options) => {
    set((state) => ({
      profileType: "external",
      profileId: id,
      profileChannelId: null,
      externalProfile: profile,
      externalProfileChannelId: options.channelId,
      externalProfileIsMention: options.isMention ?? false,
      openedAt: Date.now(),
      openSource: options?.openSource ?? state.openSource,
      defaultAgentTabIntent: null,
    }));
  },

  clearDefaultAgentTabIntent: () => {
    set({ defaultAgentTabIntent: null });
  },

  closeProfile: () => {
    set({
      profileType: null,
      profileId: null,
      profileChannelId: null,
      externalProfile: null,
      externalProfileChannelId: null,
      openSource: null,
      defaultAgentTabIntent: null,
    });
  },
}));
