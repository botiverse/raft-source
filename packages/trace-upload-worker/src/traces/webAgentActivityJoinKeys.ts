// Receipt-side check for the two raw join keys web `slock.agent_activity.*`
// events may carry (`launch_id`, `client_seq`). They are the single approved
// exception to the web Q8 scrub (ids presence-only); the web shape-checks them
// before emitting (packages/web/src/utils/webAgentActivityTrace.ts), and this
// checks again so an old, patched or hostile client cannot pass any other
// value through under these names. A value of the wrong shape is dropped; the
// event and its `*_present` booleans are kept.
import type { LocalEventRecord } from "./otlp";

const AGENT_ACTIVITY_EVENT_PREFIX = "slock.agent_activity.";

const LAUNCH_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidLaunchId(value: unknown): boolean {
  return typeof value === "string" && LAUNCH_ID_UUID_RE.test(value);
}

function isValidClientSeq(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The record with an ill-shaped `launch_id` / `client_seq` removed (agent-activity events only). */
export function sanitizeWebAgentActivityJoinKeys(record: LocalEventRecord): LocalEventRecord {
  if (!record.name.startsWith(AGENT_ACTIVITY_EVENT_PREFIX) || !record.attrs) return record;
  const attrs = record.attrs;
  const dropLaunchId = "launch_id" in attrs && !isValidLaunchId(attrs.launch_id);
  const dropClientSeq = "client_seq" in attrs && !isValidClientSeq(attrs.client_seq);
  if (!dropLaunchId && !dropClientSeq) return record;
  const kept = { ...attrs };
  if (dropLaunchId) delete kept.launch_id;
  if (dropClientSeq) delete kept.client_seq;
  return { ...record, attrs: kept };
}
