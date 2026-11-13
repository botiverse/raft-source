/**
 * RFC 077 step 2 (design v3.1): `POST /assistant/notify`. The model wrote one
 * line per item of a check; Raft maps them back to the check's items, applies
 * what only the model's `kind` can decide (kind rules), quiet hours and what
 * was told since, composes the DM in a fixed form (at most three lines, then
 * "N more"), sends it as the assistant to its owner, and records what it
 * showed as told (at each conversation's latest seq).
 *
 * The assistant decides what reaches its owner (tygg, #proj-assistant:44bc557f):
 * it may leave out any item, a DM or an @mention too; the original is not lost,
 * it is still in the owner's inbox and Activity. A left-out item is recorded as
 * held (`named`: as skipped), so doorbells do not offer it again until it moves;
 * the brief and "more" still list it. Only the owner's own rules bind it: an
 * item an `always` rule let through is shown even without a line (a fixed line
 * says who and where), and the owner's kind rules apply to every line. Every
 * line sent carries a reason from its kind (`decision_needed`, `question`,
 * `review_requested`, `task_assigned`, `mention`, `owner_rule`), counted in the
 * trace, so an owner who finds it noisy can see which kind it was. A check
 * with nothing to show sends nothing, a brief included.
 */
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { asServerId, formatRaftChannelTaskRef, formatRaftDmTaskRef } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, assistantCheckState, assistantChecks, assistantContactRules, assistantContactSettings, assistantTold, messages } from "../db/schema";
import type { AgentOrchestrator } from "./agentOrchestrator";
import * as channelService from "./channelService";
import * as messageService from "./messageService";
import { contactContext } from "./assistantContactRulesService";
import { ASSISTANT_CHECK_TTL_MS, type CheckItem } from "./assistantCheckService";
import { inQuietHours, winningRule, type ContactItemKind, type MatchRule } from "./assistantCheckFilter";
import { assistantLines, ownerLanguage, type MoreWhere } from "./assistantLines";
import { describeAssistantOf, readableOwnerDmPolicy } from "./assistantService";
import { recordTraceEvent } from "../tracing/semanticTrace";

export const ASSISTANT_NOTIFY_ITEMS_MAX = 30;
export const ASSISTANT_NOTIFY_SHOWN_MAX = 3;
export const ASSISTANT_NOTIFY_SUMMARY_MAX = 120;
const RULE_KINDS: readonly ContactItemKind[] = ["question", "review", "decision", "task", "mention"];

export class AssistantNotifyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AssistantNotifyError";
  }
}

export type NotifyOutcome = "sent" | "duplicate" | "nothing_to_send" | "kept_for_brief";
export type NotifyDropReason = "not_in_check" | "not_visible" | "told" | "rule_mute" | "duplicate_item";
export type NotifyReason = "decision_needed" | "question" | "review_requested" | "task_assigned" | "mention" | "decided" | "owner_rule" | "unstated";
export type NotifyResult = {
  outcome: NotifyOutcome;
  shown: number;
  more: number;
  dropped: Array<{ channelId: string; reason: NotifyDropReason }>;
  /** Why each line sent (shown or counted in "N more") reached the owner, by reason. */
  reasons?: Partial<Record<NotifyReason, number>>;
};

const REASON_OF_KIND: Record<ContactItemKind, NotifyReason> = {
  decision: "decision_needed", question: "question", review: "review_requested", task: "task_assigned", mention: "mention", decided: "decided",
};

type Owner = { agentId: string; serverId: string; ownerUserId: string };

/** A summary as the DM shows it: one line, within the limit, cut at a word, no task-number links. */
export function clipSummary(raw: string): string {
  const s = raw.replace(/\s+/g, " ").trim().replace(/\btask\s*#(\d+)/gi, "task $1");
  if (s.length <= ASSISTANT_NOTIFY_SUMMARY_MAX) return s;
  const head = s.slice(0, ASSISTANT_NOTIFY_SUMMARY_MAX - 1);
  const space = head.lastIndexOf(" ");
  return `${(space > ASSISTANT_NOTIFY_SUMMARY_MAX / 2 ? head.slice(0, space) : head).replace(/[\s,;:.-]+$/, "")}…`;
}

/** The reference the owner clicks for an item: its conversation's first unread message (a thread: the message it hangs off; a task conversation: the task). */
export function itemRef(item: CheckItem): string {
  const short = (id: string) => id.slice(0, 8);
  if (item.taskNumber != null) return item.dm ? formatRaftDmTaskRef(item.channelName, item.taskNumber) : formatRaftChannelTaskRef(item.channelName, item.taskNumber);
  if (item.dm) return item.firstUnreadMessageId ? `dm:@${item.channelName}:${short(item.firstUnreadMessageId)}` : `dm:@${item.channelName}`;
  if (item.kind === "thread" && item.parentMessageId) return `#${item.channelName}:${short(item.parentMessageId)}`;
  return item.firstUnreadMessageId ? `#${item.channelName}:${short(item.firstUnreadMessageId)}` : `#${item.channelName}`;
}

async function loadRules(agentId: string): Promise<MatchRule[]> {
  const rows = await getDb().select().from(assistantContactRules).where(eq(assistantContactRules.agentId, agentId));
  return rows.map((row) => ({
    id: row.id, effect: row.effect, subjectKind: row.subjectKind, subjectId: row.subjectId,
    anytime: row.anytime, until: row.until, createdAt: row.createdAt, legacy: row.legacy ?? null,
  }));
}

async function toldSeqs(agentId: string, channelIds: string[], before: Date): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();
  const rows = await getDb()
    .select({ channelId: assistantTold.channelId, seq: sql<number>`max(${assistantTold.seq})::bigint` })
    .from(assistantTold)
    .where(and(
      eq(assistantTold.agentId, agentId),
      inArray(assistantTold.channelId, channelIds),
      sql`${assistantTold.via} NOT IN ('skipped', 'held')`,
      lt(assistantTold.toldAt, before),
    ))
    .groupBy(assistantTold.channelId);
  return new Map(rows.flatMap((row) => row.channelId && row.seq !== null ? [[row.channelId, Number(row.seq)] as const] : []));
}

/**
 * Notify the owner from a check. One check sends at most one DM: under a
 * per-assistant lock the first call decides, records what it shows as told and
 * stores the result and the DM's text on the check; the DM is then sent with
 * the check's own key. Any later call (a retry with the same or another key)
 * gets the stored result, and sends the stored DM only if it never went out
 * (a crash between deciding and sending). Calls for one assistant (a brief and
 * a doorbell at once) run one after another.
 */
export async function notifyOwner(input: Owner & {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  checkId: string;
  idempotencyKey: string;
  items: Array<{ channelId: string; summary: string; kind?: string }>;
  now?: Date;
}): Promise<NotifyResult> {
  const now = input.now ?? new Date();
  const o = { agentId: input.agentId, serverId: input.serverId, ownerUserId: input.ownerUserId };
  if (input.items.length > ASSISTANT_NOTIFY_ITEMS_MAX) {
    throw new AssistantNotifyError(400, "too_many_items", `At most ${ASSISTANT_NOTIFY_ITEMS_MAX} items.`);
  }
  const ownDmId = await channelService.findHumanAgentDmChannelId(o.serverId, o.ownerUserId, o.agentId);
  if (!ownDmId) throw new AssistantNotifyError(409, "owner_dm_unknown", "Your DM with your owner does not exist yet.");

  const decided = await getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`assistant-notify:${o.agentId}`}, 0))`);
    const [check] = await tx.select().from(assistantChecks).where(and(
      eq(assistantChecks.id, input.checkId),
      eq(assistantChecks.agentId, input.agentId),
      gt(assistantChecks.createdAt, new Date(now.getTime() - ASSISTANT_CHECK_TTL_MS)),
    )).limit(1);
    if (!check) throw new AssistantNotifyError(409, "check_unknown", "That check is unknown or too old: answer only the check you were woken for.");
    if (check.notifyResult) return { trigger: check.trigger, stored: check.notifyResult as unknown as StoredNotify, first: false };
    const stored = await decide(tx, o, input, check, now);
    await tx.update(assistantChecks).set({ notifyResult: stored as unknown as Record<string, unknown> }).where(eq(assistantChecks.id, check.id));
    return { trigger: check.trigger, stored, first: true };
  });

  if (decided.stored.content) {
    const sendKey = `notify:${input.checkId}`;
    const [sent] = await getDb().select({ id: messages.id }).from(messages).where(and(
      eq(messages.channelId, ownDmId),
      eq(messages.senderType, "agent"),
      eq(messages.senderId, o.agentId),
      eq(messages.agentSendKey, sendKey),
    )).limit(1);
    if (!sent) {
      const [agent] = await getDb().select({ name: agents.name, displayName: agents.displayName }).from(agents).where(eq(agents.id, o.agentId)).limit(1);
      // slack-bridge-ordinary-message-producer: assistant.notify
      await messageService.broadcastAndDeliver(input.io, input.orchestrator, {
        channelId: ownDmId,
        senderType: "agent",
        senderId: o.agentId,
        senderName: agent?.displayName || agent?.name || "Assistant",
        content: decided.stored.content,
        agentSendKey: sendKey,
      });
    }
  }
  return finish(input, decided.trigger, decided.stored.result, decided.first, decided.stored.toldRecorded);
}

type StoredNotify = { result: NotifyResult; content: string | null; toldRecorded?: number };
type Check = typeof assistantChecks.$inferSelect;

/** What a check's notify says and records (in the caller's transaction, under its lock). */
async function decide(
  tx: DatabaseExecutor,
  o: Owner,
  input: { items: Array<{ channelId: string; summary: string; kind?: string }> },
  check: Check,
  now: Date,
): Promise<StoredNotify> {
  const checkItems = check.items as unknown as CheckItem[];
  const byChannel = new Map(checkItems.map((item) => [item.channelId, item]));
  const dropped: NotifyResult["dropped"] = [];
  const written = new Map<string, { summary: string; kind: ContactItemKind | null }>();
  for (const given of input.items) {
    if (!byChannel.has(given.channelId)) { dropped.push({ channelId: given.channelId, reason: "not_in_check" }); continue; }
    if (written.has(given.channelId)) { dropped.push({ channelId: given.channelId, reason: "duplicate_item" }); continue; }
    const kind = RULE_KINDS.find((k) => k === given.kind) ?? null;
    written.set(given.channelId, { summary: clipSummary(given.summary), kind });
  }

  // What the owner can see now (a check lives 48 h): their access, and DMs only while they let the assistant read them.
  const visible = await channelService.filterUserAccessibleChannelIds(checkItems.map((item) => item.channelId), o.ownerUserId, asServerId(o.serverId));
  const dmPolicy = await readableOwnerDmPolicy({ agentId: o.agentId, serverId: o.serverId, ownerUserId: o.ownerUserId });
  const seeable = (item: CheckItem) => visible.has(item.channelId) && (!item.dm || dmPolicy !== null);


  const [rules, contact, told, language] = await Promise.all([
    loadRules(o.agentId),
    contactContext(o),
    // Only what was told before this check: a telling recorded since (by anyone) cannot drop its items.
    toldSeqs(o.agentId, checkItems.map((item) => item.channelId), check.createdAt),
    ownerLanguage(o),
  ]);
  const lines = assistantLines(language);
  const brief = check.trigger === "brief";
  const quiet = !brief && inQuietHours(now.getTime(), contact.zone, contact.quiet);
  type Ready = { item: CheckItem; line: string; reason: NotifyReason };
  const ready: Ready[] = [];
  const passedOver: CheckItem[] = [];
  let kept = 0;
  for (const item of checkItems) {
    if (!seeable(item)) { dropped.push({ channelId: item.channelId, reason: "not_visible" }); continue; }
    const toldSeq = told.get(item.channelId);
    if (toldSeq !== undefined && item.latestSeq !== null && item.latestSeq <= toldSeq) { dropped.push({ channelId: item.channelId, reason: "told" }); continue; }
    const w = written.get(item.channelId);
    // What the owner asked to hear (an always rule) is shown even when the model left it out.
    const ownerRule = item.why === "always" || item.why === "anytime";
    // Left out, or written with no words: the assistant judged it does not need the owner now.
    if (!ownerRule && !w?.summary) { passedOver.push(item); continue; }
    // The owner's kind rules hold for every line the model kept ("questions can wait": a digest kind rule).
    const rule = w?.kind ? winningRule(rules.filter((r) => r.subjectKind === "kind"), {
      channelId: item.channelId, parentChannelId: item.parentChannelId, thread: item.kind === "thread", dm: item.dm,
      mention: item.mention, senderId: item.senderId, kind: w.kind,
    }, now) : null;
    if (rule?.effect === "mute") { dropped.push({ channelId: item.channelId, reason: "rule_mute" }); continue; }
    // Held: not sent now and not recorded, so the brief's query finds it again.
    if (!brief && (rule?.effect === "digest" || (quiet && item.why !== "anytime"))) { kept++; continue; }
    const line = w?.summary || lines.fallback(item.latestSenderName, item.dm ? `dm:@${item.channelName}` : `#${item.channelName}`);
    // The model's kind when it wrote one; else the owner's rule is why it went out.
    const reason: NotifyReason = w?.kind ? REASON_OF_KIND[w.kind] : ownerRule ? "owner_rule" : "unstated";
    ready.push({ item, line: `${line.replace(/[\s.,;:]+$/, "")}: ${itemRef(item)}`, reason });
  }
  // What the assistant passed over stays in the owner's inbox: held (a `named` one: skipped), so a doorbell
  // does not offer it again until it moves; the brief and "more" list it.
  for (const item of passedOver) await recordToldAt(tx, o, item, item.why === "named" ? "skipped" : "held", now);

  if (ready.length === 0) {
    return { result: { outcome: kept > 0 ? "kept_for_brief" : "nothing_to_send", shown: 0, more: 0, dropped }, content: null };
  }
  // @mentions and DMs first, then the rest in the check's order (most recent first).
  const rank = (r: Ready) => (r.item.mention || r.item.dm ? 0 : 1);
  const ordered = ready.map((r, n) => ({ r, n })).sort((a, b) => rank(a.r) - rank(b.r) || a.n - b.n).map((x) => x.r);
  const shown = ordered.slice(0, ASSISTANT_NOTIFY_SHOWN_MAX);
  const held = ordered.slice(ASSISTANT_NOTIFY_SHOWN_MAX);
  const heldBack = held.length;
  const reasons: Partial<Record<NotifyReason, number>> = {};
  for (const r of ordered) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  const body = shown.map((r) => r.line);
  if (heldBack > 0) body.push(lines.more(heldBack, moreWhere(held.map((r) => r.item))));
  if (brief) body[0] = `${lines.morning} ${body[0]}`;
  // Once, in a brief, while Raft knows no zone for the owner.
  const askZone = brief && await shouldAskZone(o);
  if (askZone) {
    body.push(lines.askZone);
    await tx.update(assistantCheckState).set({ askedTimezone: true, updatedAt: now }).where(eq(assistantCheckState.agentId, o.agentId));
  }
  // What is shown is told, up to each conversation's latest activity; what "N more" counts is held there.
  let toldRecorded = 0;
  for (const r of shown) if (await recordToldAt(tx, o, r.item, "notify", now)) toldRecorded += 1;
  for (const r of held) await recordToldAt(tx, o, r.item, "held", now);
  return { result: { outcome: "sent", shown: shown.length, more: heldBack, dropped, reasons }, content: body.join("\n"), toldRecorded };
}

/** Where the held-back items are, the busiest places first, at most three (the line ends in "…" for the rest). */
export function moreWhere(items: readonly CheckItem[]): MoreWhere[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const place = item.dm ? `dm:@${item.channelName}` : `#${item.channelName}`;
    counts.set(place, (counts.get(place) ?? 0) + 1);
  }
  return [...counts].map(([place, count]) => ({ place, count })).sort((a, b) => b.count - a.count).slice(0, MORE_WHERE_MAX);
}
const MORE_WHERE_MAX = 3;

async function shouldAskZone(o: Owner): Promise<boolean> {
  const [state] = await getDb().select({ asked: assistantCheckState.askedTimezone }).from(assistantCheckState).where(eq(assistantCheckState.agentId, o.agentId)).limit(1);
  if (state?.asked) return false;
  const of = await describeAssistantOf({ id: o.agentId, serverId: o.serverId, assistantOwnerUserId: o.ownerUserId });
  if (of?.timezone) return false;
  const [settings] = await getDb().select({ zone: assistantContactSettings.statedTimezone }).from(assistantContactSettings).where(eq(assistantContactSettings.agentId, o.agentId)).limit(1);
  return !settings?.zone;
}

/**
 * Record a telling (or a skip or a hold) for an item at its conversation's
 * latest activity. A telling is keyed by its first unread message, else the
 * message at its latest seq; a skip or a hold always by the message at its
 * latest seq, so it never lands on (and moves up) an earlier telling's row: a
 * conversation told at 10 and skipped at 15 stays told only up to 10. Neither
 * ever downgrades a telling, and a skip never downgrades a hold.
 */
async function recordToldAt(tx: DatabaseExecutor, o: Owner, item: CheckItem, via: "notify" | "skipped" | "held", now: Date): Promise<boolean> {
  if (item.latestSeq === null) return false;
  let messageId = via === "notify" ? item.firstUnreadMessageId : null;
  if (!messageId) {
    const [latest] = await tx.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.channelId, item.channelId), eq(messages.seq, item.latestSeq))).limit(1);
    messageId = latest?.id ?? null;
  }
  if (!messageId) return false;
  await tx.insert(assistantTold)
    .values({ agentId: o.agentId, messageId, channelId: item.channelId, seq: item.latestSeq, via, toldAt: now })
    .onConflictDoUpdate({
      target: [assistantTold.agentId, assistantTold.messageId],
      set: {
        via: sql`CASE WHEN ${VIA_RANK(sql`${assistantTold.via}`)} > ${VIA_RANK(sql`excluded.via`)} THEN ${assistantTold.via} ELSE excluded.via END`,
        toldAt: now,
        channelId: item.channelId,
        seq: sql`greatest(coalesce(${assistantTold.seq}, 0), ${item.latestSeq})`,
      },
    });
  return true;
}

const VIA_RANK = (via: ReturnType<typeof sql>) => sql`(CASE ${via} WHEN 'skipped' THEN 0 WHEN 'held' THEN 1 ELSE 2 END)`;

function finish(input: { agentId: string; checkId: string; items: unknown[] }, trigger: string, result: NotifyResult, first: boolean, toldRecorded?: number): NotifyResult {
  const byReason: Record<string, number> = {};
  for (const d of result.dropped) byReason[`dropped_${d.reason}`] = (byReason[`dropped_${d.reason}`] ?? 0) + 1;
  // Why what went out reached the owner (sent lines, shown or counted in "N more"), by reason.
  for (const [reason, n] of Object.entries(result.reasons ?? {})) byReason[`reason_${reason}`] = n;
  recordTraceEvent("server.assistant.notify", {
    agent_id: input.agentId,
    check_id: input.checkId,
    trigger,
    // A repeat call for an answered check: the stored result comes back, and the trace says it was a repeat.
    outcome: first ? result.outcome : "duplicate",
    items_given: input.items.length,
    items_sent: result.shown,
    held_back: result.more,
    // Sent lines that wrote their telling (should equal items_sent; a gap is a line told without a record).
    ...(first && toldRecorded !== undefined ? { told_recorded: toldRecorded } : {}),
    ...byReason,
  });
  return result;
}
