import { TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import { getDb } from "../../db/index";
import { featureFlagRules } from "../../db/schema";

/**
 * Turn task_v2_conversations_v0 on for one server the way Feature Flag Admin
 * does (a `server` stage allow rule); the migration seeds the flag default off.
 */
export async function enableTaskV2ConversationsForServer(serverId: string): Promise<void> {
  await getDb().insert(featureFlagRules).values({
    flagKey: TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}
