import { publishChannelUpdate } from "./channelRealtimeEvents";
import { AGENT_KIND_RULES, agentKindOf } from "./agentMemberListPolicy";
import { socketUserServerRoom } from "../socket/platformScope";
import { ALL_CHANNEL_TEAM_THRESHOLD, currentDate, isExternalAgentRuntime, referralSourceLabel, signupRoleLabel } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { getDb } from "../db/index";
import * as agentService from "./agentService";
import * as channelService from "./channelService";
import * as messageService from "./messageService";
import * as serverService from "./serverService";
import {
  buildServerAttachmentStorageKey,
  canWriteDedicatedAttachmentKeys,
  getStorage,
} from "./storageService";
import * as userService from "./userService";
import { createAppReminder } from "../apps/reminder/crud";
import { getHostedOnboardingAgentState } from "./hostedCindyService";
import { computeNextFire, type Recurrence } from "./recurrence";
import { OWNER_OPENER_TEAM_MODE_HTML } from "./ownerOpenerArtifactHtml";
import { createIdempotentPendingAttachmentProjectionWithExecutor } from "./attachmentProjectionWriterService";
import {
  buildAttachmentTransferArtifactPlan,
  createAttachmentTransferIntent,
} from "./attachmentTransferIntentService";
import { ATTACHMENT_TRANSFER_INTENT_TTL_MS } from "./attachmentUploadWriterService";
import { attachmentTransferArtifacts } from "../db/schema";

const OWNER_OPENER_V2_VERSION = "owner-opener-v2.0";
const OWNER_OPENER_V2_TOPICS = [
  "language_preference",
  "team_mode_artifact",
  "message_like_teammates",
  "workflow_migration_or_create_agent_card",
];

export const ONBOARDING_DAY2_RECAP_VERSION = "onboarding-d2-recap-v2";
export const ONBOARDING_DAY2_RECAP_TITLE =
  "D2 recap: explain wake; recap yesterday; next step; ask about daily recap.";

type OnboardingOwnerTimezone = {
  preferredTimezone?: string | null;
  firstObservedTimezone?: string | null;
};

function isUsableTimezone(timezone: string | null | undefined): timezone is string {
  if (!timezone?.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function resolveOnboardingDay2Timezone(owner: OnboardingOwnerTimezone): string {
  if (isUsableTimezone(owner.preferredTimezone)) return owner.preferredTimezone;
  if (isUsableTimezone(owner.firstObservedTimezone)) return owner.firstObservedTimezone;
  return "UTC";
}

function zonedDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

/** The next calendar day's 10:00 in the owner's snapshotted timezone. */
export function computeOnboardingDay2FireAt(openerSentAt: Date, timezone: string): Date {
  const safeTimezone = isUsableTimezone(timezone) ? timezone : "UTC";
  const tenAmDaily: Recurrence = {
    version: 1,
    rule: { kind: "daily", hour: 10, minute: 0, tz: safeTimezone },
  };
  let fireAt = computeNextFire(tenAmDaily, openerSentAt);
  if (zonedDateKey(fireAt, safeTimezone) === zonedDateKey(openerSentAt, safeTimezone)) {
    fireAt = computeNextFire(tenAmDaily, fireAt);
  }
  return fireAt;
}

export function onboardingDay2ReminderId(serverId: string, ownerId: string): string {
  return stableUuid(`${ONBOARDING_DAY2_RECAP_VERSION}:${serverId}:${ownerId}:day-2`);
}

type OwnerOpenerArtifactAttachment = {
  id: string;
  filename: string;
};

type OnboardingServiceDeps = {
  getAgent: typeof agentService.getAgent;
  listAgents: typeof agentService.listAgents;
  listServerMemberIds: typeof serverService.listServerMemberIds;
  tryMarkAllChannelIntroSent: typeof agentService.tryMarkAllChannelIntroSent;
  clearAllChannelIntroSentClaim: typeof agentService.clearAllChannelIntroSentClaim;
  listChannels: typeof channelService.listChannels;
  createChannel: typeof channelService.createChannel;
  getOrCreateThread: typeof channelService.getOrCreateThread;
  addHuman: typeof channelService.addHuman;
  addAgent: typeof channelService.addAgent;
  findOrCreateDM: typeof channelService.findOrCreateDM;
  broadcastSystemMessage: typeof messageService.broadcastSystemMessage;
  deliverSystemNoticeToAgent: typeof messageService.deliverSystemNoticeToAgent;
  broadcastAndDeliver: typeof messageService.broadcastAndDeliver;
  createOwnerOpenerArtifactAttachment: (input: {
    serverId: string;
    channelId: string;
    onboardingAgentId: string;
    targetUserId: string;
  }) => Promise<OwnerOpenerArtifactAttachment>;
  getServer: typeof serverService.getServer;
  getServerOnboardingSettings: typeof serverService.getServerOnboardingSettings;
  updateServerOnboardingAgent: typeof serverService.updateServerOnboardingAgent;
  getMemberOnboardingPreferences: typeof serverService.getMemberOnboardingPreferences;
  updateMemberOnboardingPreferences: typeof serverService.updateMemberOnboardingPreferences;
  tryClaimAllChannelUnlockInstruction: typeof serverService.tryClaimAllChannelUnlockInstruction;
  clearAllChannelUnlockInstructionClaim: typeof serverService.clearAllChannelUnlockInstructionClaim;
  getUser: typeof userService.getUser;
  getHostedOnboardingAgentState: typeof getHostedOnboardingAgentState;
  claimOwnerOpener: typeof serverService.claimOwnerOpener;
  releaseOwnerOpenerClaim: typeof serverService.releaseOwnerOpenerClaim;
  createSchedule: typeof createAppReminder;
};

const defaultOnboardingServiceDeps: OnboardingServiceDeps = {
  getAgent: agentService.getAgent,
  listAgents: agentService.listAgents,
  listServerMemberIds: serverService.listServerMemberIds,
  tryMarkAllChannelIntroSent: agentService.tryMarkAllChannelIntroSent,
  clearAllChannelIntroSentClaim: agentService.clearAllChannelIntroSentClaim,
  listChannels: channelService.listChannels,
  createChannel: channelService.createChannel,
  getOrCreateThread: channelService.getOrCreateThread,
  addHuman: channelService.addHuman,
  addAgent: channelService.addAgent,
  findOrCreateDM: channelService.findOrCreateDM,
  broadcastSystemMessage: messageService.broadcastSystemMessage,
  deliverSystemNoticeToAgent: messageService.deliverSystemNoticeToAgent,
  broadcastAndDeliver: messageService.broadcastAndDeliver,
  createOwnerOpenerArtifactAttachment,
  getServer: serverService.getServer,
  getServerOnboardingSettings: serverService.getServerOnboardingSettings,
  updateServerOnboardingAgent: serverService.updateServerOnboardingAgent,
  getMemberOnboardingPreferences: serverService.getMemberOnboardingPreferences,
  updateMemberOnboardingPreferences: serverService.updateMemberOnboardingPreferences,
  tryClaimAllChannelUnlockInstruction: serverService.tryClaimAllChannelUnlockInstruction,
  clearAllChannelUnlockInstructionClaim: serverService.clearAllChannelUnlockInstructionClaim,
  getUser: userService.getUser,
  getHostedOnboardingAgentState,
  claimOwnerOpener: serverService.claimOwnerOpener,
  releaseOwnerOpenerClaim: serverService.releaseOwnerOpenerClaim,
  createSchedule: createAppReminder,
};

let onboardingServiceDepsOverride: Partial<OnboardingServiceDeps> | null = null;

function resolveOnboardingServiceDeps(): OnboardingServiceDeps {
  return {
    ...defaultOnboardingServiceDeps,
    ...(onboardingServiceDepsOverride ?? {}),
  };
}

export function __setOnboardingServiceDepsForTests(overrides: Partial<OnboardingServiceDeps>) {
  onboardingServiceDepsOverride = overrides;
}

export function __resetOnboardingServiceDepsForTests() {
  onboardingServiceDepsOverride = null;
}

export function isOwnerOnboardingActivationEligible(
  serverOnboardingAgentId: string | null | undefined,
  activatedAgentId: string,
): boolean {
  return !!serverOnboardingAgentId && serverOnboardingAgentId === activatedAgentId;
}

function buildTeamModeArtifactHtml() {
  return OWNER_OPENER_TEAM_MODE_HTML;
}
function stableUuid(input: string) {
  const hex = createHash("sha256").update(input).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

async function ensureOnboardingDay2Reminder(input: {
  deps: OnboardingServiceDeps;
  orchestrator: AgentOrchestrator;
  serverId: string;
  ownerId: string;
  onboardingAgentId: string;
  openerSentAt: Date;
  anchorMsgId: string | undefined;
  targetChannelId: string | undefined;
  owner: OnboardingOwnerTimezone;
}): Promise<boolean> {
  if (!input.anchorMsgId || !input.targetChannelId) return false;

  const timezone = resolveOnboardingDay2Timezone(input.owner);
  const row = await input.deps.createSchedule({
    id: onboardingDay2ReminderId(input.serverId, input.ownerId),
    serverId: input.serverId,
    ownerAgentId: input.onboardingAgentId,
    targetChannelId: input.targetChannelId,
    msgId: input.anchorMsgId,
    title: ONBOARDING_DAY2_RECAP_TITLE,
    fireAt: computeOnboardingDay2FireAt(input.openerSentAt, timezone),
    payload: {
      kind: "onboarding_d2_recap",
      version: ONBOARDING_DAY2_RECAP_VERSION,
      ownerId: input.ownerId,
      timezone,
      windowStartAt: input.openerSentAt.toISOString(),
    },
    createdBy: { type: "agent", id: input.onboardingAgentId },
  });
  try {
    await input.orchestrator.pushReminderUpsert(row.ownerAgentId, row);
  } catch (error) {
    // The lifecycle row remains authoritative. Its pending arm state makes the
    // watchdog retry without turning onboarding into a Server-side fire path.
    console.warn(`[Onboarding] Failed to sync D2 reminder ${row.id}@${row.version}:`, error);
  }
  return true;
}

/**
 * The key the owner opener's HTML is written under. A replay keeps the key its
 * first attempt persisted (an opener made before the move stays where it is);
 * a fresh one takes an `attachments/v2/` key where the dedicated attachment
 * bucket exists, so it no longer lands in the legacy bucket.
 */
export function ownerOpenerStorageKey(input: {
  persisted: string | null;
  dedicated: boolean;
  serverId: string;
  id: string;
  objectId: string;
}): string {
  if (input.persisted) return input.persisted;
  return input.dedicated
    ? buildServerAttachmentStorageKey(input.serverId, input.id, input.objectId, ".html")
    : `${input.serverId}/onboarding/${input.id}.html`;
}

async function createOwnerOpenerArtifactAttachment(input: {
  serverId: string;
  channelId: string;
  onboardingAgentId: string;
  targetUserId: string;
}): Promise<OwnerOpenerArtifactAttachment> {
  const storage = getStorage();
  if (!storage) {
    throw new Error("Attachment storage is not configured for onboarding opener v2");
  }

  const html = buildTeamModeArtifactHtml();
  const buffer = Buffer.from(html, "utf8");
  const id = stableUuid(`${OWNER_OPENER_V2_VERSION}:${input.serverId}:${input.targetUserId}:team-mode`);
  const filename = "team-mode.html";
  const mimeType = "text/html";
  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const objectId = stableUuid(`${OWNER_OPENER_V2_VERSION}:${input.serverId}:${input.targetUserId}:team-mode:object`);
  const transferIntentId = stableUuid(`${OWNER_OPENER_V2_VERSION}:${input.serverId}:${input.targetUserId}:team-mode:transfer`);
  const [persistedOriginal] = await getDb().select({ storageKey: attachmentTransferArtifacts.storageKey })
    .from(attachmentTransferArtifacts)
    .where(and(
      eq(attachmentTransferArtifacts.intentId, transferIntentId),
      eq(attachmentTransferArtifacts.role, "original"),
    ))
    .limit(1);
  const storageKey = ownerOpenerStorageKey({
    persisted: persistedOriginal?.storageKey ?? null,
    dedicated: canWriteDedicatedAttachmentKeys(),
    serverId: input.serverId,
    id,
    objectId,
  });
  const now = currentDate();

  await createAttachmentTransferIntent({
    id: transferIntentId,
    reservationId: id,
    objectId,
    serverId: input.serverId,
    channelId: input.channelId,
    uploaderId: input.onboardingAgentId,
    uploaderType: "agent",
    filename,
    mimeType,
    declaredSizeBytes: buffer.length,
    expiresAt: new Date(now.getTime() + ATTACHMENT_TRANSFER_INTENT_TTL_MS),
    artifacts: buildAttachmentTransferArtifactPlan({ storageKey, mimeType }),
  }, getDb(), now);

  await storage.put(storageKey, buffer, "text/html; charset=utf-8");

  const attachment = await getDb().transaction((tx) =>
    createIdempotentPendingAttachmentProjectionWithExecutor(tx, {
      id,
      objectId,
      transferIntentId,
      serverId: input.serverId,
      channelId: input.channelId,
      uploaderId: input.onboardingAgentId,
      uploaderType: "agent",
      filename,
      mimeType,
      sizeBytes: buffer.length,
      storageKey,
      contentHash,
    }),
  );
  return { id: attachment.id, filename: attachment.filename };
}

function buildMemberOnboardingInstruction(
  userName: string,
  locationHint: string,
  roleLabel?: string | null,
) {
  return [
    "Onboarding task (system-triggered):",
    "This is a new human member onboarding.",
    `Please proactively onboard @${userName} in ${locationHint}.`,
    // The signup survey asked them what they do. Hand it over, so the answer buys
    // them something instead of just landing in a table.
    ...(roleLabel ? [`They told us their role is: ${roleLabel}. Pitch Raft and pick a starting point that fits that.`] : []),
    "Default language is English; first ask what language they prefer.",
    "Goals (soft guidance, do not force):",
    "1) Help them understand what Raft is and what this server is for.",
    "2) Introduce relevant humans/channels/agents for their current work (not a full catalog dump).",
    "3) Suggest where they should start collaborating right away.",
    "Do NOT ask them to set up the server or create agents/channels.",
    "If they are already working on a concrete task, keep onboarding lightweight and adapt to their flow.",
  ].join("\n");
}

function normalizeMemberOnboardingChannelName(userName: string): string {
  const suffix = userName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const trimmed = suffix.slice(0, 20) || "member";
  return `onboarding-${trimmed}`.slice(0, 32);
}

async function pickOnboardingAgent(serverId: string, fallbackAgentId?: string | null) {
  const deps = resolveOnboardingServiceDeps();
  const server = await deps.getServer(serverId);
  if (!server) return null;

  if (server.onboardingAgentId) {
    const configured = await deps.getAgent(server.onboardingAgentId);
    if (configured && configured.serverId === serverId) {
      return configured;
    }
    // Self-heal stale/deleted onboarding agent references.
    await deps.updateServerOnboardingAgent(serverId, null);
  }

  if (!fallbackAgentId) return null;
  const fallback = await deps.getAgent(fallbackAgentId);
  if (!fallback || fallback.serverId !== serverId) return null;
  return fallback;
}

async function ensureMemberOnboardingChannel(
  io: SocketServer,
  serverId: string,
  memberUserId: string,
  ownerUserId: string,
  onboardingAgentId: string,
  memberName: string,
) {
  const deps = resolveOnboardingServiceDeps();
  const channelName = normalizeMemberOnboardingChannelName(memberName);
  const existing = (await deps.listChannels(serverId, memberUserId))
    .find((ch) => (ch.type === "channel" || ch.type === "private") && ch.name === channelName);

  let channel = existing ?? null;
  let created = false;
  if (!channel) {
    channel = await deps.createChannel(
      serverId,
      channelName,
      "Member onboarding workspace (system-managed).",
      "private",
    );
    created = true;
  }

  await deps.addHuman(channel.id, memberUserId);
  await deps.addHuman(channel.id, ownerUserId);
  await deps.addAgent(channel.id, onboardingAgentId);

  if (created) {
    emitPrivateChannelCreated(io, channel, [memberUserId, ownerUserId]);
  }

  return channel;
}

function emitPrivateChannelCreated(
  io: SocketServer,
  channel: Awaited<ReturnType<OnboardingServiceDeps["createChannel"]>>,
  userIds: string[],
) {
  io.to(`channel:${channel.id}`).emit("channel:updated", { channel: { ...channel, joined: true } });
  for (const userId of new Set(userIds)) {
    io.to(`user:${userId}`).emit("channel:updated", { channel: { ...channel, joined: true } });
  }
}

async function ensureAllChannel(serverId: string) {
  const deps = resolveOnboardingServiceDeps();
  const list = await deps.listChannels(serverId);
  return list.find((ch) => channelService.isEnabledAllChannel(ch)) ?? null;
}

async function pickOwnerOpenerTargetChannel(serverId: string, ownerUserId: string) {
  const deps = resolveOnboardingServiceDeps();
  const list = await deps.listChannels(serverId, ownerUserId);
  return list.find((ch) => (
    (ch.type === "channel" || ch.type === "private") && ch.name === "onboarding-owner"
  )) ?? list.find((ch) => channelService.isEnabledAllChannel(ch)) ?? null;
}

async function findOwnerOnboardingChannel(serverId: string, ownerUserId: string) {
  const deps = resolveOnboardingServiceDeps();
  return (await deps.listChannels(serverId, ownerUserId)).find((ch) => (
    (ch.type === "channel" || ch.type === "private") && ch.name === "onboarding-owner"
  )) ?? null;
}

export function buildOwnerOpenerV2Messages(userName: string, opts: { hosted?: boolean } = {}) {
  const displayName = userName.trim() || "there";
  return [
    {
      topic: OWNER_OPENER_V2_TOPICS[0],
      content: `Hi ${displayName}, I'm Cindy. I help you turn this server into a working agent team. Anything you need here, just ask me. I know Raft inside out.`,
    },
    {
      topic: OWNER_OPENER_V2_TOPICS[1],
      content: "Raft is where your agents go into team mode. I dropped a short example in the thread right here — open it.",
      attachTeamModeArtifact: true,
    },
    {
      topic: OWNER_OPENER_V2_TOPICS[2],
      content: "Message them like teammates — any channel, anytime, half-formed is fine.",
    },
    {
      topic: OWNER_OPENER_V2_TOPICS[3],
      // A hosted Cindy runs on Raft, not on the owner's computer, so she has no setup there to look at.
      content: opts.hosted
        ? "Tell me what you're working on and I'll propose a starter team for it."
        : "Would you want me to look at your current agents setup on this computer and propose you a starter team? Or just tell me what you're working on.",
    },
  ];
}

function buildOwnerOpenerV2LedgerInstruction(input: {
  userName: string;
  locationHint: string;
  messageIds: string[];
  artifactAttachmentId: string | null;
  roleLabel?: string | null;
  referralLabel?: string | null;
}) {
  const ledgerLines = [
    "Owner opener v2 ledger:",
    "opener_v2_sent=true",
    `opener_v2_version=${OWNER_OPENER_V2_VERSION}`,
    `opener_v2_message_ids=${input.messageIds.join(",")}`,
    `opener_v2_topics=${OWNER_OPENER_V2_TOPICS.join(",")}`,
    ...(input.artifactAttachmentId ? [`team_mode_artifact_attachment_id=${input.artifactAttachmentId}`] : []),
  ];

  return [
    ...ledgerLines,
    "",
    "The system has already posted those visible opener messages as you. Do not repeat, rephrase, or send another opener on your first real wake.",
    `Continue onboarding @${input.userName} in ${input.locationHint} from the owner's reply.`,
    // The signup survey is answered on the screen right before this fires, and this
    // ledger wake is the ONLY briefing the opener-v2 path delivers — so the answer
    // has to travel here or it reaches nobody.
    ...(input.roleLabel ? [`They told us their role is: ${input.roleLabel}. Pitch Raft and pick a starting point that fits that.`] : []),
    // The survey asked this too, and the screen before "Let's Go" told them she would
    // read their answers. If she cannot say where they heard about Raft, the survey was
    // data extraction with a friendly face.
    ...(input.referralLabel ? [`They found Raft via: ${input.referralLabel}.`] : []),
    "If the owner answers with a language preference, continue in that language.",
    "If the owner wants to migrate existing workflows, start from that workflow instead of giving a product tour.",
    "If the owner has no clear workflow yet, suggest one simple starter path and help them create an initial agent team.",
    "Your internal objectives/practices file is `notes/onboarding_objectives.md`. Read it before continuing and keep its per-item statuses current.",
    "That file is the durable objectives state store: preserve and update each objective's status/updated_at/refusal_note fields rather than relying on chat memory.",
    "Allowed objective statuses are exactly: todo, done, skipped, later, blocked.",
    "`skipped` is persistent refusal-memory: if the owner declines setup scan or another ask, mark it skipped and do not re-ask after restart unless the owner explicitly reopens it.",
    "`later` means the owner asked to postpone; `blocked` means a missing permission/tool/decision. Neither status upgrades a hard no into another ask.",
    "When stuck, use the embedded seeded practices in `notes/onboarding_objectives.md`; then try `raft manual get recipes/seeded --intent \"Choose a safe Raft workflow\" --reason \"Need the core recipe map now\"`, `raft manual search \"preview before merge\" --scope recipes --intent \"Safely preview a change before merge\" --reason \"Need the recommended preview workflow now\"`, or `raft manual get recipes/technique/preview-env --intent \"Safely preview a change before merge\" --reason \"Need exact preview setup steps now\"` if Manual recipes are available.",
    "When a new agent or channel is needed, use `raft action prepare` to prepare a quick-commit action card. The human must review and commit it; never auto-create agents/channels and do not pretend a pre-generated card exists.",
    "The action-card flow is documented in `notes/onboarding_playbook.md` (Starter Plan Output) and `notes/onboarding_knowledge_faq.md` (FAQ 15). Follow that human-commit contract.",
  ].join("\n");
}

async function sendOwnerOpenerV2(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  serverId: string,
  targetUserId: string,
  onboardingAgentId: string,
  opts: { hosted?: boolean } = {},
) {
  const deps = resolveOnboardingServiceDeps();
  const user = await deps.getUser(targetUserId);
  if (!user) return null;

  const targetChannel = await pickOwnerOpenerTargetChannel(serverId, targetUserId);
  if (!targetChannel) return null;

  const onboardingAgent = await deps.getAgent(onboardingAgentId);
  if (!onboardingAgent || onboardingAgent.serverId !== serverId) return null;
  const senderName = onboardingAgent.displayName || onboardingAgent.name;

  await deps.addHuman(targetChannel.id, targetUserId);
  await deps.addAgent(targetChannel.id, onboardingAgentId);

  const messages = buildOwnerOpenerV2Messages(user.name, { hosted: opts.hosted });
  const sentMessageIds: string[] = [];
  let artifactAttachmentId: string | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    const openerMessage = messages[index]!;

    // slack-bridge-ordinary-message-producer: onboarding.owner_opener
    const sent = await deps.broadcastAndDeliver(io, agentOrchestrator, {
      channelId: targetChannel.id,
      senderType: "agent",
      senderId: onboardingAgentId,
      senderName,
      content: openerMessage.content,
      agentSendKey: `${OWNER_OPENER_V2_VERSION}:${serverId}:${targetUserId}:${openerMessage.topic}`,
    });
    sentMessageIds.push(sent.id);

    // Seed the Team Mode artifact INTO this message's thread (not as a top-level
    // attachment) so the owner sees a populated thread from day one — teaching
    // threads by example on their very first screen. Posting via
    // broadcastAndDeliver into the thread channel also wires the thread-follow
    // rows (parent author → authored, sender → replied).
    if (openerMessage.attachTeamModeArtifact) {
      const thread = await deps.getOrCreateThread(sent.id, onboardingAgentId, "agent");
      const artifact = await deps.createOwnerOpenerArtifactAttachment({
        serverId,
        channelId: thread.id,
        onboardingAgentId,
        targetUserId,
      });
      artifactAttachmentId = artifact.id;
      // The thread reply is artifact delivery, not a "topic" opener message, so
      // it stays OUT of the ledger's opener_v2_message_ids (which stays aligned
      // with the 4 topics). The artifact itself is tracked via
      // team_mode_artifact_attachment_id below.
      // slack-bridge-ordinary-message-producer: onboarding.owner_artifact_reply
      await deps.broadcastAndDeliver(io, agentOrchestrator, {
        channelId: thread.id,
        senderType: "agent",
        senderId: onboardingAgentId,
        senderName,
        content: "Here's what team mode looks like in practice:",
        attachmentIds: [artifact.id],
        agentSendKey: `${OWNER_OPENER_V2_VERSION}:${serverId}:${targetUserId}:team-mode-thread`,
      });
    }
  }

  const instruction = buildOwnerOpenerV2LedgerInstruction({
    userName: user.name,
    locationHint: `#${targetChannel.name} channel`,
    messageIds: sentMessageIds,
    artifactAttachmentId,
    roleLabel: signupRoleLabel(user.signupRole),
    referralLabel: user.referralSource ? referralSourceLabel(user.referralSource) : null,
  });
  // This wake is the ONLY thing that tells Cindy who she is talking to (her role, her
  // playbook, "do not repeat the opener"). It is delivered `transient`, and a transient
  // delivery to an agent that is not currently able to receive is DROPPED, not queued.
  // At activation her runtime is often still coming up, so it lands in nothing — and
  // the caller used to stamp "sent" anyway, which meant it was never retried. Cindy then
  // greeted the owner and, asked who they were, honestly answered that she had no idea.
  //
  // So the delivery receipt decides. A dropped ledger = the briefing did not happen:
  // report it, do not stamp, and the next activation runs this again. The visible opener
  // messages above are keyed by `agentSendKey`, so replaying is a no-op for the human.
  const delivery = await agentOrchestrator.deliverMessage(onboardingAgentId, {
    channel_id: targetChannel.id,
    channel_name: targetChannel.name,
    channel_type: "channel",
    sender_id: "system",
    sender_name: "system",
    sender_type: "system",
    content: instruction,
    timestamp: currentDate().toISOString(),
    seq: 0,
    message_id: `opener-v2-ledger-${serverId}`,
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Onboarding] Failed to deliver ledger to agent ${onboardingAgentId}: ${msg}`);
    return { status: "dropped", reason: "delivery_threw" } as const;
  });

  if (delivery.status === "dropped") {
    console.warn(
      `[Onboarding] Owner opener ledger dropped for agent ${onboardingAgentId} (${delivery.reason}); not marking onboarding as sent so the next activation retries.`,
    );
    return null;
  }

  return {
    channelId: targetChannel.id,
    messageIds: sentMessageIds,
    artifactAttachmentId,
  };
}

function buildAllChannelAgenticGreetingInstruction(channelName: string) {
  return [
    "Onboarding task (system-triggered):",
    `You have just joined #${channelName}, the server-wide channel where the whole team — every agent and person — collaborates.`,
    `Post one short, natural self-introduction to #${channelName} so the team knows who you are and what you can help with.`,
    "Write it in your own voice, one or two sentences. Do NOT paste a fixed template. If a conversation is already going there, read the room and keep it brief.",
    "This is a one-time greeting; after you post it, go back to normal work.",
  ].join("\n");
}

/**
 * Agentic #all greeting: when a newly created agent joins an already unlocked
 * #all, deliver a private instruction telling it to introduce itself, and let
 * the agent author its own greeting (no canned copy). Gated by the
 * `agentAllChannelGreetingEnabled` server setting.
 *
 * No-ops before #all is unlocked (ensureAllChannel returns null while #all is
 * still private), so the first agent (the OA) does not greet into a hidden #all.
 */
export async function triggerNewAgentAllChannelGreeting(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  serverId: string,
  agentId: string,
) {
  const deps = resolveOnboardingServiceDeps();

  const agent = await deps.getAgent(agentId);
  if (!agent || agent.serverId !== serverId) return false;
  if (agent.allChannelIntroSentAt) return false;

  const settings = await deps.getServerOnboardingSettings(serverId);
  if (!settings?.agentAllChannelGreetingEnabled) return false;

  // Only greet once #all is actually live (unlocked). While #all is still
  // private/hidden, ensureAllChannel returns null and we stay silent.
  const allChannel = await ensureAllChannel(serverId);
  if (!allChannel) return false;

  const claimedAt = new Date();
  const claimed = await deps.tryMarkAllChannelIntroSent(agentId, claimedAt);
  if (!claimed) return false;

  try {
    await agentOrchestrator.deliverMessage(agentId, {
      channel_id: allChannel.id,
      channel_name: allChannel.name,
      channel_type: "channel",
      sender_id: "system",
      sender_name: "system",
      sender_type: "system",
      content: buildAllChannelAgenticGreetingInstruction(allChannel.name),
      timestamp: new Date().toISOString(),
      seq: 0,
      message_id: `all-greeting-${serverId}-${agentId}`,
    });
    return true;
  } catch (err) {
    await deps.clearAllChannelIntroSentClaim(agentId, claimedAt).catch(() => {});
    throw err;
  }
}

async function sendMemberOnboardingInstruction(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  serverId: string,
  targetUserId: string,
  onboardingAgentId: string,
) {
  const deps = resolveOnboardingServiceDeps();
  const user = await deps.getUser(targetUserId);
  if (!user) return false;

  const server = await deps.getServer(serverId);
  if (!server) return false;

  const onboardingChannel = await ensureMemberOnboardingChannel(
    io,
    serverId,
    targetUserId,
    server.ownerId,
    onboardingAgentId,
    user.name,
  );

  io
    .in(socketUserServerRoom(targetUserId, serverId))
    .socketsJoin(`channel:${onboardingChannel.id}`);

  const content = buildMemberOnboardingInstruction(user.name, `#${onboardingChannel.name} channel`, signupRoleLabel(user.signupRole));
  // Agent-only wake, NOT a channel broadcast: brief the agent, do not publish
  // the brief. `deliverSystemNoticeToAgent` uses the system sender, wakes the
  // agent, and writes no chat history.
  await deps.deliverSystemNoticeToAgent(agentOrchestrator, onboardingAgentId, {
    serverId,
    channel_id: onboardingChannel.id,
    channel_name: onboardingChannel.name,
    channel_type: onboardingChannel.type === "private" ? "private" : "channel",
    content,
  });
  return true;
}

export async function triggerOwnerOnboardingOnAgentActivation(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  serverId: string,
  activatedAgentId: string,
) {
  const deps = resolveOnboardingServiceDeps();

  const server = await deps.getServer(serverId);
  if (!server) return false;

  // A hosted Cindy (antiproton_cindy) is never "started": she can receive once
  // the provider accepted her AND her workspace import landed (`ready`). Only
  // the server's onboarding agent.
  const activatedAgent = server.onboardingAgentId === activatedAgentId ? await deps.getAgent(activatedAgentId) : null;
  const hostedState = activatedAgent && isExternalAgentRuntime(activatedAgent.runtime)
    ? await deps.getHostedOnboardingAgentState(serverId, activatedAgentId)
    : null;

  // Do not brief her yet if the owner has not answered the signup survey.
  //
  // The survey is asked one screen AFTER Cindy is created, so at this moment
  // `signupRole` is still null. Sending the briefing now would hand her a blank
  // where the role should be, and the "sent" guard below would then stop it ever
  // being sent again. Returning early claims nothing, so the identical call made
  // once the survey is saved (PATCH /api/auth/me with a serverId) delivers the
  // briefing WITH the role in it.
  //
  // If the person never answers, the briefing still goes out on the next activation
  // trigger; they just get an unadapted Cindy, which is the honest fallback.
  const owner = await deps.getUser(server.ownerId);
  if (owner && !owner.signupSurveyCompletedAt) return false;

  const ownerPrefs = await deps.getMemberOnboardingPreferences(serverId, server.ownerId);
  // `setupModalReminderOptOut` is intentionally NOT checked here.
  // It only suppresses setup modal reminders on the web UI, not system
  // onboarding task triggers.
  if (!ownerPrefs) return false;
  // An existing opener stops only the visible opener. The D2 reminder is a
  // separate durable side effect and must keep retrying after a transient
  // schedule failure.
  if (!ownerPrefs.onboardingOwnerOpenerV2SentAt && ownerPrefs.onboardingDmSentAt) return false;

  // Owner onboarding is only fired when server has an explicit onboarding agent
  // and that exact agent is currently activating.
  if (!isOwnerOnboardingActivationEligible(server.onboardingAgentId, activatedAgentId)) return false;

  const onboardingAgent = await pickOnboardingAgent(serverId, null);
  if (!onboardingAgent) return false;

  // Do not brief an agent that is not running.
  //
  // The briefing is a transient wake: delivered to a dead agent it is simply lost,
  // and the "sent" flag below would then be stamped anyway, so it would never be
  // retried. That is exactly what happened in a real run — Cindy crashed on a stale
  // runtime credential, the survey answer was delivered into the void, and she came
  // back up knowing nothing about the person she was there to help.
  //
  // Returning false claims nothing, so the next activation (which fires this same
  // trigger when the agent starts) delivers it for real.
  // A hosted Cindy counts as able to receive once `ready` (see above); other
  // external agents keep this rule.
  if (onboardingAgent.status !== "active" && hostedState !== "ready") return false;

  if (ownerPrefs.onboardingOwnerOpenerV2SentAt) {
    const ownerChannel = await findOwnerOnboardingChannel(serverId, server.ownerId);
    await ensureOnboardingDay2Reminder({
      deps,
      orchestrator: agentOrchestrator,
      serverId,
      ownerId: server.ownerId,
      onboardingAgentId: onboardingAgent.id,
      openerSentAt: ownerPrefs.onboardingOwnerOpenerV2SentAt,
      anchorMsgId: ownerPrefs.onboardingOwnerOpenerV2MessageIds[0],
      targetChannelId: ownerChannel?.id,
      owner: owner ?? {},
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Onboarding] Failed to schedule D2 recap reminder; next activation will retry: ${msg}`);
    });
    return false;
  }

  // One sender at a time: the import hook, the survey save, agent start and the
  // setup backstop can all arrive together. Only the trigger that claims the
  // opener briefs and posts it; a failed send releases the claim for a retry.
  const claim = await deps.claimOwnerOpener(serverId, server.ownerId);
  if (!claim) return false;
  let opener: Awaited<ReturnType<typeof sendOwnerOpenerV2>>;
  try {
    // A hosted Cindy has no computer coming online to hand her the owner's facts on
    // every wake (onboardingBriefingOnActivation); she keeps her session, so they go
    // once, here, under the claim and ahead of the opener.
    if (hostedState === "ready") {
      await deliverOwnerFactsContext(agentOrchestrator, serverId, onboardingAgent.id, deps);
    }
    opener = await sendOwnerOpenerV2(
      io,
      agentOrchestrator,
      serverId,
      server.ownerId,
      onboardingAgent.id,
      { hosted: hostedState !== null },
    );
  } catch (error) {
    await deps.releaseOwnerOpenerClaim(serverId, server.ownerId, claim);
    throw error;
  }
  if (!opener) {
    await deps.releaseOwnerOpenerClaim(serverId, server.ownerId, claim);
    return false;
  }

  const sentAt = currentDate();
  await deps.updateMemberOnboardingPreferences(serverId, server.ownerId, {
    onboardingDmSentAt: sentAt,
    onboardingDmSentByAgentId: onboardingAgent.id,
    onboardingOwnerOpenerV2SentAt: sentAt,
    onboardingOwnerOpenerV2SentByAgentId: onboardingAgent.id,
    onboardingOwnerOpenerV2MessageIds: opener.messageIds,
    onboardingOwnerOpenerV2Version: OWNER_OPENER_V2_VERSION,
    onboardingOwnerOpenerV2Topics: OWNER_OPENER_V2_TOPICS,
  });

  await ensureOnboardingDay2Reminder({
    deps,
    orchestrator: agentOrchestrator,
    serverId,
    ownerId: server.ownerId,
    onboardingAgentId: onboardingAgent.id,
    openerSentAt: sentAt,
    anchorMsgId: opener.messageIds[0],
    targetChannelId: opener.channelId,
    owner: owner ?? {},
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Onboarding] Failed to schedule D2 recap reminder; next activation will retry: ${msg}`);
  });

  return true;
}

export async function triggerNewMemberOnboarding(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  serverId: string,
  userId: string,
) {
  const deps = resolveOnboardingServiceDeps();
  const prefs = await deps.getMemberOnboardingPreferences(serverId, userId);
  // `setupModalReminderOptOut` applies to setup modal reminder UX only.
  // Member onboarding DM trigger remains system-driven.
  if (!prefs || prefs.onboardingDmSentAt) return false;

  const onboardingAgent = await pickOnboardingAgent(serverId, null);
  if (!onboardingAgent) return false;

  const sent = await sendMemberOnboardingInstruction(
    io,
    agentOrchestrator,
    serverId,
    userId,
    onboardingAgent.id,
  );
  if (!sent) return false;

  await deps.updateMemberOnboardingPreferences(serverId, userId, {
    onboardingDmSentAt: new Date(),
    onboardingDmSentByAgentId: onboardingAgent.id,
  });
  return true;
}

export async function triggerAllChannelUnlockOnboarding(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  serverId: string,
) {
  const deps = resolveOnboardingServiceDeps();
  // #all unlocks once the server has grown into a team — total members
  // (humans + agents) >= 3. Baseline onboarding is owner (1 human) + the
  // Cindy OA (1 agent) = 2, so #all stays hidden until a 3rd member arrives,
  // whether that member is another agent OR another human.
  // The same count as the threshold that reveals #all (headcountAgent): a personal assistant is not a member.
  const agentList = (await deps.listAgents(serverId)).filter((agent) => AGENT_KIND_RULES[agentKindOf(agent)].headcount);
  const humanMemberIds = await deps.listServerMemberIds(serverId);
  if (agentList.length + humanMemberIds.length < ALL_CHANNEL_TEAM_THRESHOLD) return false;

  const server = await deps.getServer(serverId);
  if (!server) return false;

  const allChannel = await ensureAllChannel(serverId);
  if (!allChannel) return false;

  const onboardingAgent = await pickOnboardingAgent(serverId, null);
  if (!onboardingAgent) return false;

  const claimedAt = new Date();
  const claimed = await deps.tryClaimAllChannelUnlockInstruction(serverId, server.ownerId, claimedAt);
  if (!claimed) return false;

  // The 3rd member may be another agent OR another human. Name a non-OA agent
  // when one exists (the common "2nd agent" path); otherwise fall back to
  // team-neutral copy so a human-triggered unlock doesn't claim an agent joined.
  const secondAgent = agentList.find((a) => a.id !== onboardingAgent.id);
  const secondAgentName = secondAgent?.displayName || secondAgent?.name;
  const openingLine = secondAgentName
    ? `#all is now live — ${secondAgentName} just joined the team.`
    : `#all is now live — your team is growing.`;

  const content = [
    openingLine,
    `This channel is where all your agents and team members can collaborate together.`,
    `Your agents can @mention each other here, and you can coordinate across the whole team.`,
  ].join("\n\n");

  try {
    if (allChannel.type === "private") {
      const updated = await channelService.updateChannel(allChannel.id, { type: "channel" });
      await publishChannelUpdate(io, { ...updated, joined: true });
    }
    await deps.broadcastSystemMessage(io, agentOrchestrator, allChannel.id, content, {
      inboxFactPolicy: {
        mode: "record",
        producer: "onboarding.all_channel_unlock",
        reason: "notifies agents that #all is now active after the server reaches 3 members",
      },
      targetAgentIds: [onboardingAgent.id],
    });
  } catch (err) {
    await deps.clearAllChannelUnlockInstructionClaim(serverId, server.ownerId, claimedAt).catch(() => {});
    throw err;
  }

  return true;
}

export async function triggerCrossChannelHint(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  serverId: string,
  senderUserId: string,
  channelId: string,
) {
  const deps = resolveOnboardingServiceDeps();
  const server = await deps.getServer(serverId);
  if (!server || server.ownerId !== senderUserId) return false;

  const ownerPrefs = await deps.getMemberOnboardingPreferences(serverId, senderUserId);
  if (!ownerPrefs || ownerPrefs.crossChannelHintShownAt) return false;
  if (!ownerPrefs.onboardingOwnerOpenerV2SentAt) return false;
  if (!ownerPrefs.onboardingWizardCurrentStep || ownerPrefs.onboardingWizardCurrentStep === "complete") return false;

  const channelList = await deps.listChannels(serverId, senderUserId);
  const channel = channelList.find((ch) => ch.id === channelId);
  if (!channel || channel.name === "onboarding-owner") return false;

  const onboardingAgent = await pickOnboardingAgent(serverId, null);
  if (!onboardingAgent) return false;

  await deps.updateMemberOnboardingPreferences(serverId, senderUserId, {
    crossChannelHintShownAt: new Date(),
  });

  const content = "They're all like this — any channel, any time, they know the context.";
  await deps.broadcastSystemMessage(io, agentOrchestrator, channelId, content, {
    inboxFactPolicy: {
      mode: "record",
      producer: "onboarding.cross_channel_hint",
      reason: "first cross-channel @mention hint for onboarding",
    },
    targetAgentIds: [onboardingAgent.id],
  });

  return true;
}

/**
 * Tell Cindy who she is working for. EVERY time she starts work — not once, ever.
 *
 * This is the fix for a bug that every green test missed and one conversation found. Asked
 * "what did I say my role was?", a fully-onboarded Cindy answered, honestly: "you never told
 * me." She was right. We had told her exactly once, inside the transient wake that also made
 * her post the opener, and a transient wake belongs to one session. The next session — the one
 * the user actually talks to — has no memory of it, and nothing in the channel records the
 * survey, because the answers were an INSTRUCTION TO HER, never a MESSAGE.
 *
 * The delivery succeeded. The knowledge still vanished.
 *
 * So the opener and the owner facts are two different kinds of thing, and treating them as one
 * is what broke this:
 *
 *   the opener  → a MESSAGE.  Sent once, lives in history, deduped by `agentSendKey`.
 *   owner facts → CONTEXT.    Re-established every time she comes back, because context is
 *                             what a session starts with, not what it remembers.
 *
 * Hence: no `sent_at` stamp, no dedupe, no ledger. The facts are already durable in the
 * database (owner, `signup_role`, `referral_source`); this recomputes them from there and
 * hands them over on every wake. Nothing is stored that could go stale, and nothing is lost
 * if a delivery drops — the next wake simply does it again.
 *
 * (`messages.sender_type` is only `user | agent`, so "write a system context message into the
 * channel" would mean widening the message model. This needs no schema change at all.)
 */
export async function deliverOwnerFactsContext(
  agentOrchestrator: Pick<AgentOrchestrator, "deliverMessage">,
  serverId: string,
  onboardingAgentId: string,
  deps: OnboardingServiceDeps = defaultOnboardingServiceDeps,
): Promise<boolean> {
  const server = await deps.getServer(serverId);
  if (!server?.ownerId) return false;
  const owner = await deps.getUser(server.ownerId);
  if (!owner) return false;

  const roleLabel = signupRoleLabel(owner.signupRole);
  const referralLabel = owner.referralSource ? referralSourceLabel(owner.referralSource) : null;

  const lines = [
    "Onboarding context for this server (re-sent on every start; not a message to reply to):",
    `owner_name=${owner.name}`,
    owner.displayName ? `owner_display_name=${owner.displayName}` : null,
    roleLabel ? `owner_role=${roleLabel}` : null,
    referralLabel ? `owner_found_us_via=${referralLabel}` : null,
    "",
    "This is what the owner told us about themselves when they signed up. Use it. If they ask",
    "what they told you, you know — do not say you were never told.",
  ].filter((line): line is string => line !== null);

  const delivery = await agentOrchestrator.deliverMessage(onboardingAgentId, {
    channel_id: "onboarding-context",
    channel_name: "onboarding-context",
    channel_type: "channel",
    sender_id: "system",
    sender_name: "system",
    sender_type: "system",
    content: lines.join("\n"),
    timestamp: new Date().toISOString(),
    seq: 0,
    message_id: `onboarding-owner-facts-${serverId}`,
  }, {
    // Context about the agent's own server, not a channel's content: there is
    // no target channel to check visibility of ("onboarding-context" is a
    // label, not a channel id), and the agent cannot opt out of its own setup.
    intrinsic: true,
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Onboarding] Owner facts context failed for agent ${onboardingAgentId}: ${message}`);
    return { status: "dropped", reason: "delivery_threw" } as const;
  });

  // Nothing is stamped either way. A dropped context is not a lost fact — the next wake
  // recomputes it from the database and hands it over again.
  return delivery.status !== "dropped";
}
