import { sql, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { DatabaseExecutor } from "../db/index";
import { attachments, attachmentTransferIntents, attachmentUploadReservations, attachmentUploadSessions, channels, jointChannels, jointChannelServers, messages, tasks } from "../db/schema";
import { CONVERSION_RESOURCE_DESCRIPTORS, type ConversionProgress, type ConversionResourceDescriptor, type ConversionResourceScope } from "./channelConversionContracts";
import { recordConversionPhaseCommit } from "./channelConversionFenceService";
import { stableStringify, type ChannelConversionJob } from "./channelConversionPhaseContext";

export const CHANNEL_CONVERSION_BATCH_SIZE = 128;
const CONVERSION_RESOURCE_TABLES = {
  messages, tasks, attachments, upload_sessions: attachmentUploadSessions,
  upload_reservations: attachmentUploadReservations, transfer_intents: attachmentTransferIntents,
};
async function moveResourceBatch(
  tx: DatabaseExecutor, job: ChannelConversionJob, mapping: SQL,
  descriptor: ConversionResourceDescriptor, progress: ConversionProgress, scope: ConversionResourceScope,
): Promise<boolean> {
  const { family, pendingChannel } = descriptor;
  const table = CONVERSION_RESOURCE_TABLES[family];
  const key = `moved${scope === "parent" ? "Parent" : "Thread"}${descriptor.label}`;
  const state = (progress.resources[scope] ??= {})[family] ?? { moved: 0, cursor: null, checksum: null };
  const cursor = state.cursor;
  const result = await tx.execute(sql`
    WITH mapping AS (${mapping}), batch AS MATERIALIZED (
      SELECT resource.id, mapping.local_id, mapping.canonical_id, to_jsonb(resource) AS before_row
      FROM ${table} resource JOIN mapping ON resource.channel_id = mapping.local_id
        ${pendingChannel ? sql`OR resource.pending_channel_id = mapping.local_id` : sql``}
      WHERE ${cursor ? sql`resource.id > ${cursor}::uuid` : sql`true`}
      ORDER BY resource.id LIMIT ${CHANNEL_CONVERSION_BATCH_SIZE}
    ), moved AS (
      UPDATE ${table} resource SET channel_id = batch.canonical_id
        ${pendingChannel ? sql`, pending_channel_id = CASE WHEN resource.pending_channel_id = batch.local_id THEN batch.canonical_id ELSE resource.pending_channel_id END` : sql``}
      FROM batch WHERE resource.id = batch.id
      RETURNING resource.id, to_jsonb(resource) AS after_row
    )
    SELECT moved.id::text, batch.before_row, moved.after_row
    FROM moved JOIN batch ON batch.id = moved.id ORDER BY moved.id
  `);
  const rows = result.rows as Array<{ id: string; before_row: Record<string, unknown>; after_row: Record<string, unknown> }>;
  // Namespace changes are intentional; every other persisted field must match.
  // messages.server_id is namespace too: its trigger re-derives it from the new
  // channel (the joint_storage server on conversion, the origin on rollback).
  const content = rows.map(row => {
    const { channel_id: _beforeChannel, pending_channel_id: _beforePending, server_id: _beforeServer, ...before } = row.before_row;
    const { channel_id: _afterChannel, pending_channel_id: _afterPending, server_id: _afterServer, ...after } = row.after_row;
    if (stableStringify(before) !== stableStringify(after)) throw new Error(`conversion changed ${key} content`);
    return before;
  });
  if (rows.length) {
    const checksum = stableStringify(content);
    await recordConversionPhaseCommit(tx, {
      jobId: job.id, conversionEpoch: job.conversionEpoch, phase: job.phase,
      batchKey: `${key}:${cursor ?? "start"}`, sourceCount: rows.length,
      targetCount: rows.length, checksumInput: checksum,
    });
    state.moved += rows.length;
    state.cursor = rows.at(-1)!.id;
    state.checksum = createHash("sha256").update(checksum).digest("hex");
  }
  progress.resources[scope]![family] = state;
  return rows.length < CHANNEL_CONVERSION_BATCH_SIZE;
}


export async function moveConversionResources(tx: DatabaseExecutor, job: ChannelConversionJob, mapping: SQL, scope: ConversionResourceScope, progress: ConversionProgress): Promise<boolean> {
  let complete = true;
  for (const descriptor of CONVERSION_RESOURCE_DESCRIPTORS) {
    const done = await moveResourceBatch(tx, job, mapping, descriptor, progress, scope);
    complete = complete && done;
  }
  return complete;
}

/** Verify exactly the families and namespace columns moved by the registry. */
export async function verifyConversionResources(tx: DatabaseExecutor, sourceScope: SQL): Promise<void> {
  for (const descriptor of CONVERSION_RESOURCE_DESCRIPTORS) {
    const table = CONVERSION_RESOURCE_TABLES[descriptor.family];
    const remaining = await tx.execute(sql`
      WITH scope AS (${sourceScope}) SELECT resource.id FROM ${table} resource
      JOIN scope ON resource.channel_id = scope.channel_id
        ${descriptor.pendingChannel ? sql`OR resource.pending_channel_id = scope.channel_id` : sql``}
      LIMIT 1
    `);
    if (remaining.rows.length) throw new Error(`source still has ${descriptor.family} resources`);
  }
}

export async function restoreConversionResources(tx: DatabaseExecutor, fromChannelId: string, toChannelId: string): Promise<void> {
  for (const descriptor of CONVERSION_RESOURCE_DESCRIPTORS) {
    const table = CONVERSION_RESOURCE_TABLES[descriptor.family];
    await tx.execute(sql`UPDATE ${table} SET channel_id = ${toChannelId}::uuid
      ${descriptor.pendingChannel ? sql`, pending_channel_id = CASE WHEN pending_channel_id = ${fromChannelId}::uuid THEN ${toChannelId}::uuid ELSE pending_channel_id END` : sql``}
      WHERE channel_id = ${fromChannelId}::uuid
      ${descriptor.pendingChannel ? sql`OR pending_channel_id = ${fromChannelId}::uuid` : sql``}`);
  }
}

/**
 * One projection mapping defines local/canonical sub-conversation scope across
 * phases: the host's thread projections (canonical thread under a message of
 * the canonical channel) and, task v2, its task conversation projections
 * (canonical task conversation of a task stored in the canonical channel). No
 * task conversation exists with task v2 off, so the second arm is empty there.
 */
export function conversionThreadMapping(serverId: string, canonicalChannelId: string): SQL {
  return sql`SELECT projection.local_channel_id AS local_id, authority.canonical_channel_id AS canonical_id
    FROM ${jointChannelServers} projection
    JOIN ${jointChannels} authority ON authority.id = projection.joint_channel_id
    JOIN ${channels} thread ON thread.id = authority.canonical_channel_id AND thread.type = 'thread'
    JOIN ${messages} parent ON parent.id = thread.parent_message_id
    WHERE projection.server_id = ${serverId} AND projection.status = 'active'
      AND projection.role = 'host' AND parent.channel_id = ${canonicalChannelId}
    UNION ALL
    SELECT projection.local_channel_id AS local_id, authority.canonical_channel_id AS canonical_id
    FROM ${jointChannelServers} projection
    JOIN ${jointChannels} authority ON authority.id = projection.joint_channel_id
    JOIN ${channels} conversation ON conversation.id = authority.canonical_channel_id AND conversation.type = 'task'
    JOIN ${tasks} task ON task.id = conversation.task_id AND task.conversation_channel_id = conversation.id
    WHERE projection.server_id = ${serverId} AND projection.status = 'active'
      AND projection.role = 'host' AND task.channel_id = ${canonicalChannelId}`;
}
