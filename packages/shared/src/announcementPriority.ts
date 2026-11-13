/** Higher priorities are delivered first; equal priorities keep the oldest-first queue. */
export const ANNOUNCEMENT_PRIORITY_MAX = 100;
export function parseAnnouncementPriority(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > ANNOUNCEMENT_PRIORITY_MAX) {
    throw new Error(`priority must be an integer from 0 to ${ANNOUNCEMENT_PRIORITY_MAX}`);
  }
  return value;
}
