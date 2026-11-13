/**
 * RFC 077 step 1 (Tenny's boundary design, #proj-assistant:83b4c3f8): a
 * personal assistant's contact rules, quiet hours and "already told" facts
 * live in Raft. The runtime's preferences tool is a thin wrapper over the
 * agent API routes; Raft validates, stores, and writes the line the owner
 * reads. Rule semantics and wording follow antiproton's
 * `src/plugins/raft-assistant-rules.ts` (master f93e2db), so switching over
 * changes nothing the owner sees.
 *
 * Subjects are kept by id (channel, thread, person) and named when shown, so a
 * rename never leaves a stale name. A `legacy` subject (several names at once)
 * only arrives by import; Raft never makes one.
 *
 * Everything here is keyed by the assistant agent and deleted with it
 * (`deleteAgent`, same transaction; the FKs cascade on a hard delete).
 */
import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, assistantCheckState, assistantContactRules, assistantContactSettings, assistantTold, channels, messages, users } from "../db/schema";
import * as channelService from "./channelService";
import { describeAssistantOf, dmScopeOf, resolveAssistantOwner, resolveNameForOwner } from "./assistantService";
import { recordTraceEvent } from "../tracing/semanticTrace";

export const CONTACT_RULE_EFFECTS = ["mute", "always", "digest"] as const;
export type ContactRuleEffect = (typeof CONTACT_RULE_EFFECTS)[number];
export const CONTACT_ITEM_KINDS = ["question", "review", "decision", "task", "mention", "decided"] as const;
export type ContactItemKind = (typeof CONTACT_ITEM_KINDS)[number];

export const CONTACT_RULES_MAX = 50;
export const CONTACT_RULE_NOTE_MAX = 200;
const SOURCE_ID_MAX = 64;
const LEGACY_NAME_MAX = 200;
const UNTIL_MAX_MS = 90 * 24 * 3_600_000;
export const DEFAULT_QUIET = { from: "22:00", to: "08:00" } as const;
export const BRIEF_TIME = "08:00";
export const ASSISTANT_TOLD_RETENTION_MS = 30 * 24 * 3_600_000;
export const ASSISTANT_TOLD_MAX_IDS = 100;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const DEFAULTS_LINE = "By default you hear about @mentions of you, your DMs, a question or decision waiting on you, a task assigned to you, " +
  "and someone asking you in a thread you are in; not general channel chat, talk between others, or what you already dealt with.";

const KIND_WORDS: Record<ContactItemKind, string> = {
  question: "questions", review: "review requests", decision: "decisions asked of you", task: "tasks assigned to you",
  mention: "@mentions", decided: "decisions others made",
};

export class AssistantContactRuleError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AssistantContactRuleError";
  }
}

type RuleRow = typeof assistantContactRules.$inferSelect;
type QuietHours = { from: string; to: string };
type LegacySubject = { channel: string | null; sender: string | null; itemKind: string | null };

/**
 * A subject as stored, with the name it is shown by, looked up now with the
 * owner's current access: null when the owner can no longer see it (a private
 * channel they left, a deleted thread). Such a rule is still listed and can
 * still be removed.
 */
export type ContactRuleSubject =
  | { kind: "channel"; id: string; name: string | null }
  | { kind: "thread"; id: string; ref: string | null }
  | { kind: "person"; id: string; type: "human" | "agent"; name: string | null }
  | { kind: "kind"; value: ContactItemKind }
  | { kind: "dms" }
  | { kind: "legacy"; channel: string | null; sender: string | null; itemKind: string | null };

export type ContactRuleView = {
  id: string;
  effect: ContactRuleEffect;
  subject: ContactRuleSubject;
  anytime: boolean;
  until: string | null;
  note: string | null;
  createdAt: string;
  /** The rule as the owner reads it in a list. */
  line: string;
};

type Owner = { agentId: string; serverId: string; ownerUserId: string };

// ---------------------------------------------------------------------------
// Wording (antiproton's ruleLine / confirmLine / quietLine, verbatim)
// ---------------------------------------------------------------------------

function subjectWords(s: ContactRuleSubject): string {
  switch (s.kind) {
    case "channel": return s.name === null ? "a channel you can no longer see" : `#${s.name}`;
    case "thread": return s.ref === null ? "a thread you can no longer see" : `the thread ${s.ref}`;
    case "person": return s.name === null ? "someone you can no longer see" : `@${s.name}`;
    case "kind": return KIND_WORDS[s.value];
    case "dms": return "your DMs";
    case "legacy": return [s.channel && `#${s.channel}`, s.sender && `@${s.sender}`, s.itemKind && (isItemKind(s.itemKind) ? KIND_WORDS[s.itemKind] : null)]
      .filter(Boolean).join(" + ");
  }
}

function untilWords(until: string | null, zone: string): string {
  if (!until) return "";
  const at = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(until));
  return ` until ${at}`;
}

const shortId = (id: string) => id.slice(0, 8);

function ruleLine(r: Omit<ContactRuleView, "line">, zone: string): string {
  const s = r.subject;
  const what = s.kind === "kind" ? `kind ${s.value}` : subjectWords(s);
  const notes = [
    (s.kind === "channel" || s.kind === "thread") && r.effect !== "always" ? "chat only; @mentions still come" : null,
    r.effect === "always" ? (r.anytime ? "any time" : "not at night") : null,
    s.kind === "legacy" ? "an older rule; say it again to replace it" : null,
  ].filter(Boolean);
  return `${shortId(r.id)} · ${r.effect} ${what}${notes.length ? ` (${notes.join("; ")})` : ""}${untilWords(r.until, zone)}`;
}

const isItemKind = (value: unknown): value is ContactItemKind =>
  typeof value === "string" && Object.hasOwn(KIND_WORDS, value);

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function confirmLine(r: Omit<ContactRuleView, "line">, zone: string, quiet: QuietHours | null): string {
  const s = r.subject;
  const until = r.until ? `,${untilWords(r.until, zone)}` : "";
  const night = quiet ? ` except during your quiet hours (${quiet.from}-${quiet.to}); say "even at night" to change that` : "";
  if (r.effect === "mute") {
    if (s.kind === "channel" || s.kind === "thread") return `General chat in ${subjectWords(s)} won't notify you anymore${until}; @mentions of you still will.`;
    if (s.kind === "person") return `Nothing from ${subjectWords(s)} will notify you anymore${until}, @mentions and DMs included.`;
    return `I won't tell you about ${subjectWords(s)} anymore${until}.`;
  }
  if (r.effect === "digest") {
    if (s.kind === "channel" || s.kind === "thread") return `General chat in ${subjectWords(s)} goes in your morning brief only${until}; @mentions of you still come right away.`;
    return `${capital(subjectWords(s))} go${s.kind === "person" ? "es" : ""} in your morning brief only${until}.`;
  }
  return r.anytime ? `I'll tell you right away about ${subjectWords(s)}${until}, nights included.`
    : `I'll tell you right away about ${subjectWords(s)}${until},${night || " any time of day"}.`;
}

const quietLine = (quiet: QuietHours | null, zone: string) => quiet ? `quiet ${quiet.from}-${quiet.to} ${zone}` : `no quiet hours (${zone})`;

// ---------------------------------------------------------------------------
// Settings and zone
// ---------------------------------------------------------------------------

async function loadSettings(agentId: string, executor: DatabaseExecutor = getDb()): Promise<{ quiet: QuietHours | null; statedTimezone: string | null }> {
  const [row] = await executor.select().from(assistantContactSettings).where(eq(assistantContactSettings.agentId, agentId)).limit(1);
  if (!row) return { quiet: { ...DEFAULT_QUIET }, statedTimezone: null };
  return { quiet: row.quiet ?? null, statedTimezone: row.statedTimezone ?? null };
}

/** The owner's zone: Raft's, else the one they told the assistant, else UTC. */
async function ownerZone(o: Owner, statedTimezone: string | null): Promise<string> {
  const assistantOf = await describeAssistantOf({ id: o.agentId, serverId: o.serverId, assistantOwnerUserId: o.ownerUserId });
  const zone = assistantOf?.timezone ?? statedTimezone ?? "UTC";
  return isValidZone(zone) ? zone : "UTC";
}

/** The owner's quiet hours (null: off) and zone, as the check and notify apply them. */
export async function contactContext(o: Owner): Promise<{ quiet: QuietHours | null; zone: string }> {
  const settings = await loadSettings(o.agentId);
  return { quiet: settings.quiet, zone: await ownerZone(o, settings.statedTimezone) };
}

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function quietOf(raw: unknown): QuietHours | null | undefined {
  if (raw === null) return null;
  const q = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!q || typeof q.from !== "string" || typeof q.to !== "string" || !HHMM.test(q.from) || !HHMM.test(q.to) || q.from === q.to) return undefined;
  return { from: q.from, to: q.to };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * Each row's subject as shown now, in a fixed number of queries (not one per
 * rule): channels and threads by id with the owner's current access, people by
 * id. What the owner can no longer see keeps its id with a null name.
 */
async function subjectsForRows(o: Owner, rows: RuleRow[]): Promise<Map<string, ContactRuleSubject>> {
  const db = getDb();
  const conversationIds = rows.filter((row) => (row.subjectKind === "channel" || row.subjectKind === "thread") && row.subjectId && UUID_RE.test(row.subjectId))
    .map((row) => row.subjectId!);
  const conversations = conversationIds.length === 0 ? [] : await db.select({
    id: channels.id, name: channels.name, type: channels.type, parentChannelId: channels.parentChannelId,
    parentMessageId: channels.parentMessageId, deletedAt: channels.deletedAt, serverId: channels.serverId,
  }).from(channels).where(inArray(channels.id, conversationIds));
  const parentIds = conversations.flatMap((c) => c.type === "thread" && c.parentChannelId ? [c.parentChannelId] : []);
  const parents = parentIds.length === 0 ? [] : await db.select({ id: channels.id, name: channels.name }).from(channels).where(inArray(channels.id, parentIds));
  const visible = conversations.length === 0 ? new Set<string>()
    : await channelService.filterUserAccessibleChannelIds(conversations.map((c) => c.id), o.ownerUserId, asServerId(o.serverId));
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const parentName = new Map(parents.map((p) => [p.id, p.name]));
  const shown = (id: string) => {
    const c = byId.get(id);
    return c && !c.deletedAt && c.serverId === o.serverId && visible.has(id) ? c : null;
  };

  const personIds = (type: "human" | "agent") => rows
    .filter((row) => row.subjectKind === "person" && row.subjectId && UUID_RE.test(row.subjectId) && (row.subjectType ?? "human") === type)
    .map((row) => row.subjectId!);
  const humanIds = personIds("human"), agentIds = personIds("agent");
  const humans = humanIds.length === 0 ? [] : await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, humanIds));
  const agentRows = agentIds.length === 0 ? [] : await db.select({ id: agents.id, name: agents.name }).from(agents)
    .where(and(inArray(agents.id, agentIds), eq(agents.serverId, o.serverId), isNull(agents.deletedAt)));
  const personName = new Map([...humans, ...agentRows].map((p) => [p.id, p.name]));

  const out = new Map<string, ContactRuleSubject>();
  for (const row of rows) {
    const id = row.subjectId ?? "";
    switch (row.subjectKind) {
      case "channel": out.set(row.id, { kind: "channel", id, name: shown(id)?.name ?? null }); break;
      case "thread": {
        const thread = shown(id);
        const parent = thread?.parentChannelId ? parentName.get(thread.parentChannelId) : undefined;
        out.set(row.id, { kind: "thread", id, ref: thread?.parentMessageId && parent ? `#${parent}:${shortId(thread.parentMessageId)}` : null });
        break;
      }
      case "person": out.set(row.id, { kind: "person", id, type: row.subjectType ?? "human", name: personName.get(id) ?? null }); break;
      case "kind": if (isItemKind(row.subjectId)) out.set(row.id, { kind: "kind", value: row.subjectId }); break;
      case "dms": out.set(row.id, { kind: "dms" }); break;
      case "legacy": {
        const legacy = row.legacy ?? { channel: null, sender: null, itemKind: null };
        out.set(row.id, { kind: "legacy", channel: legacy.channel, sender: legacy.sender, itemKind: isItemKind(legacy.itemKind) ? legacy.itemKind : null });
        break;
      }
    }
  }
  return out;
}

/** One row's subject as shown now; never missing, so every stored rule can be listed and removed. */
async function subjectOf(o: Owner, row: RuleRow): Promise<ContactRuleSubject> {
  return (await subjectsForRows(o, [row])).get(row.id) ?? { kind: "legacy", channel: null, sender: null, itemKind: null };
}

function baseView(row: RuleRow, subject: ContactRuleSubject): Omit<ContactRuleView, "line"> {
  return {
    id: row.id,
    effect: row.effect,
    subject,
    anytime: row.anytime,
    until: row.until ? row.until.toISOString() : null,
    note: row.note ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const isActive = (row: RuleRow, now: Date) => row.until === null || row.until > now;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listContactRules(o: Owner, now = new Date()) {
  const settings = await loadSettings(o.agentId);
  const zone = await ownerZone(o, settings.statedTimezone);
  const rows = await getDb().select().from(assistantContactRules)
    .where(eq(assistantContactRules.agentId, o.agentId))
    .orderBy(asc(assistantContactRules.createdAt), asc(assistantContactRules.id));
  const active = rows.filter((row) => isActive(row, now));
  const subjects = await subjectsForRows(o, active);
  const rules: ContactRuleView[] = [];
  for (const row of active) {
    const subject = subjects.get(row.id) ?? { kind: "legacy" as const, channel: null, sender: null, itemKind: null };
    const view = baseView(row, subject);
    rules.push({ ...view, line: ruleLine(view, zone) });
  }
  return {
    rules,
    settings: {
      quiet: settings.quiet,
      brief: { at: BRIEF_TIME },
      timezone: zone,
    },
    lines: { quiet: quietLine(settings.quiet, zone), brief: `morning brief at ${BRIEF_TIME} ${zone}`, defaults: DEFAULTS_LINE },
  };
}

// ---------------------------------------------------------------------------
// Subjects the assistant names (resolved with the owner's visibility)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = () => new AssistantContactRuleError(400, "subject_not_found", "Your owner cannot see anything by that name here.");

type ResolvedSubject =
  | { kind: "channel" | "thread"; id: string }
  | { kind: "person"; id: string; type: "human" | "agent" }
  | { kind: "kind"; value: ContactItemKind }
  | { kind: "dms" };

/**
 * `#channel`, `#channel:<msg short id>` (a thread), `@name` (`~human` / `~agent`
 * to pick), `kind:<kind>`, `dms`, or a channel / thread id from an owner read.
 * Anything the owner cannot see is the same 400 as anything that does not exist.
 */
export async function resolveSubject(o: Owner, raw: string): Promise<ResolvedSubject> {
  const text = raw.trim();
  if (text === "dms") return { kind: "dms" };
  if (text.startsWith("kind:")) {
    const value = CONTACT_ITEM_KINDS.find((k) => k === text.slice("kind:".length));
    if (!value) throw new AssistantContactRuleError(400, "invalid_subject", `A kind is one of ${CONTACT_ITEM_KINDS.join(", ")}.`);
    return { kind: "kind", value };
  }
  if (text.startsWith("@")) {
    const person = await resolveNameForOwner(o.serverId, o.ownerUserId, text);
    // An `@` name is never a channel or a DM; the type check only narrows it.
    if (!person.ok || person.type === "channel" || person.type === "dm") throw NOT_FOUND();
    return { kind: "person", id: person.id, type: person.type };
  }
  if (UUID_RE.test(text)) return ownerVisibleConversation(o, text);
  if (text.startsWith("#")) {
    const [name, short] = text.slice(1).split(":");
    const [channel] = name ? await getDb().select({ id: channels.id }).from(channels).where(and(
      eq(channels.serverId, o.serverId),
      inArray(channels.type, ["channel", "private", "joint"]),
      eq(channels.name, name),
      isNull(channels.deletedAt),
    )).limit(1) : [];
    if (!channel) throw NOT_FOUND();
    if (short === undefined) return ownerVisibleConversation(o, channel.id);
    if (!/^[0-9a-f]{8}$/i.test(short)) throw new AssistantContactRuleError(400, "invalid_subject", "A thread is #channel:<8-character message id>.");
    const [thread] = await getDb().select({ id: channels.id }).from(channels).where(and(
      eq(channels.serverId, o.serverId),
      eq(channels.type, "thread"),
      eq(channels.name, `thread-${short.toLowerCase()}`),
      eq(channels.parentChannelId, channel.id),
      isNull(channels.deletedAt),
    )).limit(1);
    if (!thread) throw NOT_FOUND();
    return ownerVisibleConversation(o, thread.id);
  }
  throw new AssistantContactRuleError(400, "invalid_subject", "Name a #channel, a #channel:msgid thread, an @person, kind:<kind>, or dms.");
}

async function ownerVisibleConversation(o: Owner, channelId: string): Promise<ResolvedSubject> {
  const channel = await channelService.getChannel(channelId);
  // A DM (or a thread in one) is not a channel rule's subject: `dms` or the person is.
  if (!channel || channel.serverId !== o.serverId || channel.deletedAt) throw NOT_FOUND();
  if ((await dmScopeOf(channel)).dm) throw NOT_FOUND();
  if (!["channel", "private", "joint", "thread"].includes(channel.type)) throw NOT_FOUND();
  if (!await channelService.canUserAccessChannel(channel.id, o.ownerUserId, asServerId(o.serverId))) throw NOT_FOUND();
  return { kind: channel.type === "thread" ? "thread" : "channel", id: channel.id };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function untilOf(raw: unknown, now: Date): Date | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const t = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(t)) throw new AssistantContactRuleError(400, "invalid_until", "until must be an ISO time.");
  if (t <= now.getTime()) throw new AssistantContactRuleError(400, "invalid_until", "until is not in the future.");
  if (t - now.getTime() > UNTIL_MAX_MS) throw new AssistantContactRuleError(400, "invalid_until", "until is more than 90 days away: omit it for a lasting rule.");
  return new Date(t);
}

const subjectColumns = (s: ResolvedSubject) => ({
  subjectKind: s.kind,
  subjectId: s.kind === "dms" ? null : s.kind === "kind" ? s.value : s.id,
  subjectType: s.kind === "person" ? s.type : null,
});

/** Serialize writes to one assistant's rules (the agent row lock), and drop expired rules on the way. */
async function lockRules(tx: DatabaseExecutor, agentId: string, now: Date): Promise<void> {
  await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for("update");
  await tx.delete(assistantContactRules).where(and(eq(assistantContactRules.agentId, agentId), lt(assistantContactRules.until, now)));
}

/**
 * Add a rule. The same effect on the same subject updates that rule (its
 * `until`, `anytime` and note become the new ones), so "not this week" then
 * "not today" leaves one rule saying today.
 */
export async function addContactRule(o: Owner, input: {
  effect: string;
  subject: string;
  anytime?: boolean;
  until?: string | null;
  note?: string | null;
}, now = new Date()): Promise<{ rule: ContactRuleView; confirmation: string; updated: boolean }> {
  const effect = CONTACT_RULE_EFFECTS.find((e) => e === input.effect);
  if (!effect) throw new AssistantContactRuleError(400, "invalid_effect", `effect must be one of ${CONTACT_RULE_EFFECTS.join(", ")}.`);
  if (input.anytime === true && effect !== "always") throw new AssistantContactRuleError(400, "invalid_anytime", "anytime is only for effect always.");
  const until = untilOf(input.until, now);
  const subject = await resolveSubject(o, input.subject);
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;
  if (note && note.length > CONTACT_RULE_NOTE_MAX) throw new AssistantContactRuleError(400, "invalid_note", `A note is at most ${CONTACT_RULE_NOTE_MAX} characters.`);
  const columns = subjectColumns(subject);

  const { row, updated } = await getDb().transaction(async (tx) => {
    await lockRules(tx, o.agentId, now);
    const [same] = await tx.select().from(assistantContactRules).where(and(
      eq(assistantContactRules.agentId, o.agentId),
      eq(assistantContactRules.effect, effect),
      eq(assistantContactRules.subjectKind, columns.subjectKind),
      columns.subjectId === null ? isNull(assistantContactRules.subjectId) : eq(assistantContactRules.subjectId, columns.subjectId),
    )).limit(1);
    const fields = { anytime: input.anytime === true, until, note, updatedAt: now };
    if (same) {
      const [row] = await tx.update(assistantContactRules).set(fields).where(eq(assistantContactRules.id, same.id)).returning();
      return { row: row!, updated: true };
    }
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(assistantContactRules).where(eq(assistantContactRules.agentId, o.agentId));
    if (n >= CONTACT_RULES_MAX) {
      throw new AssistantContactRuleError(409, "contact_rules_full", `Your owner already has ${CONTACT_RULES_MAX} rules. Remove one first.`);
    }
    const [row] = await tx.insert(assistantContactRules).values({
      agentId: o.agentId, serverId: o.serverId, effect, ...columns, ...fields, createdAt: now,
    }).returning();
    return { row: row!, updated: false };
  });

  const settings = await loadSettings(o.agentId);
  const zone = await ownerZone(o, settings.statedTimezone);
  const view = baseView(row, await subjectOf(o, row));
  return { rule: { ...view, line: ruleLine(view, zone) }, confirmation: confirmLine(view, zone, settings.quiet), updated };
}

/** Remove a rule by its id or the 8-character id its line shows. */
export async function removeContactRule(o: Owner, id: string): Promise<{ confirmation: string }> {
  const rows = await getDb().select().from(assistantContactRules).where(and(
    eq(assistantContactRules.agentId, o.agentId),
    UUID_RE.test(id)
      ? eq(assistantContactRules.id, id)
      : /^[0-9a-f]{8}$/i.test(id) ? sql`${assistantContactRules.id}::text LIKE ${`${id.toLowerCase()}%`}` : sql`false`,
  )).limit(2);
  if (rows.length > 1) throw new AssistantContactRuleError(409, "contact_rule_ambiguous", "More than one rule starts with that; use the full id from the list.");
  if (rows.length === 0) throw new AssistantContactRuleError(404, "contact_rule_not_found", "No rule of your owner's has that id.");
  const row = rows[0]!;
  await getDb().delete(assistantContactRules).where(eq(assistantContactRules.id, row.id));
  const settings = await loadSettings(o.agentId);
  const zone = await ownerZone(o, settings.statedTimezone);
  const line = ruleLine(baseView(row, await subjectOf(o, row)), zone);
  return { confirmation: `Removed: ${line.slice(line.indexOf(" · ") + 3)}.` };
}

/**
 * Change the owner's contact settings. Only what is given changes: `quiet`
 * (`{ from, to }`, or null to turn quiet hours off) and `statedTimezone` (the
 * zone the owner told the assistant; null forgets it), so a runtime never has to
 * read-modify-write and race another change.
 */
export async function setContactSettings(
  o: Owner,
  input: { quiet?: unknown; statedTimezone?: string | null },
  now = new Date(),
): Promise<{ settings: { quiet: QuietHours | null; statedTimezone: string | null }; confirmation: string }> {
  const hasQuiet = Object.prototype.hasOwnProperty.call(input, "quiet");
  const hasZone = Object.prototype.hasOwnProperty.call(input, "statedTimezone");
  if (!hasQuiet && !hasZone) throw new AssistantContactRuleError(400, "invalid_settings", "Give quiet, statedTimezone, or both.");
  const quiet = hasQuiet ? quietOf(input.quiet) : undefined;
  if (hasQuiet && quiet === undefined) throw new AssistantContactRuleError(400, "invalid_quiet", "quiet is { from, to } as HH:MM (different times), or null to turn quiet hours off.");
  const statedTimezone = hasZone ? (input.statedTimezone?.trim() || null) : undefined;
  if (statedTimezone && !isValidZone(statedTimezone)) throw new AssistantContactRuleError(400, "invalid_timezone", "statedTimezone is an IANA zone name, such as Asia/Shanghai.");
  const set = { ...(hasQuiet ? { quiet } : {}), ...(hasZone ? { statedTimezone } : {}), updatedAt: now };
  await getDb().insert(assistantContactSettings)
    .values({ agentId: o.agentId, quiet: hasQuiet ? quiet! : { ...DEFAULT_QUIET }, statedTimezone: statedTimezone ?? null, updatedAt: now })
    .onConflictDoUpdate({ target: assistantContactSettings.agentId, set });
  // The brief's time is 08:00 in the owner's zone: a new zone reschedules it.
  if (hasZone) await getDb().update(assistantCheckState).set({ nextBriefAt: null, updatedAt: now }).where(eq(assistantCheckState.agentId, o.agentId));
  const settings = await loadSettings(o.agentId);
  const zone = await ownerZone(o, settings.statedTimezone);
  const lines = [
    ...(hasQuiet ? [settings.quiet
      ? `Quiet hours are now ${settings.quiet.from}-${settings.quiet.to} (${zone}): nothing reaches you then unless a rule says "even at night".`
      : `Quiet hours are off (${zone}): I tell you about things whenever they come up.`] : []),
    ...(hasZone && !hasQuiet ? [`I'll use ${zone} for your morning brief and quiet hours.`] : []),
  ];
  return { settings: { quiet: settings.quiet, statedTimezone: settings.statedTimezone }, confirmation: lines.join(" ") };
}

// ---------------------------------------------------------------------------
// One-time import of the runtime's rules (idempotent by the runtime's rule id)
// ---------------------------------------------------------------------------

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * Import what the runtime kept: its `rules` (exactly as stored there, older
 * shapes included) and `contact` ({ quiet }). Each rule's own id is the key, so
 * a repeated push changes nothing new. A rule naming one thing becomes a rule on
 * that thing's id; one naming several, or a name the owner cannot resolve, is
 * kept as `legacy` and counted. A rule is updated only by its own id: one that
 * lands on a subject another rule already has (Raft's or another imported one)
 * is skipped, so a re-push never flips rules back and forth. The same limits
 * as adding apply. Expired, unreadable or out-of-limit rules, and contact
 * settings that do not parse, are skipped and counted; nothing is dropped
 * silently.
 */
export async function importContactRules(o: Owner, input: { rules?: unknown; contact?: unknown; statedTimezone?: unknown }, now = new Date()) {
  const result = { imported: 0, updated: 0, skipped: 0, legacy: 0 };
  const rawRules = Array.isArray(input.rules) ? input.rules : [];
  for (const raw of rawRules) {
    const parsed = await importedRule(o, raw, now);
    if (!parsed) { result.skipped++; continue; }
    const outcome = await getDb().transaction(async (tx) => {
      await lockRules(tx, o.agentId, now);
      const [bySource] = await tx.select({ id: assistantContactRules.id }).from(assistantContactRules)
        .where(and(eq(assistantContactRules.agentId, o.agentId), eq(assistantContactRules.sourceId, parsed.sourceId))).limit(1);
      const [bySubject] = await tx.select({ id: assistantContactRules.id }).from(assistantContactRules).where(and(
        eq(assistantContactRules.agentId, o.agentId),
        eq(assistantContactRules.effect, parsed.effect),
        eq(assistantContactRules.subjectKind, parsed.subjectKind),
        parsed.subjectId === null ? isNull(assistantContactRules.subjectId) : eq(assistantContactRules.subjectId, parsed.subjectId),
      )).limit(1);
      if (bySubject && bySubject.id !== bySource?.id) return "skipped" as const;
      if (bySource) {
        await tx.update(assistantContactRules).set({
          subjectKind: parsed.subjectKind, subjectId: parsed.subjectId, subjectType: parsed.subjectType, legacy: parsed.legacy,
          effect: parsed.effect, ...parsed.fields, updatedAt: now,
        }).where(eq(assistantContactRules.id, bySource.id));
        return "updated" as const;
      }
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(assistantContactRules).where(eq(assistantContactRules.agentId, o.agentId));
      if (n >= CONTACT_RULES_MAX) return "skipped" as const;
      await tx.insert(assistantContactRules).values({
        agentId: o.agentId, serverId: o.serverId, effect: parsed.effect, subjectKind: parsed.subjectKind, subjectId: parsed.subjectId,
        subjectType: parsed.subjectType, legacy: parsed.legacy, sourceId: parsed.sourceId, ...parsed.fields,
        createdAt: now, updatedAt: now,
      });
      return "imported" as const;
    });
    result[outcome]++;
    if (outcome !== "skipped" && parsed.subjectKind === "legacy") result.legacy++;
  }

  const contact = input.contact && typeof input.contact === "object" ? input.contact as Record<string, unknown> : null;
  const quiet = contact && "quiet" in contact ? quietOf(contact.quiet) : undefined;
  if (contact && "quiet" in contact && quiet === undefined) result.skipped++;
  const statedTimezone = str(input.statedTimezone) && isValidZone(input.statedTimezone as string) ? input.statedTimezone as string : null;
  if (str(input.statedTimezone) && !statedTimezone) result.skipped++;
  if (quiet !== undefined || statedTimezone) {
    const set = { ...(quiet !== undefined ? { quiet } : {}), ...(statedTimezone ? { statedTimezone } : {}), updatedAt: now };
    await getDb().insert(assistantContactSettings).values({ agentId: o.agentId, quiet: quiet === undefined ? { ...DEFAULT_QUIET } : quiet, statedTimezone, updatedAt: now })
      .onConflictDoUpdate({ target: assistantContactSettings.agentId, set });
  }
  return result;
}

async function importedRule(o: Owner, raw: unknown, now: Date) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const sourceId = r ? str(r.id) : null;
  if (!r || !sourceId || sourceId.length > SOURCE_ID_MAX) return null;
  const until = str(r.until) && Number.isFinite(Date.parse(r.until as string)) ? new Date(r.until as string) : null;
  if (until && (until <= now || until.getTime() - now.getTime() > UNTIL_MAX_MS)) return null;
  const note = str(r.note)?.trim() || null;
  if (note && note.length > CONTACT_RULE_NOTE_MAX) return null;
  const legacyRule = (legacy: LegacySubject) => ({ subjectKind: "legacy" as const, subjectId: sourceId, subjectType: null, legacy });

  let effect: ContactRuleEffect;
  let subject: { subjectKind: RuleRow["subjectKind"]; subjectId: string | null; subjectType: "human" | "agent" | null; legacy: LegacySubject | null } | null;
  if (CONTACT_RULE_EFFECTS.includes(r.effect as ContactRuleEffect)) {
    effect = r.effect as ContactRuleEffect;
    subject = await importedSubject(o, r.subject, legacyRule);
  } else {
    // v1: { id, channel, sender, kind, note }, mute only.
    effect = "mute";
    const channel = legacyName(r.channel), sender = legacyName(r.sender), kind = isItemKind(r.kind) ? r.kind : null;
    const named = [channel, sender, kind].filter((x) => x !== null).length;
    subject = named === 0 || channel === undefined || sender === undefined ? null
      : named > 1 ? { ...legacyRule({ channel, sender, itemKind: kind }) }
      : await importedSubject(o, channel !== null ? { kind: "channel", id: null, name: channel }
        : sender !== null ? { kind: "person", id: null, name: sender } : { kind: "kind", value: kind }, legacyRule);
  }
  if (!subject) return null;
  return {
    sourceId,
    effect,
    ...subject,
    fields: { anytime: r.anytime === true && effect === "always", until, note },
  };
}

async function importedSubject(
  o: Owner,
  raw: unknown,
  legacyRule: (legacy: LegacySubject) => { subjectKind: "legacy"; subjectId: string; subjectType: null; legacy: LegacySubject },
) {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!s) return null;
  const tryResolve = async (text: string) => {
    try {
      return await resolveSubject(o, text);
    } catch (error) {
      if (error instanceof AssistantContactRuleError) return null;
      throw error;
    }
  };
  const fromResolved = (r: ResolvedSubject) => ({ ...subjectColumns(r), legacy: null });
  switch (s.kind) {
    case "channel": {
      const name = legacyName(s.name);
      if (name === undefined) return null;
      const resolved = await tryResolve(str(s.id) ?? `#${name ?? ""}`);
      return resolved?.kind === "channel" ? fromResolved(resolved) : name ? legacyRule({ channel: name, sender: null, itemKind: null }) : null;
    }
    case "thread": {
      const resolved = str(s.id) ? await tryResolve(s.id as string) : null;
      return resolved?.kind === "thread" ? fromResolved(resolved) : null;
    }
    case "person": {
      // An id is held to the same check as `@name`: someone the owner can see here now.
      const id = str(s.id);
      if (id && (s.type === "human" || s.type === "agent")) {
        const resolved = await personVisibleToOwner(o, id, s.type);
        if (resolved) return fromResolved(resolved);
      }
      const name = legacyName(s.name);
      if (name === undefined) return null;
      const resolved = name ? await tryResolve(`@${name}`) : null;
      return resolved?.kind === "person" ? fromResolved(resolved) : name ? legacyRule({ channel: null, sender: name, itemKind: null }) : null;
    }
    case "kind": {
      const value = CONTACT_ITEM_KINDS.find((k) => k === s.value);
      return value ? fromResolved({ kind: "kind", value }) : null;
    }
    case "dms": return fromResolved({ kind: "dms" });
    case "legacy": {
      const channel = legacyName(s.channel), sender = legacyName(s.sender);
      if (channel === undefined || sender === undefined) return null;
      return legacyRule({ channel, sender, itemKind: isItemKind(s.itemKind) ? s.itemKind : null });
    }
    default: return null;
  }
}

/** A name kept from an older rule: null when absent, undefined when too long to keep. */
function legacyName(v: unknown): string | null | undefined {
  const name = str(v);
  return name === null ? null : name.length > LEGACY_NAME_MAX ? undefined : name;
}

async function personVisibleToOwner(o: Owner, id: string, type: "human" | "agent"): Promise<ResolvedSubject | null> {
  if (!UUID_RE.test(id)) return null;
  const [person] = type === "agent"
    ? await getDb().select({ name: agents.name }).from(agents).where(and(eq(agents.id, id), eq(agents.serverId, o.serverId), isNull(agents.deletedAt))).limit(1)
    : await getDb().select({ name: users.name }).from(users).where(eq(users.id, id)).limit(1);
  if (!person) return null;
  const resolved = await resolveNameForOwner(o.serverId, o.ownerUserId, `${person.name}~${type}`);
  return resolved.ok && resolved.id === id ? { kind: "person", id, type } : null;
}

// ---------------------------------------------------------------------------
// "Already told"
// ---------------------------------------------------------------------------

/**
 * Record that the owner was told about these messages. Only messages in this
 * server, in conversations the owner can see now, are kept; the rest are
 * counted as skipped. Telling again refreshes the time.
 */
export async function recordTold(
  o: Owner,
  input: { messageIds?: string[]; refs?: string[]; via: "notify" | "chat" | "skipped" },
  now = new Date(),
) {
  const given = (input.messageIds?.length ?? 0) + (input.refs?.length ?? 0);
  const ids = new Set((input.messageIds ?? []).filter((id) => UUID_RE.test(id)));
  for (const ref of input.refs ?? []) {
    const id = await messageIdOfRef(o, ref);
    if (id) ids.add(id);
  }
  const wanted = [...ids].slice(0, ASSISTANT_TOLD_MAX_IDS);
  const rows = wanted.length === 0 ? [] : await getDb().select({ id: messages.id, channelId: messages.channelId, seq: messages.seq })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(and(inArray(messages.id, wanted), eq(channels.serverId, o.serverId), isNull(messages.deletedAt)));
  // A reference to a message a thread hangs off tells about the thread too, up to its latest reply.
  const threads = rows.length === 0 ? [] : await getDb().select({ id: channels.id, parentMessageId: channels.parentMessageId })
    .from(channels)
    .where(and(eq(channels.type, "thread"), inArray(channels.parentMessageId, rows.map((row) => row.id)), isNull(channels.deletedAt)));
  const threadLatest = threads.length === 0 ? [] : await getDb().execute<{ id: string; channel_id: string; seq: string }>(sql`
    SELECT DISTINCT ON (${messages.channelId}) ${messages.id} AS id, ${messages.channelId} AS channel_id, ${messages.seq}::text AS seq
    FROM ${messages}
    WHERE ${inArray(messages.channelId, threads.map((thread) => thread.id))} AND ${messages.deletedAt} IS NULL
    ORDER BY ${messages.channelId}, ${messages.seq} DESC`).then((result) => result.rows);
  const tellings = [
    ...rows.map((row) => ({ id: row.id, channelId: row.channelId, seq: Number(row.seq) })),
    ...threadLatest.map((row) => ({ id: row.id, channelId: row.channel_id, seq: Number(row.seq) })),
  ];
  const visible = await channelService.filterUserAccessibleChannelIds([...new Set(tellings.map((row) => row.channelId))], o.ownerUserId, asServerId(o.serverId));
  const kept = tellings.filter((row) => visible.has(row.channelId));
  if (kept.length > 0) {
    // RFC 077 step 2: the telling covers its conversation up to the message's seq.
    // A telling never moves to a lesser one (notify > chat > held > skipped).
    await getDb().insert(assistantTold)
      .values(kept.map((row) => ({ agentId: o.agentId, messageId: row.id, channelId: row.channelId, seq: row.seq, via: input.via, toldAt: now })))
      .onConflictDoUpdate({
        target: [assistantTold.agentId, assistantTold.messageId],
        set: {
          via: sql`CASE WHEN ${TOLD_RANK(sql`${assistantTold.via}`)} > ${TOLD_RANK(sql`excluded.via`)} THEN ${assistantTold.via} ELSE excluded.via END`,
          toldAt: now,
          channelId: sql`excluded.channel_id`,
          seq: sql`greatest(coalesce(${assistantTold.seq}, 0), excluded.seq)`,
        },
      });
  }
  const recorded = rows.filter((row) => visible.has(row.channelId)).length;
  return { recorded, skipped: given - recorded };
}

const TOLD_RANK = (via: ReturnType<typeof sql>) => sql`(CASE ${via} WHEN 'notify' THEN 3 WHEN 'chat' THEN 2 WHEN 'held' THEN 1 ELSE 0 END)`;

/**
 * A reference as written to the owner: `#channel:msgid` (the message in that
 * channel or a thread under it) or `dm:@peer:msgid` (the owner's DM with that
 * peer, named from their side); an 8-character or full message id. Null when
 * unknown, ambiguous or deleted. Visibility is checked by the caller.
 */
async function messageIdOfRef(o: Owner, ref: string): Promise<string | null> {
  const text = ref.trim();
  const dm = /^dm:@([^\s:]{1,120}):([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)$/i.exec(text);
  const channelRef = /^#([^\s:#]{1,80}):([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)$/i.exec(text);
  const match = dm ?? channelRef;
  if (!match) return null;
  const id = match[2]!.toLowerCase();
  // A short id is a range on the primary key (an index range scan), never a text LIKE over messages.
  const idCondition = id.length === 36
    ? eq(messages.id, id)
    : sql`${messages.id} BETWEEN ${`${id}-0000-0000-0000-000000000000`}::uuid AND ${`${id}-ffff-ffff-ffff-ffffffffffff`}::uuid`;
  if (dm) {
    // The owner's DMs (and threads / task v2 conversations in them) holding a message with that id; the one whose peer has that name.
    const candidates = await getDb().select({ id: messages.id, channelId: channels.id, type: channels.type, parentChannelId: channels.parentChannelId })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(and(idCondition, eq(channels.serverId, o.serverId), isNull(messages.deletedAt), inArray(channels.type, ["dm", "thread", "task"])))
      .limit(5);
    const found: string[] = [];
    for (const candidate of candidates) {
      const root = candidate.type === "dm" ? candidate.channelId : candidate.parentChannelId;
      if (!root) continue;
      const peer = await channelService.resolveUserFacingDmPeerRef(o.serverId, o.ownerUserId, root);
      if (peer && peer.toLowerCase() === match[1]!.toLowerCase().replace(/^@/, "")) found.push(candidate.id);
    }
    return found.length === 1 ? found[0]! : null;
  }
  // `#<name>:<id>`: the id decides, the name is only a hint (Tenny, task #6). The model
  // may name a DM by the peer as the owner sees them, or a channel slightly off; the
  // message is the one with that id the owner can see. Ambiguous: not recorded (traced).
  const candidates = await getDb().select({ id: messages.id, channelId: messages.channelId, channelName: channels.name, parentChannelId: channels.parentChannelId })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(and(idCondition, eq(channels.serverId, o.serverId), isNull(messages.deletedAt)))
    .limit(5);
  if (candidates.length === 0) return null;
  const visible = await channelService.filterUserAccessibleChannelIds([...new Set(candidates.map((row) => row.channelId))], o.ownerUserId, asServerId(o.serverId));
  const seeable = candidates.filter((row) => visible.has(row.channelId));
  if (seeable.length === 1) return seeable[0]!.id;
  if (seeable.length > 1) {
    // Prefer the one in the named channel (or a thread under it), if exactly one is.
    const named = await getDb().select({ id: channels.id }).from(channels).where(and(
      eq(channels.serverId, o.serverId), eq(channels.name, match[1]!), isNull(channels.deletedAt),
    )).limit(1);
    const inNamed = named[0] ? seeable.filter((row) => row.channelId === named[0]!.id || row.parentChannelId === named[0]!.id) : [];
    if (inNamed.length === 1) return inNamed[0]!.id;
    recordTraceEvent("server.assistant.told_ref_ambiguous", { agent_id: o.agentId, candidates: seeable.length });
  }
  return null;
}

/**
 * What the owner was told, oldest first, paged by `(toldAt, messageId)`: a
 * batch recorded at one instant never straddles a page boundary unseen.
 * `cursor` is the previous page's `nextCursor`; without it, from `since`.
 */
export async function listTold(agentId: string, input: { since: Date; cursor?: string | null; limit: number }) {
  const after = parseToldCursor(input.cursor);
  if (input.cursor && !after) throw new AssistantContactRuleError(400, "invalid_cursor", "cursor must be a nextCursor from a previous page.");
  const rows = await getDb().select().from(assistantTold)
    .where(and(
      eq(assistantTold.agentId, agentId),
      // A skip or a hold is not a telling: never listed as one.
      sql`${assistantTold.via} NOT IN ('skipped', 'held')`,
      after
        ? sql`(${assistantTold.toldAt}, ${assistantTold.messageId}) > (${after.at.toISOString()}::timestamptz, ${after.messageId}::uuid)`
        : gt(assistantTold.toldAt, input.since),
    ))
    .orderBy(asc(assistantTold.toldAt), asc(assistantTold.messageId))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({ messageId: row.messageId, via: row.via, at: row.toldAt.toISOString() })),
    hasMore: rows.length > input.limit,
    nextCursor: rows.length > input.limit && last ? `${last.toldAt.toISOString()}|${last.messageId}` : null,
  };
}

function parseToldCursor(cursor: string | null | undefined): { at: Date; messageId: string } | null {
  if (!cursor) return null;
  const [at, messageId] = cursor.split("|");
  const time = at ? new Date(at) : null;
  return time && !Number.isNaN(time.getTime()) && messageId && UUID_RE.test(messageId) ? { at: time, messageId } : null;
}

/** Drop "already told" rows past the retention window, a batch at a time. */
export async function sweepAssistantTold(now = new Date(), batch = 1000): Promise<number> {
  const cutoff = new Date(now.getTime() - ASSISTANT_TOLD_RETENTION_MS);
  let total = 0;
  for (;;) {
    const deleted = await getDb().delete(assistantTold)
      .where(sql`(${assistantTold.agentId}, ${assistantTold.messageId}) IN (
        SELECT agent_id, message_id FROM assistant_told WHERE told_at < ${cutoff.toISOString()}::timestamptz LIMIT ${batch}
      )`)
      .returning({ agentId: assistantTold.agentId });
    const count = deleted.length;
    total += count;
    if (count < batch) return total;
  }
}


/** A reference as an assistant writes it to its owner (see messageIdOfRef). */
const OWNER_REF_RE = /(?:#[^\s:#]{1,80}|dm:@[^\s:]{1,120}):[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?/gi;

/**
 * RFC 077: what an assistant tells its owner in their DM is told, whatever
 * runtime wrote it. When the assistant posts in its own DM with its owner (or a
 * thread under it), every `#channel:msgid` / `dm:@peer:msgid` reference in the
 * message is recorded as told (`via=chat`), through the same `recordTold` the
 * chat route uses (only what the owner can see; unknown references ignored).
 * The model calls nothing. Best effort: never fails the send.
 */
export async function recordToldFromOwnerDmMessage(input: {
  agentId: string;
  serverId: string;
  channelId: string;
  content: string;
  agentSendKey?: string | null;
}): Promise<{ given: number; recorded: number } | null> {
  // A notify message records its own tellings (as notify).
  if (input.agentSendKey?.startsWith("notify:")) return null;
  const refs = [...new Set(input.content.match(OWNER_REF_RE) ?? [])];
  if (refs.length === 0) return null;
  try {
    const ownerUserId = await resolveAssistantOwner(input.agentId, input.serverId);
    if (!ownerUserId) return null;
    const ownDmId = await channelService.findHumanAgentDmChannelId(input.serverId, ownerUserId, input.agentId);
    if (!ownDmId) return null;
    if (input.channelId !== ownDmId) {
      const channel = await channelService.getChannel(input.channelId);
      if (!channel) return null;
      const scope = await dmScopeOf(channel);
      if (!scope.dm || scope.rootChannelId !== ownDmId) return null;
    }
    const result = await recordTold({ agentId: input.agentId, serverId: input.serverId, ownerUserId }, { refs, via: "chat" });
    recordTraceEvent("server.assistant.chat_told", {
      agent_id: input.agentId,
      subject_user_id: ownerUserId,
      refs_given: refs.length,
      told_recorded: result.recorded,
    });
    return { given: refs.length, recorded: result.recorded };
  } catch (err) {
    recordTraceEvent("server.assistant.chat_told.failed", { agent_id: input.agentId, error_class: err instanceof Error ? err.name : "error" });
    return null;
  }
}
