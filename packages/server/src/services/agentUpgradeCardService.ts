// Agent upgrade cards (`plan:upgrade`, task #6 #proj-apps; decided by cindyz
// and Till, #proj-commercial:fa731606). An agent offers Pro to a person who
// needs it, usually after a Free limit, with an action card; its button opens
// the web's existing upgrade dialog, so the card itself executes nothing.
//
// actionCardsService.prepareActionCard enforces the rules with the reads
// below: the Free plan, not in a shared channel; a repeat for the same
// conversation and gate within a day answers with the card already there; and
// after an agent's upgrade card of any gate, the conversation gets no other
// one for a cooldown (14 days; cindyz #proj-apps:5eafd481: don't disturb
// people), which a card deleted since still holds. No flag gates any of it
// (`agent_upgrade_card` is retired, #raft-architecture:#32).
// `agentUpgradeCardHint` is the line Till's 30-day read-limit messages append for agents, and the next
// action of an agent's upload a Free limit refused; it says nothing where the
// deployment has no billing configured, while the server pays, or the
// conversation is shared, nor to a client that cannot post
// the card (an older CLI refuses `plan:upgrade` locally; one that can declares
// PLAN_UPGRADE_CARD_CAPABILITY, or its agent's Computer runs 1.0.53 or later,
// whose CLI posts it but declares nothing), nor during the cooldown.

import { isStripeConfigured } from "./billingService";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  compareComputerVersions,
  currentDate,
  GENERAL_UPGRADE_GATE,
  hasPlanUpgradeCardCapability,
  isComputerSemver,
  isSubConversationType,
  type ActionCardMetadata,
  type UpgradeGate,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { actionCards, agents, channels, jointChannelServers, machines, messages } from "../db/schema";
import { getServerBillingEntitlement } from "./planService";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A repeat `plan:upgrade` for the same conversation and gate inside this window answers with the posted card. */
export const AGENT_UPGRADE_CARD_REPEAT_WINDOW_MS = DAY_MS;

/**
 * After an agent's upgrade card in a conversation, the days during which no
 * other one goes there (any gate). "14d is a guess" (cindyz): the retired
 * `agent_upgrade_card` flag's variant (`cooldown_days:<n>`) could tune it, but
 * production set none (2026-11-12), so it is fixed now; changing it is a
 * release (#raft-architecture:#32).
 */
export const AGENT_UPGRADE_CARD_COOLDOWN_DAYS = 14;

/**
 * Whether the server is on Free, by its billing entitlement (an entitling
 * subscription first, then the server row): the same plan Plan & Billing
 * shows, which the web's card reads too.
 */
export async function isServerOnFreePlan(serverId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  return (await getServerBillingEntitlement(executor, serverId)).plan === "free";
}

/**
 * Whether a conversation is shared with another server: a joint channel, or a
 * thread or task conversation of one (a local face of the joint's canonical
 * conversation, which only a joint projection row links to). DMs are never
 * joint. Upgrade cards stay out of these: a peer server's people would see the
 * card, and its button opens this server's upgrade dialog (Tenny).
 */
export async function isJointConversation(channelId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  const [channel] = await executor
    .select({ type: channels.type })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!channel) return false;
  if (channel.type === "joint") return true;
  if (!isSubConversationType(channel.type)) return false;
  const [projection] = await executor
    .select({ jointChannelId: jointChannelServers.jointChannelId })
    .from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, channelId))
    .limit(1);
  return Boolean(projection);
}

/**
 * The `plan:upgrade` card for this gate posted in this conversation (the
 * carrier's storage channel: a channel, DM or thread) in the last 24 hours,
 * newest first. A card without a gate counts as `general`. Call it under the
 * prepare transaction's source lock, so two concurrent prepares cannot both
 * miss it.
 */
export async function findRecentAgentUpgradeCard(
  executor: DatabaseExecutor,
  input: { serverId: string; storageChannelId: string; gate: UpgradeGate; now?: Date },
): Promise<{ messageId: string; metadata: ActionCardMetadata } | null> {
  const since = new Date((input.now ?? currentDate()).getTime() - AGENT_UPGRADE_CARD_REPEAT_WINDOW_MS);
  const [row] = await executor
    .select({ messageId: actionCards.messageId, metadata: messages.actionMetadata })
    .from(actionCards)
    .innerJoin(messages, eq(messages.id, actionCards.messageId))
    .where(and(
      eq(actionCards.serverId, input.serverId),
      eq(actionCards.actionType, "plan:upgrade"),
      sql`coalesce(${actionCards.payload} ->> 'gate', ${GENERAL_UPGRADE_GATE}) = ${input.gate}`,
      eq(messages.channelId, input.storageChannelId),
      isNull(messages.deletedAt),
      gt(actionCards.createdAt, since),
    ))
    .orderBy(desc(actionCards.createdAt))
    .limit(1);
  const metadata = (row?.metadata ?? null) as ActionCardMetadata | null;
  if (!row || metadata?.kind !== "action-card") return null;
  return { messageId: row.messageId, metadata };
}

/** A conversation's upgrade-card cooldown: since the newest agent upgrade card there. */
export interface AgentUpgradeCardCooldown {
  /** When that card was posted (`action_cards.created_at`). */
  offeredAt: Date;
  /** When the cooldown is over: `offeredAt` plus the cooldown days. */
  endsAt: Date;
}

/**
 * The cooldown a conversation (the carrier's storage channel: a channel, DM
 * or thread) is in: since the newest `plan:upgrade` card an agent posted there,
 * of any gate, in the last AGENT_UPGRADE_CARD_COOLDOWN_DAYS (by
 * `action_cards.created_at`), whether or not its message was deleted since
 * (someone deleting the card is no reason to show another). Null when there is none. Only an agent's card
 * counts: its carrier message must be the agent's (`sender_type` agent), so a
 * member's request for Pro (a person's plan:upgrade card, sent as them; task
 * #10) does not. One read. In prepare, call it under the transaction's source
 * lock, so two concurrent prepares cannot both pass.
 */
export async function findAgentUpgradeCardCooldown(
  executor: DatabaseExecutor,
  input: { serverId: string; storageChannelId: string; now?: Date },
): Promise<AgentUpgradeCardCooldown | null> {
  const windowMs = AGENT_UPGRADE_CARD_COOLDOWN_DAYS * DAY_MS;
  const since = new Date((input.now ?? currentDate()).getTime() - windowMs);
  const [row] = await executor
    .select({ createdAt: actionCards.createdAt })
    .from(actionCards)
    .innerJoin(messages, eq(messages.id, actionCards.messageId))
    .where(and(
      eq(actionCards.serverId, input.serverId),
      eq(actionCards.actionType, "plan:upgrade"),
      eq(messages.channelId, input.storageChannelId),
      eq(messages.senderType, "agent"),
      gt(actionCards.createdAt, since),
    ))
    .orderBy(desc(actionCards.createdAt))
    .limit(1);
  if (!row) return null;
  return { offeredAt: row.createdAt, endsAt: new Date(row.createdAt.getTime() + windowMs) };
}

/** A UTC calendar date, YYYY-MM-DD. */
function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The 409 UPGRADE_CARD_COOLDOWN refusal's words (agreed with Sage): `error`,
 * the rule and what to do instead, since a CLI from Computer 1.0.53 (the only
 * one that posts this card today) prints only `error`; `suggestedNextAction`,
 * all the agent needs: when the
 * last card was offered, the first UTC day on which another may be (the day
 * after the cooldown ends, unless it ends at midnight, so the date is never
 * early), and what to do instead. No command: there is nothing to run.
 */
export function agentUpgradeCardCooldownRefusal(cooldown: AgentUpgradeCardCooldown): { error: string; suggestedNextAction: string } {
  const notBefore = new Date(Math.ceil(cooldown.endsAt.getTime() / DAY_MS) * DAY_MS);
  return {
    error: `An upgrade card was already offered in this conversation in the last ${AGENT_UPGRADE_CARD_COOLDOWN_DAYS} days: don't offer another; say in the conversation what the limit is and why, without a card.`,
    suggestedNextAction: `An upgrade card was already offered here on ${utcDate(cooldown.offeredAt)}. Don't offer another before ${utcDate(notBefore)}; say in the conversation what the limit is and why, without a card.`,
  };
}

/**
 * The oldest Computer whose bundled CLI posts `plan:upgrade` (computer-v1.0.53
 * added the type to the action types `raft action prepare` checks locally).
 * It declares no PLAN_UPGRADE_CARD_CAPABILITY, so its version stands in.
 */
export const PLAN_UPGRADE_CARD_MIN_COMPUTER_VERSION = "1.0.53";

/** Who would run a hinted `raft action prepare`: what its request declared, and the acting agent. */
export interface UpgradeCardClient {
  /** The request's `X-Raft-Client-Capabilities` value (undefined when it sent none). */
  capabilities: string | undefined;
  agentId: string;
}

/**
 * Whether the client can post a `plan:upgrade` card: it declares
 * PLAN_UPGRADE_CARD_CAPABILITY, or else the agent's Computer last reported a
 * version at or above PLAN_UPGRADE_CARD_MIN_COMPUTER_VERSION by SemVer
 * precedence (1.0.54-rc.1 is; 1.0.53-rc.1 and the staging builds before the
 * 1.0.53 release are not, so a build that may lack the type never gets the
 * hint). No declaration and no known version (no Computer, an older daemon, a
 * version that is not SemVer) is not capable. One read, and only without a
 * declaration.
 */
export async function canClientPostUpgradeCard(client: UpgradeCardClient, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  if (hasPlanUpgradeCardCapability(client.capabilities)) return true;
  const [row] = await executor
    .select({ computerVersion: machines.computerVersion })
    .from(agents)
    .innerJoin(machines, eq(machines.id, agents.machineId))
    .where(eq(agents.id, client.agentId))
    .limit(1);
  const version = row?.computerVersion?.trim() ?? "";
  return isComputerSemver(version) && compareComputerVersions(version, PLAN_UPGRADE_CARD_MIN_COMPUTER_VERSION) >= 0;
}

/** What an upload refused at each upload gate ran into, after "this server is on the Free plan and". */
const UPLOAD_GATE_LIMITS = {
  upload_monthly_quota: "has used this month's upload allowance",
  upload_file_size: "the file is over the Free plan's per-file limit",
} as const satisfies Partial<Record<UpgradeGate, string>>;

/**
 * What an upload gate's card offer says was refused: an attachment's file
 * (`file`, the default), or an Artifacts write's: a push's files, a file
 * saved as an Artifact, a comment's image (platform/fileUploadQuota
 * agentQuotaUpgradeHint).
 */
export type UpgradeCardUploadSubject = "file" | "files" | "saved_file" | "image";

/** Each subject's words: the lead, the pronoun Pro takes, what the agent says, and what the card's reason is about. */
const UPLOAD_SUBJECT_WORDS = {
  file: { lead: "The file was not uploaded", it: "it", say: "the file wasn't uploaded", purpose: "what the file is for" },
  files: { lead: "The files were not stored", it: "them", say: "the files weren't stored", purpose: "what the files are for" },
  saved_file: { lead: "The file was not saved", it: "it", say: "the file wasn't saved", purpose: "what the file is for" },
  image: { lead: "The image was not stored", it: "it", say: "the image wasn't stored", purpose: "what the image is for" },
} as const satisfies Record<UpgradeCardUploadSubject, { lead: string; it: string; say: string; purpose: string }>;

/** The delimiter `raft action prepare`'s own heredoc example uses (packages/cli action prepare). */
const ACTION_HEREDOC_DELIMITER = "RAFTACTION";

function isUploadGate(gate: UpgradeGate): gate is keyof typeof UPLOAD_GATE_LIMITS {
  return Object.hasOwn(UPLOAD_GATE_LIMITS, gate);
}

/**
 * The line an agent-facing Free-limit message can end with, offering an
 * upgrade card for `gate` in `target` (a conversation target as the agent
 * writes it, e.g. `#general` or `dm:@alice`), which names the conversation
 * `channelId` on this server (the channel, DM or thread the agent read).
 * Null where the deployment has no billing configured (isStripeConfigured),
 * while the server is not on Free, or the conversation is shared with
 * another server (a joint channel or a thread of one), where prepare would
 * refuse the card; and null for a `client` that cannot post the card
 * (canClientPostUpgradeCard: an older CLI refuses `plan:upgrade` locally) or
 * while the conversation is in its upgrade-card cooldown
 * (findAgentUpgradeCardCooldown), where prepare would refuse it; the message
 * then keeps its old next action (an upload's billing line; nothing for a
 * history read).
 * The client is checked after the server's conditions and the cooldown (one
 * read) last: the client check costs nothing for the current CLI (it declares
 * the capability), and for an undeclared client it most often ends the hint
 * (an older CLI) before the cooldown's read. The example's
 * `reason` is a `<…>` placeholder for the agent's own sentence (the schema
 * refuses it posted as is). The target is quoted so the command survives a
 * shell (`#` would start a comment).
 *
 * An upload gate's line is the next action outright: the file was not
 * uploaded and why (`uploadSubject` names what else was refused, if not an
 * attachment's file), which the agent says in the conversation; then, where
 * suggesting Pro would help the person, a card it may offer, the `<…>`
 * replaced with what the file is for (whether someone asked for the file or
 * the agent shares it unasked). Offering one is the agent's call: Raft never
 * requires payment, it suggests a person consider it (cindyz). Then the
 * command, a heredoc that runs once the agent writes the reason (unindented,
 * so its delimiter closes it; quoted, so nothing in the JSON expands). Any other
 * gate (the 30-day history: a read the agent may not need, often a runtime
 * prefetch) only says it can offer one, piping the JSON in with a heredoc as
 * `raft message send` does, never `echo '…'`: an apostrophe in the agent's
 * reason would end a single-quoted string.
 */
/**
 * The upgrade-card sentence after an agent search's hidden-matches line (task
 * #proj-commercial:#24, F). A search has no conversation, so the agent names
 * the one where the person asked, and the per-conversation cooldown is not
 * checked here: `raft action prepare` refuses during it
 * (actionCardsService, agentUpgradeCardCooldownRefusal). Null where
 * agentUpgradeCardHint's server and client checks give none.
 */
export async function agentSearchUpgradeCardHint(input: { serverId: string; client: UpgradeCardClient }): Promise<string | null> {
  if (!isStripeConfigured()) return null;
  if (!await isServerOnFreePlan(input.serverId)) return null;
  if (!await canClientPostUpgradeCard(input.client)) return null;
  const card = JSON.stringify({
    type: "plan:upgrade",
    gate: "history_30d",
    reason: "<one sentence: why they need the older messages>",
  });
  return `If someone asked you for these, you can offer an upgrade card in their conversation: pipe ${card} into raft action prepare --target "<their conversation>" (a heredoc, as with raft message send).`;
}

export async function agentUpgradeCardHint(input: {
  serverId: string;
  gate: UpgradeGate;
  target: string;
  channelId: string;
  client: UpgradeCardClient;
  /** An upload gate's: what was refused (default `file`, an attachment's). */
  uploadSubject?: UpgradeCardUploadSubject;
}): Promise<string | null> {
  // No billing, no purchase card (prepare refuses it too: actionCardsService).
  if (!isStripeConfigured()) return null;
  if (!await isServerOnFreePlan(input.serverId)) return null;
  if (await isJointConversation(input.channelId)) return null;
  if (!await canClientPostUpgradeCard(input.client)) return null;
  // Not shared, so the conversation stores its own messages: `channelId` is its storage channel.
  const cooldown = await findAgentUpgradeCardCooldown(getDb(), {
    serverId: input.serverId,
    storageChannelId: input.channelId,
  });
  if (cooldown) return null;
  if (isUploadGate(input.gate)) {
    const words = UPLOAD_SUBJECT_WORDS[input.uploadSubject ?? "file"];
    const uploadCard = JSON.stringify({
      type: "plan:upgrade",
      gate: input.gate,
      reason: `<one sentence: ${words.purpose}>`,
    });
    return [
      `${words.lead}: this server is on the Free plan and ${UPLOAD_GATE_LIMITS[input.gate]}. Pro would take ${words.it}. Say in the conversation that ${words.say} and why, then offer an upgrade card unless that is clearly out of place here (put ${words.purpose} in place of the <…>):`,
      `raft action prepare --target "${input.target}" <<'${ACTION_HEREDOC_DELIMITER}'`,
      uploadCard,
      ACTION_HEREDOC_DELIMITER,
    ].join("\n");
  }
  const history = input.gate === "history_30d";
  const lead = history
    ? "If someone here needs these older messages"
    : "If someone here needs more than the Free plan allows";
  const card = JSON.stringify({
    type: "plan:upgrade",
    gate: input.gate,
    reason: history ? "<one sentence: why they need the older messages>" : "<one sentence: why they need Pro>",
  });
  return `${lead}, you can offer an upgrade card: pipe ${card} into raft action prepare --target "${input.target}" (a heredoc, as with raft message send).`;
}
