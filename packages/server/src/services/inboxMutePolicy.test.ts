import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { sql } from "drizzle-orm";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import {
  activityPromotionAllowedByMuteSql,
  isActivityPromotionSuppressedByMute,
} from "./inboxMutePolicy";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("activity mute SQL predicate matches TypeScript policy", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    const cases: Array<{
      kind: "channel" | "dm" | "thread";
      messageSeq: number;
      muteFromSeq: number | null;
      personalMention: boolean;
    }> = [
      { kind: "channel", messageSeq: 4, muteFromSeq: null, personalMention: false },
      { kind: "channel", messageSeq: 4, muteFromSeq: 5, personalMention: false },
      { kind: "channel", messageSeq: 5, muteFromSeq: 5, personalMention: false },
      { kind: "channel", messageSeq: 6, muteFromSeq: 5, personalMention: true },
      { kind: "dm", messageSeq: 6, muteFromSeq: 5, personalMention: false },
      { kind: "thread", messageSeq: 6, muteFromSeq: 5, personalMention: false },
    ];

    for (const policyCase of cases) {
      const result = await db.execute(sql`
        SELECT ${activityPromotionAllowedByMuteSql({
          kindIsThread: sql`${policyCase.kind === "thread"}::boolean`,
          messageSeq: sql`${policyCase.messageSeq}::bigint`,
          muteFromSeq: sql`${policyCase.muteFromSeq}::bigint`,
          personalMentionExists: sql`${policyCase.personalMention}::boolean`,
        })} AS allowed
      `);
      const [row] = result.rows as Array<{ allowed: boolean }>;
      assert.equal(
        row.allowed,
        !isActivityPromotionSuppressedByMute(policyCase),
        JSON.stringify(policyCase),
      );
    }
  } finally {
    await close();
  }
});
