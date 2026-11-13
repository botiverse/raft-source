import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { dbTest } from "../test/integration/dbTest";
import { AGENT_INBOX_SKIP_RECORD_GRACE_MS } from "./agentInboxLateRows";
import { PREPARED_SYSTEM_MESSAGE_MAX_AGE_MS, persistPreparedSystemMessage, prepareSystemMessageForOrderedDelivery } from "./messageService";

// A reserved seq must be followed promptly by its row (agentInboxLateRows.ts:
// skip records are deleted after AGENT_INBOX_SKIP_RECORD_GRACE_MS).
dbTest("a prepared system message older than the reservation cap is refused; a replay of a persisted one is not", async ({ seed }) => {
  assert.ok(PREPARED_SYSTEM_MESSAGE_MAX_AGE_MS < AGENT_INBOX_SKIP_RECORD_GRACE_MS);
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });

  const stale = await prepareSystemMessageForOrderedDelivery(channel.id, "too late", randomUUID());
  stale.createdAt = new Date(Date.now() - PREPARED_SYSTEM_MESSAGE_MAX_AGE_MS - 1_000);
  await assert.rejects(persistPreparedSystemMessage(stale), /reservation expired/);

  const fresh = await prepareSystemMessageForOrderedDelivery(channel.id, "on time", randomUUID());
  const first = await persistPreparedSystemMessage(fresh);
  assert.equal(first.replayed, false);
  // The same event replayed later finds its row.
  const replay = await persistPreparedSystemMessage({ ...fresh, createdAt: new Date(Date.now() - PREPARED_SYSTEM_MESSAGE_MAX_AGE_MS - 1_000) });
  assert.equal(replay.message.id, first.message.id);
});
