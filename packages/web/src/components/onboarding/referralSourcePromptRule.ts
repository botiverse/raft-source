import { create } from "zustand";
import type { ReferralSourceId, ServerRole } from "@botiverse/raft-shared";
import type { User } from "../../store/authStore";
import { shouldSuppressAnnouncements } from "../../store/onboardingAnnouncementGateStore";
import type { OnboardingAnnouncementGateState } from "../../store/onboardingAnnouncementGateStore";

/**
 * "How did you hear about Raft?" for everyone (flag referral_source_prompt_v0).
 *
 * The owner setup survey (ServerSetupSurveyStep) is the only other place the
 * question is asked, and only an owner who finishes their own server's setup
 * reaches it. Someone who joins another person's server (invite, join link,
 * request access) never did. This is the rule for the card that asks them
 * (ReferralSourcePrompt), kept free of React so it can be tested as a table.
 */

/** Accounts older than this are long-standing users and are never asked. */
export const REFERRAL_SOURCE_PROMPT_ACCOUNT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** The server caps the free text at 200 (PATCH /api/auth/me slices to it). */
export const REFERRAL_SOURCE_OTHER_MAX_LENGTH = 200;

export interface ReferralSourcePromptFacts {
  /** referral_source_prompt_v0 for the current server; anything but a resolved "on" is false. */
  flagEnabled: boolean;
  /** The signed-in person as the SERVER last answered (the auth store's user), or null. */
  user: Pick<User, "id" | "referralSource" | "referralSourceSkippedAt" | "profileSetupCompletedAt"> | null;
  /** The person's role in the server on screen; null = not in a server. */
  serverRole: ServerRole | null;
  /**
   * What the owner setup gate last said about this server
   * (onboardingAnnouncementGateStore). Only "ready" means no setup step, survey
   * or handoff is owed or still being looked up.
   */
  setupGate: OnboardingAnnouncementGateState;
  /**
   * A setup step was on screen for this server in this page's life (the store's
   * sawOnboardingServerIds). The gate reads "ready" for a moment between a
   * finished setup step and the server's answer that the survey is owed (it
   * closes the step before it asks), and an owner who has just been through
   * setup has had the question anyway. Read with `setupGate` through
   * shouldSuppressAnnouncements, the one rule announcements also wait on.
   */
  sawOnboardingThisSession: boolean;
  /** The new-account display style dialog is still owed (it takes the same slot first). */
  displayStylePending: boolean;
  /** An announcement is waiting for this server: one prompt at a time, and it goes first. */
  announcementPending: boolean;
  /**
   * A Settings page of the server. The setup gate stays down there (it is the
   * setup flow's way out) while still reporting "ready"/"blocked", and Settings
   * is where a person went to do something else.
   */
  settingsPage: boolean;
  /** The document is inside a client WebView (embed.ts): the mobile app's Marketplace, Billing, Administration, Artifact pages. */
  embedded: boolean;
  /** The agent Activity page, which the mobile app shows as tab content. */
  agentActivityPage: boolean;
  /** The id of the person who closed the card with Escape or × in this page's life. */
  dismissedForUserId: string | null;
  nowMs: number;
}

/**
 * Account age comes from `profileSetupCompletedAt`: the user payload carries no
 * `createdAt`, and this stamp is written when the account is created (or, for a
 * sign-up that picks its handle afterwards, when it finishes doing so minutes
 * later). Accounts from before it existed were all stamped by migration 0170,
 * long ago. Missing or unreadable = not a new account, so not asked.
 */
function isNewAccount(profileSetupCompletedAt: string | null | undefined, nowMs: number): boolean {
  if (!profileSetupCompletedAt) return false;
  const completedMs = Date.parse(profileSetupCompletedAt);
  if (Number.isNaN(completedMs)) return false;
  return nowMs - completedMs <= REFERRAL_SOURCE_PROMPT_ACCOUNT_AGE_MS;
}

export function shouldShowReferralSourcePrompt(facts: ReferralSourcePromptFacts): boolean {
  const { user } = facts;
  if (!facts.flagEnabled || !user) return false;
  // Answered or skipped, on any device: both live on the user record.
  if (user.referralSource !== null || user.referralSourceSkippedAt !== null) return false;
  if (!isNewAccount(user.profileSetupCompletedAt, facts.nowMs)) return false;
  // Only inside a server the person belongs to. A Guest sees one channel of
  // someone else's server; they are not asked there.
  if (facts.serverRole === null || facts.serverRole === "guest") return false;
  if (shouldSuppressAnnouncements(facts.setupGate, facts.sawOnboardingThisSession)) return false;
  if (facts.displayStylePending || facts.announcementPending) return false;
  if (facts.settingsPage || facts.embedded || facts.agentActivityPage) return false;
  return facts.dismissedForUserId !== user.id;
}

/** What Submit sends through `updateProfile` (PATCH /api/auth/me). */
export function referralSourceAnswerFields(
  source: ReferralSourceId,
  other: string,
): { referralSource: ReferralSourceId; referralSourceOther?: string } {
  const trimmed = other.trim().slice(0, REFERRAL_SOURCE_OTHER_MAX_LENGTH);
  // The server refuses `referralSourceOther` without a source and drops it for
  // any source but "other"; an empty one is left out so it stores null.
  return source === "other" && trimmed
    ? { referralSource: source, referralSourceOther: trimmed }
    : { referralSource: source };
}

/** What Skip sends: the same PATCH stamps `referral_source_skipped_at`. */
export const REFERRAL_SOURCE_SKIP_FIELDS = { referralSourceSkipped: true } as const;

/**
 * "Not now" (Escape or ×) is remembered for this page's life only: in memory,
 * keyed by person so a second account signing in on the same tab is still
 * asked. Nothing is written to the device or the server, so a reload or
 * another device asks again.
 */
export const useReferralSourcePromptSession = create<{
  dismissedForUserId: string | null;
  dismiss: (userId: string) => void;
}>((set) => ({
  dismissedForUserId: null,
  dismiss: (userId) => set({ dismissedForUserId: userId }),
}));
