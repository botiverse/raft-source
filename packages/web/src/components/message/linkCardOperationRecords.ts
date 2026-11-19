import { z } from "zod";
import { currentTimeMs } from "@botiverse/raft-shared";

// Local records of the link-card operations this browser started, per viewer
// and Server (localStorage, like utils/computerAttentionSeen.ts), which
// linkCardExecute.tsx recovers and follows. Bounded (50, 48 hours) and
// best-effort; the server stays the source of truth. No URL or App text is
// kept: ids, the URL's digest, and which receipt was last shown.

/** An operation's or a prepared action's id, as Raft writes them. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RECORDS_PREFIX = "slock:link-card-operations";
const RECORDS_MAX = 50;
const RECORD_TTL_MS = 48 * 3600_000;
const recordSchema = z.object({
  message_id: z.string().min(1).max(200),
  url_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  client_request_id: z.string().min(1).max(128).optional(),
  operation_id: z.string().regex(UUID).optional(),
  at: z.number(),
  toasted_revision: z.number().int().optional(),
  toasted_state: z.string().max(40).optional(),
}).refine((record) => !!record.client_request_id || !!record.operation_id);
export type LinkCardOperationRecord = z.infer<typeof recordSchema>;

const recordsKey = (viewerKey: string) => `${RECORDS_PREFIX}:${viewerKey}`;
export function readLinkCardOperationRecords(viewerKey: string): LinkCardOperationRecord[] {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(recordsKey(viewerKey)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const now = currentTimeMs();
    return parsed.flatMap((raw) => {
      const record = recordSchema.safeParse(raw);
      return record.success && now - record.data.at < RECORD_TTL_MS ? [record.data] : [];
    });
  } catch {
    return [];
  }
}
function writeRecords(viewerKey: string, records: LinkCardOperationRecord[]) {
  try {
    if (!records.length) globalThis.localStorage?.removeItem(recordsKey(viewerKey));
    else globalThis.localStorage?.setItem(recordsKey(viewerKey), JSON.stringify(records.slice(-RECORDS_MAX)));
  } catch {
    // Best effort: the server keeps the operation; this only speeds up recovery.
  }
}
type RecordMatch = { clientRequestId?: string; operationId?: string };
const matches = (record: LinkCardOperationRecord, match: RecordMatch) =>
  (!!match.clientRequestId && record.client_request_id === match.clientRequestId) || (!!match.operationId && record.operation_id === match.operationId);
export function putRecord(viewerKey: string, record: LinkCardOperationRecord) {
  const records = readLinkCardOperationRecords(viewerKey).filter((existing) => !matches(existing, { clientRequestId: record.client_request_id, operationId: record.operation_id }));
  writeRecords(viewerKey, [...records, record]);
}
export function patchRecord(viewerKey: string, match: RecordMatch, patch: Partial<LinkCardOperationRecord>) {
  writeRecords(viewerKey, readLinkCardOperationRecords(viewerKey).map((record) => (matches(record, match) ? { ...record, ...patch } : record)));
}
export function forgetRecord(viewerKey: string, match: RecordMatch) {
  const records = readLinkCardOperationRecords(viewerKey);
  const kept = records.filter((record) => !matches(record, match));
  if (kept.length !== records.length) writeRecords(viewerKey, kept);
}
export const findRecord = (viewerKey: string, match: RecordMatch) => readLinkCardOperationRecords(viewerKey).find((record) => matches(record, match));
