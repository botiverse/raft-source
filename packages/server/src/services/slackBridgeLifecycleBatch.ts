import { setImmediate } from "node:timers/promises";

export const SLACK_BRIDGE_LIFECYCLE_BATCH_SIZE = 1_000;

/** Awaiting resolved promises alone never lets timers or socket callbacks run. */
export async function mapSlackBridgeLifecycleBatches<T, U>(
  rows: readonly T[],
  project: (row: T) => U,
): Promise<U[]> {
  const result: U[] = [];
  for (let start = 0; start < rows.length; start += SLACK_BRIDGE_LIFECYCLE_BATCH_SIZE) {
    if (start > 0) await setImmediate();
    const end = Math.min(start + SLACK_BRIDGE_LIFECYCLE_BATCH_SIZE, rows.length);
    for (let index = start; index < end; index += 1) result.push(project(rows[index]!));
  }
  return result;
}
