/**
 * RFC 077 step 2: what of the owner's inbox is worth the assistant's look,
 * decided in code before any model is woken. A port of antiproton's
 * `prefilter` / `winningRule` / `matches` (src/plugins/raft-assistant.ts and
 * raft-assistant-rules.ts @ master), kept pure so it is tested on its own.
 *
 * Changes from the port (intended): a person rule is always enforced here,
 * since Raft's rows carry the sender and DM peer ids; channel chatter is always
 * told apart by the owner's name, which Raft always knows.
 */

export type ContactEffect = "mute" | "always" | "digest";
export type ContactItemKind = "question" | "review" | "decision" | "task" | "mention" | "decided";

/** A rule as matching needs it (assistant_contact_rules). */
export type MatchRule = {
  id: string;
  effect: ContactEffect;
  subjectKind: "channel" | "thread" | "person" | "kind" | "dms" | "legacy";
  subjectId: string | null;
  anytime: boolean;
  until: Date | null;
  createdAt: Date;
  legacy?: { channel: string | null; sender: string | null; itemKind: string | null } | null;
};

/** What a rule is held against: an inbox row, or a notified item with the row it came from. */
export type MatchTarget = {
  channelId: string | null;
  parentChannelId: string | null;
  thread: boolean;
  dm: boolean;
  mention: boolean;
  /** The person the activity is from (a DM's peer, else the row's latest sender); null when none. */
  senderId: string | null;
  kind?: ContactItemKind;
  channelName?: string | null;
  senderName?: string | null;
};

const SPECIFICITY: Record<MatchRule["subjectKind"], number> = { thread: 4, person: 3, channel: 2, dms: 2, legacy: 2, kind: 1 };

export const isRuleActive = (rule: Pick<MatchRule, "until">, now: Date) => rule.until === null || rule.until > now;

export function ruleMatches(rule: MatchRule, t: MatchTarget): boolean {
  // A channel's or a thread's rule is about its general chat: an @mention of the
  // owner there is not covered, unless the rule asks for more, not less.
  const chatOnly = rule.effect !== "always" && t.mention;
  switch (rule.subjectKind) {
    case "channel": return rule.subjectId !== null && !t.dm && !chatOnly && (t.channelId === rule.subjectId || t.parentChannelId === rule.subjectId);
    case "thread": return t.thread && !chatOnly && t.channelId === rule.subjectId;
    case "person": return rule.subjectId !== null && t.senderId !== null && t.senderId === rule.subjectId;
    case "kind": return t.kind !== undefined && t.kind === rule.subjectId;
    case "dms": return t.dm;
    case "legacy": {
      const l = rule.legacy;
      if (!l || t.kind === undefined) return false;
      return (l.channel === null || l.channel === t.channelName) && (l.sender === null || l.sender === t.senderName)
        && (l.itemKind === null || l.itemKind === t.kind);
    }
  }
}

/** The rule that decides for `t`: the most specific active one that matches, the newer on a tie. */
export function winningRule(rules: readonly MatchRule[], t: MatchTarget, now: Date): MatchRule | null {
  let best: MatchRule | null = null;
  for (const rule of rules) {
    if (!isRuleActive(rule, now) || !ruleMatches(rule, t)) continue;
    if (!best || newerOrMoreSpecific(rule, best)) best = rule;
  }
  return best;
}

function newerOrMoreSpecific(a: MatchRule, b: MatchRule): boolean {
  const d = SPECIFICITY[a.subjectKind] - SPECIFICITY[b.subjectKind];
  if (d !== 0) return d > 0;
  if (a.createdAt.getTime() !== b.createdAt.getTime()) return a.createdAt > b.createdAt;
  return a.id > b.id;
}

/** An owner-inbox row as the check reads it (the assistant owner-inbox item shape). */
export type CheckRow = {
  kind: "channel" | "thread";
  channelId: string;
  channelName: string;
  channelType: string;
  parentChannelId: string | null;
  parentMessageId: string | null;
  unread: number;
  hasMention: boolean;
  latestAt: string | null;
  latestSenderName: string | null;
  latestSenderId: string | null;
  latestSenderType: string | null;
  latestPreview: string | null;
  latestSeq: number | null;
  firstUnreadMessageId: string | null;
  peer: { id: string; type: string } | null;
  ownerParticipated?: boolean;
  /** Task v2: a task's own conversation (kind stays "thread"), and its task. */
  conversationKind?: "task";
  taskNumber?: number | null;
};

/** Why a conversation needs the owner, said beside it in the check's input. */
export type CheckWhy = "dm" | "mention" | "always" | "anytime" | "thread" | "named" | "digest";

export type NeedsOwnerMode = "day" | "night" | "brief";

/** The trace's fixed count keys (design v3.1): every check reports all of them. */
export const NEEDS_OWNER_COUNT_KEYS = [
  "conversations", "items", "truncated", "told", "skipped", "muted", "digest", "always", "dm", "mention", "thread",
  "named", "default_out", "night_held",
  // 1 when the inbox read trailed the doorbell (a conversation rang at a seq the read did not show).
  "behind",
] as const;
export type NeedsOwnerCounts = Record<(typeof NEEDS_OWNER_COUNT_KEYS)[number], number>;

export const zeroNeedsOwnerCounts = (): NeedsOwnerCounts =>
  Object.fromEntries(NEEDS_OWNER_COUNT_KEYS.map((key) => [key, 0])) as NeedsOwnerCounts;

export type NeedsOwnerInput = {
  rows: readonly CheckRow[];
  rules: readonly MatchRule[];
  now: Date;
  mode: NeedsOwnerMode;
  /** Per conversation, the highest seq the owner was told about (notify or chat). */
  toldSeq: ReadonlyMap<string, number>;
  /** Per conversation, the highest seq of a `named` item the model judged not to need the owner. */
  skippedSeq: ReadonlyMap<string, number>;
  /** The owner's handle and display name, to tell a message that names them from general chat. */
  ownerNames: readonly string[];
};

export type NeedsOwner = { items: Array<{ row: CheckRow; why: CheckWhy }>; counts: NeedsOwnerCounts };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The row's latest message is Raft's own (the SYSTEM identity: a server-admin
 * notice, a membership line, ...). Nobody said it: not the DM's other person,
 * not the owner in their self-DM (Tenny efc37842).
 */
export function isSystemSenderRow(row: Pick<CheckRow, "latestSenderId" | "latestSenderType">): boolean {
  return row.latestSenderId === "system" || row.latestSenderType === "system";
}

/**
 * A row as a rule is held against it: a DM's person is the other one in it;
 * elsewhere the latest sender; nobody when the latest message is a system one.
 */
export function rowTarget(row: CheckRow): MatchTarget {
  const dm = row.channelType === "dm";
  const person = (id: string | null, type: string | null) => id !== null && (type === "human" || type === "agent") ? id : null;
  if (isSystemSenderRow(row)) {
    return { channelId: row.channelId, parentChannelId: row.parentChannelId, thread: row.kind === "thread", dm, mention: row.hasMention, senderId: null };
  }
  return {
    channelId: row.channelId,
    parentChannelId: row.parentChannelId,
    thread: row.kind === "thread",
    dm,
    mention: row.hasMention,
    senderId: dm ? person(row.peer?.id ?? null, row.peer?.type ?? null) : person(row.latestSenderId, row.latestSenderType),
  };
}

/** Told about up to the conversation's latest activity (by seq): the one "told" rule, for the check and the owner inbox. */
export const coveredUpTo = (seqs: ReadonlyMap<string, number>, row: Pick<CheckRow, "channelId" | "latestSeq">) => {
  const seq = seqs.get(row.channelId);
  return seq !== undefined && row.latestSeq !== null && row.latestSeq !== undefined && row.latestSeq <= seq;
};

/**
 * What of the owner's unread inbox needs them (design v3.1), decided in code:
 * - told: a conversation whose latest activity the owner was already told about (by seq; later activity brings it back);
 * - the owner's rules (`winningRule`): mute drops; digest only in the brief; always lets through. A person's rule
 *   (other than always) applies to a channel row only when its one unread message is theirs, since a row names only
 *   the latest sender. At night only an always rule marked `anytime` lets anything through;
 * - the defaults: a DM and an @mention need the owner now; a thread they wrote in, and channel chat that names
 *   them (`named`: the model decides, unless it already passed over it at this activity, `skipped`), wait for
 *   the brief: a doorbell only interrupts for what is waiting on the owner (Artea, #proj-assistant:29a88926).
 */
export function needsOwner(input: NeedsOwnerInput): NeedsOwner {
  const counts = zeroNeedsOwnerCounts();
  const items: NeedsOwner["items"] = [];
  const pass = (row: CheckRow, why: CheckWhy) => { counts[why === "anytime" ? "always" : why]++; items.push({ row, why }); };
  const names = input.ownerNames.filter((n) => n.trim()).map((n) => escapeRe(n.trim().replace(/^@/, "")));
  const named = names.length ? new RegExp(`(^|[^\\p{L}\\p{N}_])@?(${names.join("|")})(?![\\p{L}\\p{N}_])`, "iu") : null;
  counts.conversations = input.rows.length;
  for (const row of input.rows) {
    if (coveredUpTo(input.toldSeq, row)) { counts.told++; continue; }
    const dm = row.channelType === "dm";
    const rules = !dm && row.unread > 1 ? input.rules.filter((r) => !(r.subjectKind === "person" && r.effect !== "always")) : input.rules;
    const rule = winningRule(rules, rowTarget(row), input.now);
    if (input.mode === "night") {
      if (rule?.effect === "always" && rule.anytime) pass(row, "anytime"); else counts.night_held++;
      continue;
    }
    if (rule?.effect === "mute") { counts.muted++; continue; }
    if (rule?.effect === "digest") {
      if (input.mode === "brief") pass(row, "digest"); else counts.digest++;
      continue;
    }
    if (rule?.effect === "always") { pass(row, "always"); continue; }
    if (dm) { pass(row, "dm"); continue; }
    if (row.hasMention) { pass(row, "mention"); continue; }
    // A thread the owner wrote in (the design's "thread you are in"); one they only follow is general chat.
    if (row.kind === "thread" && row.ownerParticipated === true) {
      if (input.mode === "brief") pass(row, "thread"); else counts.digest++;
      continue;
    }
    if (named && row.latestPreview && named.test(row.latestPreview)) {
      if (coveredUpTo(input.skippedSeq, row)) counts.skipped++;
      else if (input.mode === "brief") pass(row, "named");
      else counts.digest++;
      continue;
    }
    counts.default_out++;
  }
  // `digest` counts what waits for the brief; in the brief it is passed and counted as an item.
  if (input.mode === "brief") counts.digest = items.filter((i) => i.why === "digest").length;
  return { items, counts };
}

/** Whether `at` (epoch ms) falls in quiet hours `{ from, to }` (owner-local HH:MM) in `zone`; `from` in, `to` out. */
export function inQuietHours(at: number, zone: string, quiet: { from: string; to: string } | null): boolean {
  if (!quiet) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const t = h * 60 + m, from = minutes(quiet.from), to = minutes(quiet.to);
  return from < to ? t >= from && t < to : t >= from || t < to;
}
