import { gte, lt, type SQL } from "drizzle-orm";
import { messages } from "../db/schema.js";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MESSAGE_SHORT_ID_RE = /^[0-9a-f]{8}$/i;
const UUID_SUFFIX_ZERO = "-0000-0000-0000-000000000000";

export function isMessageShortId(value: string): boolean {
  return MESSAGE_SHORT_ID_RE.test(value);
}

export function uuidShortIdRange(prefix: string): { lower: string; upper: string | null } {
  if (!isMessageShortId(prefix)) {
    throw new Error("message short id must be exactly 8 hex characters");
  }
  const lowerPrefix = prefix.toLowerCase();
  const nextPrefix = Number.parseInt(lowerPrefix, 16) + 1;
  return {
    lower: `${lowerPrefix}${UUID_SUFFIX_ZERO}`,
    upper: nextPrefix > 0xffffffff
      ? null
      : `${nextPrefix.toString(16).padStart(8, "0")}${UUID_SUFFIX_ZERO}`,
  };
}

export function messageIdShortPrefixConditions(prefix: string): SQL[] {
  const bounds = uuidShortIdRange(prefix);
  return [
    gte(messages.id, bounds.lower),
    ...(bounds.upper ? [lt(messages.id, bounds.upper)] : []),
  ];
}
