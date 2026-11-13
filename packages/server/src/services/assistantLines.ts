/**
 * RFC 077 step 2: every fixed line Raft writes to a personal assistant's owner,
 * in the owner's language (design v3.1). The owner's language: the one they
 * read messages in (`users.preferred_language`, the translation target), else
 * the one they chose for Raft's interface (`users.display_language`), else the
 * script of their own recent messages to the assistant, else English; the
 * stated part is also the assistant's `assistantOf.language`. v0 ships en and
 * zh-cn; zh-tw reads zh-cn's text until it has its own.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { messages, users } from "../db/schema";
import * as channelService from "./channelService";

export type AssistantLanguage = "en" | "zh-cn";

type Lines = {
  /** The DM's tail when more items were held back than shown: how many, and where (the busiest places first). */
  more: (n: number, where: readonly MoreWhere[]) => string;
  /** The brief's opener, before its first item. */
  morning: string;
  /** The brief when nothing is waiting (sent only when it has something else to say). */
  morningNothing: string;
  /** Asked once in a brief while Raft knows no zone for the owner. */
  askZone: string;
  /** An item the model gave no line for: who, and where. */
  fallback: (who: string | null, where: string) => string;
  /** A decision someone else made, in the brief. */
  waited: (line: string, waited: string) => string;
};

const LINES: Record<AssistantLanguage, Lines> = {
  en: {
    more: (n, where) => `${n} more${where.length ? ` (${where.map((w) => `${w.count} in ${w.place}`).join(", ")}${moreElsewhere(n, where) ? ", …" : ""})` : ""} — reply "more" to see them.`,
    morning: "Morning.",
    morningNothing: "Morning. Nothing is waiting on you.",
    askZone: "Which time zone are you in? I'm on UTC for now, for your morning brief and quiet nights.",
    fallback: (who, where) => who ? `@${who} in ${where}` : `New activity in ${where}`,
    waited: (line, waited) => `${line} (${waited})`,
  },
  "zh-cn": {
    more: (n, where) => `还有 ${n} 件${where.length ? `（${where.map((w) => `${w.place} ${w.count} 件`).join("、")}${moreElsewhere(n, where) ? "等" : ""}）` : ""}，回复"更多"查看。`,
    morning: "早上好。",
    morningNothing: "早上好。目前没有在等你处理的事。",
    askZone: "你在哪个时区？我现在按 UTC 算晨报和夜间免打扰的时间。",
    fallback: (who, where) => who ? `@${who} 在 ${where}` : `${where} 有新动态`,
    waited: (line, waited) => `${line}（${waited}）`,
  },
};

/** A place the held-back items are in (`#channel`, a thread counted in its channel, or `dm:@peer`) and how many. */
export type MoreWhere = { place: string; count: number };

const moreElsewhere = (n: number, where: readonly MoreWhere[]) => where.reduce((sum, w) => sum + w.count, 0) < n;

export function assistantLines(language: AssistantLanguage): Lines {
  return LINES[language];
}

const CJK = /[㐀-鿿豈-﫿]/g;

/** Whether a text is mostly Chinese (by its letters, not its punctuation or ids). */
export function looksChinese(text: string): boolean {
  const letters = text.replace(/[\s\p{P}\p{S}\d]/gu, "").replace(/[a-z0-9_-]{8,}/gi, "");
  if (letters.length === 0) return false;
  return (letters.match(CJK)?.length ?? 0) / letters.length >= 0.3;
}

type OwnerRef = { serverId: string; ownerUserId: string; agentId: string };

/** The owner's language as a tag (`zh-CN`, `en`, `zh-cn`), as described above; null when nothing says. */
export async function ownerLanguageTag(input: OwnerRef): Promise<string | null> {
  const [owner] = await getDb().select({ preferredLanguage: users.preferredLanguage, displayLanguage: users.displayLanguage })
    .from(users).where(eq(users.id, input.ownerUserId)).limit(1);
  const chosen = owner?.preferredLanguage || owner?.displayLanguage || null;
  if (chosen) return chosen;
  const dmId = await channelService.findHumanAgentDmChannelId(input.serverId, input.ownerUserId, input.agentId);
  if (!dmId) return null;
  const recent = await getDb().select({ content: messages.content }).from(messages)
    .where(and(eq(messages.channelId, dmId), eq(messages.senderType, "user"), eq(messages.senderId, input.ownerUserId)))
    .orderBy(desc(messages.seq))
    .limit(5);
  return recent.length > 0 && looksChinese(recent.map((m) => m.content).join(" ")) ? "zh-cn" : null;
}

/** The owner's language for the fixed lines. */
export async function ownerLanguage(input: OwnerRef): Promise<AssistantLanguage> {
  return (await ownerLanguageTag(input))?.toLowerCase().startsWith("zh") ? "zh-cn" : "en";
}

/** A language tag's English name for an instruction (`zh-CN` → "Chinese (China)"); the tag itself if unknown. */
export function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
