// The reaction notices app as core knows it (first-party app mechanism §一):
// its one registration, which core's registry (apps/firstPartyApps.ts, the
// only core file that imports it) collects at startup. It owns no object and
// no table: it tells an agent of reactions to a message it sent, a message
// being core's own. Everything core does for it comes from here:
// `system.reaction-notices` and its notices' schema, kind and delivery guard,
// and the reactions core tells it of (notices.ts).
//
// Only functions core calls later, and constants from shared: nothing below
// reads another module of this app while it is loaded (core's registry is
// part of an import cycle through this file).
import { AGENT_REACTION_NOTICES_FEATURE_FLAG_KEY, REACTION_NOTICE_KIND, reactionAgentNoticeSchema } from "@botiverse/raft-shared";
import type { FirstPartyApp } from "../../platform/apps";
import { prepareReactionNotice, reactionNoticeDeliveryVerdicts } from "./notices";

export const reactionNoticesApp: FirstPartyApp = {
  id: "reaction-notices",
  flag: AGENT_REACTION_NOTICES_FEATURE_FLAG_KEY,
  // No objects of its own: a notice is about a message, core's.
  objectKinds: [],
  systemApp: "system.reaction-notices",
  agentNotice: {
    schema: reactionAgentNoticeSchema,
    kinds: [REACTION_NOTICE_KIND],
    // An agent that can no longer open the message's conversation (or whose server has the flag off) gets nothing.
    deliverable: (events) => reactionNoticeDeliveryVerdicts(events),
  },
  // Core asks it before every reaction's transaction what it would write, and runs that write inside it.
  messageReactions: { prepare: (request, context) => prepareReactionNotice(request, context) },
};
