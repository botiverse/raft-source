// The `message` entity of the change log (RFC 082 §4.4; 0450_change_log.sql).
//
// `message:updated` reaches only connected clients, and message sync pulls by
// sequence, so a client that was away never reads an already-seen message
// again. The paths that change a message a client already holds write one
// change_log row here, in their own transaction: a card update
// (messageCardService.ts) and a Slack-bridged inbound edit
// (externalInboundWorkerService.ts). GET /api/sync/changes rebuilds the
// message for each viewer from its current row (routes/sync.ts).
//
// Written in code, not by a trigger on `messages` (Tenny, RFC 082 v1.3): it is
// the most written table, and a trigger would run on every update (reaction
// counts, task shadows, thread ids) and log any future column's update too.
//
// Like every change row it records only which message changed: scope the
// message's channel (`parent_id` = a thread's or task conversation's parent
// channel, whose visibility it inherits, as the channel rows of 0450 do),
// entity `message`, id the message id, op `upsert`; through the log's single
// writer `public.change_log_add`.

import { sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";

/** One `message` upsert row for `messageId` in its channel's scope, in `executor`'s transaction. */
export async function logMessageChanged(executor: DatabaseExecutor, input: { messageId: string; channelId: string }): Promise<void> {
  await executor.execute(sql`
    SELECT public.change_log_add(c.server_id, 'channel', c.id, c.parent_channel_id, 'message', ${input.messageId}, 'upsert')
    FROM public.channels c
    WHERE c.id = ${input.channelId}::uuid
  `);
}
