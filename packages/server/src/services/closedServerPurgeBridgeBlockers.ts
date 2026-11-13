// Closed-server purge, the channel step's "blockers before messages" (design
// "What is cleared, and how", step 2): a channel ever bound to a bridge
// (Slack) is cleared like any other once its bridge rows are gone, which
// otherwise refuse the delete through RESTRICT keys: its bindings
// (external_channel_bindings.channel_id), the inbound events naming it
// (external_inbound_events.raft_channel_id, .committed_message_id), and on
// its messages the outbound deliveries, message links and reaction facts;
// and their own RESTRICT dependents. Only ever for a channel the purge
// clears (closedServerPurgeDelete.ts purgeChannel): a kept channel's rows are
// never reached, every scope below starts from the one channel.
//
// The rows, leaves first, each found from the channel itself, its messages,
// inbound events, deliveries, links or attachments, never from a binding id
// alone (only the channel's own bindings and their delivery partitions are
// found by binding); each table in batches of at most ROW_BATCH rows, each
// batch its own transaction, so the run's guards are checked between any two
// and a stopped run's successor resumes from what is left:
//   slack_verified_ingress_replay_audits, slack_verified_ingress_events (the
//   raw events that became the channel's inbound events; file facts by
//   cascade), external_attachment_transfer_jobs, external_card_edit_attempts,
//   external_card_edit_syncs, external_delivery_attempts,
//   external_delivery_operator_decisions, slack_attachment_fallback_plans,
//   external_reaction_facts, external_attachment_message_facts,
//   external_message_links (reaction commands and states by cascade),
//   external_outbound_deliveries with their binding's delivery partitions
//   (one partition a transaction, its deliveries with it: the partition-tail
//   trigger, clearChannelBridgeRows), external_inbound_events,
//   external_channel_bindings (audience snapshots by cascade).
// Revoked bindings too: any binding of the channel, in any state.
import { sql, type SQL } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";

type Batch = <T>(work: (tx: DatabaseExecutor) => Promise<T>) => Promise<T>;
type Add = (key: string, n: number) => void;

/** The channel's rows a bridge left, as subqueries on its id. */
function scopes(channelId: string) {
  // Text: every other table keeps its binding id as text (the ids are compared as text there).
  const bindings = sql`(SELECT id::text FROM external_channel_bindings WHERE channel_id = ${channelId})`;
  const messages = sql`(SELECT id FROM messages WHERE channel_id = ${channelId})`;
  const attachments = sql`(SELECT id FROM attachments WHERE channel_id = ${channelId} OR pending_channel_id = ${channelId})`;
  // Every scope starts from the channel or its messages (never from a binding
  // id alone), so no row naming another channel is reached.
  const inbound = sql`(SELECT id FROM external_inbound_events WHERE raft_channel_id = ${channelId} OR committed_message_id IN ${messages})`;
  const deliveries = sql`(SELECT id FROM external_outbound_deliveries WHERE source_message_id IN ${messages})`;
  const links = sql`(SELECT id FROM external_message_links WHERE raft_message_id IN ${messages} OR raft_canonical_root_message_id IN ${messages} OR delivery_id IN ${deliveries})`;
  const facts = sql`(SELECT id FROM external_attachment_message_facts WHERE inbound_event_id IN ${inbound} OR message_link_id IN ${links} OR attachment_projection_id IN ${attachments})`;
  const decisions = sql`(SELECT id FROM external_delivery_operator_decisions WHERE delivery_id IN ${deliveries})`;
  const syncs = sql`(SELECT id FROM external_card_edit_syncs WHERE delivery_id IN ${deliveries} OR source_message_id IN ${messages})`;
  const ingress = sql`(SELECT id FROM slack_verified_ingress_events WHERE materialized_inbound_event_id IN ${inbound})`;
  return { bindings, messages, attachments, inbound, deliveries, links, facts, decisions, syncs, ingress };
}

type Where = (s: ReturnType<typeof scopes>, channelId: string) => SQL;
type Delete = [table: string, where: Where];

/** In delete order (header), before the deliveries: each table, and which of its rows are the channel's. */
const BEFORE_DELIVERIES: readonly Delete[] = [
  ["slack_verified_ingress_replay_audits", (s) => sql`event_id IN ${s.ingress}`],
  ["slack_verified_ingress_events", (s) => sql`id IN ${s.ingress}`],
  ["external_attachment_transfer_jobs", (s) => sql`outbound_delivery_id IN ${s.deliveries} OR message_fact_id IN ${s.facts} OR source_attachment_id IN ${s.attachments}`],
  ["external_card_edit_attempts", (s) => sql`sync_id IN ${s.syncs} OR delivery_id IN ${s.deliveries}`],
  ["external_card_edit_syncs", (s) => sql`id IN ${s.syncs}`],
  ["external_delivery_attempts", (s) => sql`delivery_id IN ${s.deliveries} OR operator_decision_id IN ${s.decisions}`],
  ["external_delivery_operator_decisions", (s) => sql`id IN ${s.decisions}`],
  ["slack_attachment_fallback_plans", (s) => sql`delivery_id IN ${s.deliveries}`],
  ["external_reaction_facts", (s) => sql`raft_message_id IN ${s.messages} OR message_link_id IN ${s.links} OR inbound_event_id IN ${s.inbound}`],
  ["external_attachment_message_facts", (s) => sql`id IN ${s.facts}`],
  ["external_message_links", (s) => sql`id IN ${s.links}`],
];
const DELIVERIES = "external_outbound_deliveries";
const PARTITIONS = "external_delivery_partitions";
/** After the deliveries and partitions. */
const AFTER_DELIVERIES: readonly Delete[] = [
  ["external_inbound_events", (s) => sql`id IN ${s.inbound}`],
  ["external_channel_bindings", (_s, channelId) => sql`channel_id = ${channelId}`],
];

/** The tables the channel step's bridge clearing deletes from, in order (the classification's step tables). */
export const CLOSED_SERVER_PURGE_BRIDGE_TABLES: readonly string[] = [
  ...BEFORE_DELIVERIES.map(([table]) => table), DELIVERIES, PARTITIONS, ...AFTER_DELIVERIES.map(([table]) => table),
];

const deletedCount = (result: unknown) => (result as { rows: unknown[] }).rows.length;

/** Whether the channel has a bridge row the clearing would delete (its bindings or inbound events; the rest hang on those or on its messages). */
export async function channelHasBridgeRows(tx: DatabaseExecutor, channelId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT EXISTS (SELECT 1 FROM external_channel_bindings WHERE channel_id = ${channelId})
        OR EXISTS (SELECT 1 FROM external_inbound_events WHERE raft_channel_id = ${channelId}) AS bridged`)) as unknown as { rows: Array<{ bridged: boolean }> };
  return Boolean(rows.rows[0]?.bridged);
}

export interface ClearChannelBridgeRowsOptions {
  /** Rows a batch deletes from one table (the row steps' ROW_BATCH; smaller in tests). */
  size: number;
  /** The run's own stop rules besides the batch's (its message cap); throws to stop, before every batch. */
  beforeBatch?: () => void;
}

/**
 * Delete one cleared channel's bridge rows, leaves first, each table in
 * batches of at most `size` rows (located through ctid, so the LIMIT applies
 * to the delete) until a batch finds fewer; every batch is its own `batch`
 * transaction, so the run's guards are checked between any two. Stopped
 * anywhere, a later run starts again from the first table and finds less:
 * every committed batch left the rows in a state the next table's scope
 * still reaches (a table is only begun once the ones before it are empty).
 */
export async function clearChannelBridgeRows(channelId: string, batch: Batch, add: Add, options: ClearChannelBridgeRowsOptions): Promise<void> {
  const s = scopes(channelId);
  const { size } = options;
  const clear = async ([table, where]: Delete) => {
    for (;;) {
      options.beforeBatch?.();
      const id = sql.identifier(table);
      const n = await batch(async (tx) => deletedCount(await tx.execute(sql`
        DELETE FROM ${id} WHERE ctid = ANY(ARRAY(
          SELECT t.ctid FROM ${id} t WHERE ${where(s, channelId)} LIMIT ${size}))
        RETURNING 1`)));
      if (n > 0) add(`bridge_${table}_deleted`, n);
      if (n < size) return;
    }
  };
  for (const entry of BEFORE_DELIVERIES) await clear(entry);

  // Deliveries with their partitions, one partition (binding epoch) a
  // transaction: the deferred partition-tail trigger (drizzle/0251) checks at
  // commit that a partition still there holds exactly the deliveries 1..tail,
  // and has nothing to check for a deleted one; a partition can't go before
  // its last delivery (RESTRICT). So a partition's deliveries and the
  // partition are deleted together. Not in ROW_BATCH slices: a slice would
  // have to lower the partition's tail, and the trigger then recounts the
  // partition's remaining deliveries for every deleted row at commit
  // (batch x partition size per batch), which outgrows statement_timeout on
  // exactly the large partitions batching is for. Each delivery is found from
  // the channel's messages; the partition only when its binding is the
  // channel's own. As before: a delivery of another channel's message left in
  // the partition refuses the partition's delete (23503: the channel is left,
  // counted `fk`), and a channel's delivery in another binding's partition
  // fails the trigger (the server's own error, backed off).
  for (;;) {
    options.beforeBatch?.();
    const counts = await batch(async (tx) => {
      const [next] = ((await tx.execute(sql`
        SELECT binding_id, binding_epoch FROM external_outbound_deliveries WHERE id IN ${s.deliveries} LIMIT 1`)) as unknown as {
        rows: Array<{ binding_id: string; binding_epoch: number }>;
      }).rows;
      if (!next) {
        // The deliveries are gone: the channel's bindings' partitions left (empty ones, or epochs that had none).
        const partitions = deletedCount(await tx.execute(sql`
          DELETE FROM external_delivery_partitions WHERE ctid = ANY(ARRAY(
            SELECT t.ctid FROM external_delivery_partitions t WHERE binding_id IN ${s.bindings} LIMIT ${size}))
          RETURNING 1`));
        return { deliveries: 0, partitions, more: partitions === size };
      }
      const deliveries = deletedCount(await tx.execute(sql`
        DELETE FROM external_outbound_deliveries
         WHERE id IN ${s.deliveries} AND binding_id = ${next.binding_id} AND binding_epoch = ${next.binding_epoch}
        RETURNING 1`));
      const partitions = deletedCount(await tx.execute(sql`
        DELETE FROM external_delivery_partitions
         WHERE binding_id = ${next.binding_id} AND binding_epoch = ${next.binding_epoch} AND binding_id IN ${s.bindings}
        RETURNING 1`));
      return { deliveries, partitions, more: true };
    });
    if (counts.deliveries > 0) add(`bridge_${DELIVERIES}_deleted`, counts.deliveries);
    if (counts.partitions > 0) add(`bridge_${PARTITIONS}_deleted`, counts.partitions);
    if (!counts.more) break;
  }
  for (const entry of AFTER_DELIVERIES) await clear(entry);
}
