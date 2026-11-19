import type { ReferralSourceId } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages";

/**
 * What the web shows for each "How did you hear about Raft?" option, in the display language.
 *
 * The shared list (`REFERRAL_SOURCES`) keeps its English `label` for the server side (the
 * onboarding agent's briefing); the web never shows that label, it shows these. The stored
 * answer is still the `id`. A new id in the shared list fails the type check here until it
 * has a catalog entry.
 */
export const REFERRAL_SOURCE_LABEL_ID = {
  twitter_x: "layout.onboarding.referralSource.twitterX",
  linkedin: "layout.onboarding.referralSource.linkedin",
  friend_colleague: "layout.onboarding.referralSource.friendColleague",
  search: "layout.onboarding.referralSource.search",
  hn_reddit: "layout.onboarding.referralSource.hnReddit",
  podcast_blog_newsletter: "layout.onboarding.referralSource.podcastBlogNewsletter",
  other: "layout.onboarding.referralSource.other",
} as const satisfies Record<ReferralSourceId, MessageId>;
