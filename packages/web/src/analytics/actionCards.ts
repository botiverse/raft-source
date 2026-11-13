// `action_card_shown`: the base of the action card funnel (cindyz,
// #proj-analytics:69ac4304; Nova owns the registry). The steps after it
// (open, dismiss, attempt, fail, success) are recorded by the server as
// `action_card_action` when it writes the Postgres row.
import { useEffect } from "react";
import type { RefObject } from "react";
import { isProductEventActionCardType } from "@botiverse/raft-shared";
import { trackEvent } from "./track";

/** Once per card per page load, wherever it shows (the channel and a thread can both show it). */
const shownThisPageLoad = new Set<string>();

/**
 * Records `action_card_shown` the first time half of a card is on screen while
 * this person can act on it. A card they cannot act on (done, read-only, no
 * permission) is not part of the funnel, nor is a type outside the funnel's
 * (a seat request, or one this build doesn't know), nor a person's card
 * (`personCard`: the funnel is the cards agents prepare).
 */
export function useActionCardShown(
  ref: RefObject<HTMLElement | null>,
  { messageId, actionType, actionable, personCard = false, serverId }: {
    messageId: string;
    actionType: string;
    actionable: boolean;
    /** Asked for by a person (`requesterUserId`): a member's Pro request, the agent:create card an owner sends back. */
    personCard?: boolean;
    serverId: string | undefined;
  },
): void {
  useEffect(() => {
    const node = ref.current;
    if (!node || !actionable || personCard || !serverId || !isProductEventActionCardType(actionType) || shownThisPageLoad.has(messageId)) return;
    const report = () => {
      if (shownThisPageLoad.has(messageId)) return;
      shownThisPageLoad.add(messageId);
      trackEvent("action_card_shown", { action_type: actionType }, { serverId });
    };
    if (typeof IntersectionObserver === "undefined") {
      report();
      return;
    }
    // The threshold only says when to call back (and the first call comes
    // regardless): the ratio decides.
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry || entry.intersectionRatio < 0.5) return;
      report();
      observer.disconnect();
    }, { threshold: 0.5 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, messageId, actionType, actionable, personCard, serverId]);
}

export function resetActionCardShownForTest(): void {
  shownThisPageLoad.clear();
}
