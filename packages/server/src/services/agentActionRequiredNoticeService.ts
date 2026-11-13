import { ANTHROPIC_VERIFICATION_PORTAL_URL, getRuntimeDisplayName, type RuntimeErrorRequiredAction } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getAppUrl } from "../config/appUrl";
import { getDb } from "../db/index";
import { machines, servers } from "../db/schema";
import type { AgentInboxPushPausedCause } from "./agentInboxPushService";
import type { AgentOrchestrator } from "./agentOrchestrator";
import type { MemberDepartureReason } from "./computerKeyRevocation";
import * as agentService from "./agentService";
import * as channelService from "./channelService";
import * as messageService from "./messageService";

/**
 * Tells an agent's owner, once, that the agent stopped on an error only they
 * can fix (a rejected credential, a model the plan does not allow) and that
 * automatic wakes are paused until they act. Before this the agent failed
 * quietly on every wake and the owner learned of it only by opening the agent
 * page (WangHuning, humanverse, 2026-10-13). The notice lands in the DM
 * between the owner and the agent, unread for the owner. It is born-read for
 * the agent and not delivered to it: the agent cannot run until the owner acts,
 * and must not take the notice as a message on its next start.
 *
 * The text is fixed per action and never quotes the runtime's error: the
 * agent can read this DM's history, and the error is shown on the agent page.
 *
 * `runtime_unavailable`: the agent's runtime could not start because the
 * computer does not have it (no CLI there). Same notice, other remedy.
 *
 * `runtime_start_timeout`: the runtime started but never answered, several
 * starts in a row (a model queued or rate-limited by its provider). The pause
 * tries again by itself, so the notice says when, and how to resume now.
 *
 * `start_failure_paused`: such a pause's own try then failed for a reason
 * that does not retry by itself (a login, a model, the configuration). Raft
 * stops trying, and the owner, told earlier that it would, hears that it
 * will not and what to fix. Named by reason, never by the runtime's text.
 *
 * `pause_retry_capped`: a pause from a runtime that kept failing after it
 * started (`runtime_repeated_failure`, reconciler step 12) retries by itself
 * with a doubling cooldown, and the owner is not told when it begins (a
 * provider outage would tell every owner at once). Once the cooldown reaches
 * its cap (8 hours) the failure has lasted most of a day: the owner hears it
 * once, with the last failure named by reason, that Raft keeps trying every
 * 8 hours, and what gets it going sooner. Not again while it stays at the
 * cap; again after the cooldown has started over (wakeCrashLoopBreaker.ts
 * `pauseRetryCapNotified`).
 *
 * `computer_detached`: the computer the agent runs on was detached (its key
 * revoked: web, `raft-computer detach`, or the mailed link), so the agent is
 * offline until its owner moves it to another computer. Sent to the owners
 * other than whoever detached it (computerDetachedNotices.ts); in a shared
 * server members can host agents on someone else's computer. Reason
 * `member_left`: it was revoked because whoever attached it is no longer in
 * the server (left, removed, account deleted); its own copy, sent to the
 * agents' creators who stay or else to every owner, one notice per owner
 * listing the Computer's agents (`agentNames`). The text is made here, so a
 * client of any age shows it as it shows the other copy.
 *
 * `computer_owner_leaving`: the owner of the computer the agent runs on asked
 * for it to be moved: their account deletion is blocked until it is (and
 * takes that computer offline; services/accountDeletion/ownerNotices.ts). A
 * system notice: it names the computer, and the person only as "the
 * computer's owner" (Tenny, #triage:d10ace06).
 *
 * `computer_detach_requested`: someone who may remove the computer the agent
 * runs on (whoever attached it, or a server admin) wants to detach it, and
 * the detach is refused while the agent is on it (routes/servers.ts
 * revoke-computer-key). Same shape: names the computer, not the person.
 *
 * `handed_over`: the agent's creator deleted their account and the cleanup
 * gave it to this server's owner, stopped (services/accountDeletion). Same
 * facts as the handover email, which is easy to miss (Tenny, #triage:d10ace06).
 *
 * `inbox_push_paused`: an External Agent's inbox push registration stopped
 * (agentInboxPushService.ts), so nothing wakes the agent for new messages:
 * its runtime's endpoint kept refusing notices (Raft probes it and resumes by
 * itself), or someone other than the owner revoked the credential the
 * registration is bound to. At most once per agent per 24 hours.
 *
 * `automatic_wake_paused`: the server's early-exit breaker paused automatic
 * wakes after several early exits in a row (wakeCrashLoopBreaker.ts). Facts
 * only: the count, the open tasks assigned to the agent in channels the owner
 * can see (others only counted), and what the owner can do. Once per trip
 * (automaticWakePausedNotice.ts).
 *
 * `readiness_blocked` (#proj-raft-computer:#68): a blocked login fact appeared
 * in the Computer's readiness report (runtimeReadinessService.ts), e.g. its
 * machine login's account must be verified. One notice per fact, listing
 * every agent it holds (`agentNames`): a machine login's to the Computer's
 * owner, an agent's own login's to its owner. Copy by code; the generic
 * sentence for a code this server has no copy for.
 */
export type AgentActionRequiredNotice =
  | { kind: "runtime_error"; requiredAction: RuntimeErrorRequiredAction }
  | { kind: "readiness_blocked"; code: string; runtime: string; computerName: string; machineLogin: boolean; agentNames: readonly string[] }
  | { kind: "runtime_unavailable"; runtime: string; machineId: string }
  | { kind: "runtime_start_timeout"; runtime: string; model: string | null; failedStarts: number; retryInMs: number | null }
  | { kind: "start_failure_paused"; runtime: string; reason: string }
  | { kind: "pause_retry_capped"; runtime: string; reason: string; retryEveryMs: number }
  | {
    kind: "computer_detached";
    computerName: string;
    removed?: boolean;
    /** Revoked with its attacher's membership (serverService.ts removeMember). */
    reason?: "member_left";
    /** With `member_left`: the revoke's departure reason; `account_deleted` reads the deletion text. */
    departureReason?: MemberDepartureReason;
    /** With `member_left` to an owner: every agent on the Computer, this notice's own agent among them. */
    agentNames?: readonly string[];
  }
  | { kind: "computer_owner_leaving"; computerName: string }
  | { kind: "computer_detach_requested"; computerName: string }
  | { kind: "handed_over"; deletedName: string; machineCleared: boolean; hosted: boolean }
  | { kind: "inbox_push_paused"; cause: AgentInboxPushPausedCause }
  | {
    kind: "automatic_wake_paused";
    earlyExits: number;
    /** Open tasks assigned to the agent in channels the owner can see, at most AUTOMATIC_WAKE_PAUSED_LISTED_TASKS. */
    tasks: ReadonlyArray<{ ref: string; title: string }>;
    /** Further visible open tasks not listed. */
    moreTasks: number;
    /** Open tasks assigned to the agent in channels the owner can't see: counted, never named. */
    hiddenTasks: number;
  };

export async function postAgentActionRequiredNotice(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  input: {
    agentId: string;
    notice: AgentActionRequiredNotice;
    /** Whom to tell, when the caller resolved the agent's owner itself (a personal assistant's person); else its creator. */
    ownerUserId?: string;
  },
): Promise<boolean> {
  const agent = await agentService.getAgent(input.agentId, false, { dbCallsite: "agent_action_required_notice.get_agent" });
  if (!agent) return false;
  const ownerUserId = input.ownerUserId ?? (agent.creatorType === "user" ? agent.creatorId : null);
  if (!ownerUserId) return false;
  const { notice } = input;
  const [dm, [server], [machine]] = await Promise.all([
    channelService.findOrCreateDM(agent.serverId, ownerUserId, agent.id),
    getDb().select({ slug: servers.slug }).from(servers).where(eq(servers.id, agent.serverId)),
    notice.kind === "runtime_unavailable"
      ? getDb().select({ name: machines.name }).from(machines).where(eq(machines.id, notice.machineId))
      : Promise.resolve([]),
  ]);
  if (!dm) return false;
  const agentUrl = server
    ? new URL(`/s/${encodeURIComponent(server.slug)}/agent/${agent.id}`, getAppUrl()).toString()
    : null;
  await messageService.broadcastSystemMessage(
    io,
    agentOrchestrator,
    dm.id,
    notice.kind === "runtime_error"
      ? agentActionRequiredNoticeText({ agentName: agent.name, requiredAction: notice.requiredAction, agentUrl })
      : notice.kind === "runtime_start_timeout"
        ? agentStartTimeoutPausedNoticeText({ agentName: agent.name, ...notice, agentUrl })
        : notice.kind === "start_failure_paused"
          ? agentStartFailurePausedNoticeText({ agentName: agent.name, runtime: notice.runtime, reason: notice.reason, agentUrl })
        : notice.kind === "pause_retry_capped"
          ? agentPauseRetryCappedNoticeText({ agentName: agent.name, ...notice, agentUrl })
        : notice.kind === "computer_detached"
          ? (notice.reason === "member_left"
            ? agentComputerMemberLeftNoticeText({ agentNames: notice.agentNames?.length ? notice.agentNames : [agent.name], computerName: notice.computerName, accountDeleted: notice.departureReason === "account_deleted", agentUrl })
            : agentComputerDetachedNoticeText({ agentName: agent.name, computerName: notice.computerName, removed: notice.removed === true, agentUrl }))
        : notice.kind === "computer_owner_leaving"
          ? agentComputerOwnerLeavingNoticeText({ agentName: agent.name, computerName: notice.computerName, agentUrl })
        : notice.kind === "computer_detach_requested"
          ? agentComputerDetachRequestedNoticeText({ agentName: agent.name, computerName: notice.computerName, agentUrl })
        : notice.kind === "handed_over"
          ? agentHandedOverNoticeText({ agentName: agent.name, ...notice, agentUrl })
        : notice.kind === "inbox_push_paused"
          ? agentInboxPushPausedNoticeText({ agentName: agent.name, cause: notice.cause, agentUrl })
        : notice.kind === "automatic_wake_paused"
          ? agentAutomaticWakePausedNoticeText({ agentName: agent.name, ...notice, agentUrl })
        : notice.kind === "readiness_blocked"
          ? agentReadinessBlockedNoticeText({ ...notice, agentUrl: notice.agentNames.length <= 1 ? agentUrl : null })
        : agentRuntimeUnavailableNoticeText({ agentName: agent.name, runtime: notice.runtime, computerName: machine?.name ?? null, agentUrl }),
    {
      inboxFactPolicy: {
        mode: "record",
        producer: "agent.runtime_action_required",
        reason: notice.kind === "handed_over"
          ? "the agent was handed to its server's owner when its creator deleted their account; it is stopped"
          : notice.kind === "computer_detached"
          ? "the agent's computer was detached; it is offline until its owner moves it"
          : notice.kind === "computer_owner_leaving"
          ? "the computer's owner asked for the agent to be moved off their computer; their account deletion is blocked until it is"
          : notice.kind === "computer_detach_requested"
          ? "someone wants to detach the computer the agent runs on and asked for the agent to be moved first"
          : notice.kind === "inbox_push_paused"
            ? "the agent's inbox push stopped; its runtime is not woken for new messages until push resumes"
          : notice.kind === "automatic_wake_paused"
            ? "the agent exited early several times in a row; automatic wakes are paused"
          : notice.kind === "pause_retry_capped"
            ? "the agent's runtime keeps failing; automatic wakes are paused and Raft keeps trying again by itself"
          : notice.kind === "readiness_blocked"
            ? "the agent can't reply until someone fixes what its computer reported; messages are kept"
          : "the agent stopped on an error only its owner can fix; automatic wakes are paused",
        causalActor: { type: "agent", id: agent.id },
      },
      // Not for the agent: it cannot run until the owner acts.
      targetAgentIds: [],
    },
  );
  return true;
}

export function agentActionRequiredNoticeText(input: {
  agentName: string;
  requiredAction: RuntimeErrorRequiredAction;
  agentUrl: string | null;
}): string {
  const what = input.requiredAction === "user_model_access"
    ? "its model is not available on the current plan"
    : "its model credential was rejected";
  return [
    `@${input.agentName} stopped because ${what}. The agent page shows the error.`,
    "Messages and reminders wait until you fix it: change the agent's model, provider, API key or environment variables, or start it manually once the credential works again.",
    ...(input.agentUrl ? [`Agent page: ${input.agentUrl}`] : []),
  ].join("\n");
}

/**
 * `readiness_blocked`: what is stuck, which agents it holds, who fixes it and
 * how; messages are kept. The verification link is the fixed portal, never
 * one from the provider's text.
 */
export function agentReadinessBlockedNoticeText(input: {
  code: string;
  runtime: string;
  computerName: string;
  machineLogin: boolean;
  agentNames: readonly string[];
  agentUrl: string | null;
}): string {
  const names = input.agentNames.map((name) => `@${name}`);
  const list = names.length <= 1 ? (names[0] ?? "The agent") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const runtimeName = getRuntimeDisplayName(input.runtime);
  const whose = input.machineLogin
    ? `the ${runtimeName} account signed in on the computer "${input.computerName}"`
    : `the ${runtimeName} account this agent signs in with`;
  const lines = input.code === "verification_required"
    ? [
      `${list} can't reply right now: ${whose} can't receive replies until it is verified.`,
      `The account holder must finish the step in the Anthropic Verification Portal (${ANTHROPIC_VERIFICATION_PORTAL_URL}), then choose Retry on the agent. Messages are kept and will be delivered.`,
    ]
    : [`${list} can't reply right now: something on the computer "${input.computerName}" needs attention. Messages are kept and will be delivered once it is fixed.`];
  return [...lines, ...(input.agentUrl ? [`Agent page: ${input.agentUrl}`] : [])].join("\n");
}

export function agentRuntimeUnavailableNoticeText(input: {
  agentName: string;
  runtime: string;
  computerName: string | null;
  agentUrl: string | null;
}): string {
  const runtimeName = getRuntimeDisplayName(input.runtime);
  const where = input.computerName ? `the computer "${input.computerName}"` : "its computer";
  return [
    `@${input.agentName} could not start: ${runtimeName} is not available on ${where}.`,
    // Neutral like the agent page (task #735): the lookup may not have proven
    // the CLI is absent (permission denied, or an old daemon with no reason).
    `Messages and reminders wait until you fix it: make ${runtimeName} available on that computer, move the agent to a computer that has it, or switch the agent's runtime.`,
    ...(input.agentUrl ? [`Agent page: ${input.agentUrl}`] : []),
  ].join("\n");
}

export function agentComputerDetachedNoticeText(input: {
  agentName: string;
  computerName: string;
  /** The computer was deleted (its owner's account was deleted), not only detached. */
  removed?: boolean;
  agentUrl: string | null;
}): string {
  return [
    `@${input.agentName} is offline: the computer "${input.computerName}" it runs on was ${input.removed ? "deleted" : "detached from this server"}.`,
    "Messages and reminders wait until you move the agent to another computer.",
    ...(input.agentUrl ? [`Agent page: ${input.agentUrl}`] : []),
  ].join("\n");
}

/**
 * `computer_detached` with `member_left` (copy: Warden, 2026-11-09). One agent
 * reads as written; several on the one Computer are named together. The agent
 * page link only for one.
 */
function agentComputerMemberLeftNoticeText(input: {
  agentNames: readonly string[];
  computerName: string;
  /** The person who set it up is deleting their account (Warden, Tenny, 2026-11-09): cancelling does not reconnect it. */
  accountDeleted: boolean;
  agentUrl: string | null;
}): string {
  const names = input.agentNames.map((name) => `@${name}`);
  const why = input.accountDeleted
    ? "the person who set it up is deleting their account. It stays disconnected even if they cancel."
    : "the person who set it up is no longer in this server.";
  if (names.length <= 1) {
    return [
      `${names[0] ?? "The agent"} is offline: the computer "${input.computerName}" it runs on was disconnected because ${why} `
        + "Someone in this server can set up that machine again (the agent comes back as it was), or move the agent to another computer.",
      ...(input.agentUrl ? [`Agent page: ${input.agentUrl}`] : []),
    ].join("\n");
  }
  // Two: "@a and @b"; three or more: "@a, @b and @c" (Warden).
  const list = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} are offline: the computer "${input.computerName}" they run on was disconnected because ${why} `
    + "Someone in this server can set up that machine again (the agents come back as they were), or move the agents to another computer.";
}

export function agentComputerOwnerLeavingNoticeText(input: {
  agentName: string;
  computerName: string;
  agentUrl: string | null;
}): string {
  return [
    `Please move @${input.agentName} to another computer. The computer's owner can't delete their account while the agent runs on the computer "${input.computerName}".`,
    "When they do, that computer goes offline: the agent stops and can no longer be moved with its files.",
    ...(input.agentUrl ? [`Agent page: ${input.agentUrl}`] : []),
  ].join("\n");
}

export function agentComputerDetachRequestedNoticeText(input: {
  agentName: string;
  computerName: string;
  agentUrl: string | null;
}): string {
  return [
    `Please move @${input.agentName} to another computer. The computer "${input.computerName}" it runs on is about to be detached from this server.`,
    "When it is, the agent stops and can no longer be moved with its files.",
    ...(input.agentUrl ? [`Agent page: ${input.agentUrl}`] : []),
  ].join("\n");
}

export function agentHandedOverNoticeText(input: {
  agentName: string;
  deletedName: string;
  machineCleared: boolean;
  hosted: boolean;
  agentUrl: string | null;
}): string {
  return [
    `@${input.agentName} is yours now: ${input.deletedName} deleted their account, and you own this server. It is stopped and won't run until you start it.`,
    ...(input.machineCleared ? [`It ran on ${input.deletedName}'s own computer: choose one of your computers when you start it. Files it kept on that computer did not come along.`] : []),
    ...(input.hosted ? ["It is hosted by Raft: start it, or delete it from its page if you don't need it."] : []),
    ...(input.agentUrl ? [`Agent page: ${input.agentUrl}`] : []),
  ].join("\n");
}

export function agentInboxPushPausedNoticeText(input: {
  agentName: string;
  cause: AgentInboxPushPausedCause;
  agentUrl: string | null;
}): string {
  const stillInInbox = "New messages still reach its inbox, but it may not reply until it checks in on its own.";
  return [
    input.cause === "credential_revoked"
      ? `@${input.agentName} isn't being woken up for new messages right now: the credential its runtime registered push delivery with was revoked, so Raft paused push delivery. ${stillInInbox} `
        + "Push delivery resumes when its runtime registers its push endpoint again with an active credential."
      : `@${input.agentName} isn't being woken up for new messages right now: its runtime's push endpoint kept failing, so Raft paused push delivery. ${stillInInbox} `
        + "Raft keeps checking the endpoint and resumes push delivery by itself once it answers again. If it stays paused, check the runtime's push endpoint; registering it again resumes delivery at once.",
    ...(input.agentUrl ? [`Agent page: ${input.agentUrl}`] : []),
  ].join("\n");
}

export function agentAutomaticWakePausedNoticeText(input: {
  agentName: string;
  earlyExits: number;
  tasks: ReadonlyArray<{ ref: string; title: string }>;
  moreTasks: number;
  hiddenTasks: number;
  agentUrl: string | null;
}): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const hasTasks = input.tasks.length + input.moreTasks + input.hiddenTasks > 0;
  return [
    `@${input.agentName} is no longer woken automatically: it exited early ${input.earlyExits} times in a row.`,
    ...(input.tasks.length > 0
      ? [
        "Open tasks assigned to it:",
        ...input.tasks.map((task) => `- ${task.ref} ${task.title}`),
        ...(input.moreTasks > 0 ? [`and ${input.moreTasks} more`] : []),
      ]
      : []),
    ...(input.hiddenTasks > 0
      ? [`${input.tasks.length > 0 ? "Also " : ""}${plural(input.hiddenTasks, "open task", "open tasks")} assigned to it in channels you can't see.`]
      : []),
    hasTasks
      ? "Restarting it from its page resumes automatic wakes. Its tasks can be reassigned."
      : "Restarting it from its page resumes automatic wakes.",
    ...(input.agentUrl ? [`Agent page: ${input.agentUrl}`] : []),
  ].join("\n");
}

function formatRetryDelay(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${Math.round(minutes / 60)} hours`;
}

export function agentStartTimeoutPausedNoticeText(input: {
  agentName: string;
  runtime: string;
  model: string | null;
  failedStarts: number;
  retryInMs: number | null;
  agentUrl: string | null;
}): string {
  const runtimeName = getRuntimeDisplayName(input.runtime);
  const cause = input.model
    ? `its model (${input.model}) may be slow, queued or rate-limited by its provider`
    : "its model provider may be slow, queued or rate-limited";
  return [
    `@${input.agentName} could not start: ${runtimeName} did not respond ${input.failedStarts} times in a row; ${cause}.`,
    input.retryInMs !== null
      ? `Automatic wakes are paused. Raft tries again by itself in about ${formatRetryDelay(input.retryInMs)}, then less often while it keeps failing; messages and reminders wait until then.`
      : "Automatic wakes are paused; messages and reminders wait.",
    "To resume now, restart the agent, or switch it to another model.",
    ...(input.agentUrl ? [`Agent page: ${input.agentUrl}`] : []),
  ].join("\n");
}

/** What happened and what gets the agent going again, by reason (enum and display names only). */
function startFailureCopy(reason: string, runtimeName: string): { cause: string; remedy: string } {
  const fixThenRestart = "Messages and reminders wait until you fix it and restart the agent, or change its model or runtime.";
  switch (reason) {
    case "runtime_login_required":
      return { cause: `${runtimeName} needs you to log in on its computer`, remedy: fixThenRestart };
    case "model_not_configured":
    case "model_not_found":
      return { cause: `its model is not available for ${runtimeName} on its computer`, remedy: fixThenRestart };
    case "runtime_config_invalid":
      return { cause: `${runtimeName}'s configuration on its computer is invalid`, remedy: fixThenRestart };
    case "provider_api_key_invalid":
      return { cause: "its provider API key is malformed", remedy: fixThenRestart };
    case "env_var_not_allowed":
      return {
        cause: "its settings set an environment variable its computer no longer accepts from the server (such as PATH or NODE_OPTIONS)",
        remedy: "Messages and reminders wait until you remove that variable from the agent's environment variables and restart the agent.",
      };
    case "runtime_version_too_old":
      return {
        cause: `the ${runtimeName} version on its computer is known not to work with Raft`,
        remedy: `Messages and reminders wait until you update ${runtimeName} on that computer and restart the agent.`,
      };
    case "session_needs_reset":
      // Restarting resumes the same session (the web says the same).
      return {
        cause: "its saved runtime session cannot be resumed",
        remedy: "Messages and reminders wait until you choose Reset Session & Restart on the agent page (members see Reset Model); a plain restart resumes the same session.",
      };
    case "session_runtime_mismatch":
      return {
        cause: `its saved runtime session was made by another ${runtimeName} version line`,
        remedy: "Messages and reminders wait until you choose Reset Session & Restart on the agent page (members see Reset Model), "
          + `or install the ${runtimeName} version line the session was made with on that computer and restart the agent; a plain restart resumes the same session.`,
      };
    default:
      return { cause: `${runtimeName} failed to start`, remedy: fixThenRestart };
  }
}

export function agentStartFailurePausedNoticeText(input: {
  agentName: string;
  runtime: string;
  reason: string;
  agentUrl: string | null;
}): string {
  const runtimeName = getRuntimeDisplayName(input.runtime);
  const copy = startFailureCopy(input.reason, runtimeName);
  return [
    `@${input.agentName} still could not start: ${copy.cause}. The agent page shows the error.`,
    `Raft no longer tries again by itself. ${copy.remedy}`,
    ...(input.agentUrl ? [`Agent page: ${input.agentUrl}`] : []),
  ].join("\n");
}

/** The last failure of a self-retrying pause's try, by reason (enum and display names only). */
function pauseRetryLastErrorCopy(reason: string, runtimeName: string): string {
  switch (reason) {
    case "runtime_repeated_failure":
      return `${runtimeName} kept failing after it started (the same error again and again, or crashes in a row)`;
    case "runtime_start_timeout":
      return `${runtimeName} did not respond`;
    default:
      return startFailureCopy(reason, runtimeName).cause;
  }
}

export function agentPauseRetryCappedNoticeText(input: {
  agentName: string;
  runtime: string;
  /** The reason of the last failure. */
  reason: string;
  retryEveryMs: number;
  agentUrl: string | null;
}): string {
  const runtimeName = getRuntimeDisplayName(input.runtime);
  return [
    `@${input.agentName} still can't run: its automatic tries keep failing. Last error: ${pauseRetryLastErrorCopy(input.reason, runtimeName)}. The agent page shows the error.`,
    `Raft keeps trying again automatically every ${formatRetryDelay(input.retryEveryMs)}; messages and reminders wait until a try works.`,
    "To get it going sooner, change its model or settings, or restart it.",
    ...(input.agentUrl ? [`Agent page: ${input.agentUrl}`] : []),
  ].join("\n");
}
