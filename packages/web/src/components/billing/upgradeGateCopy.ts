import type { IntlShape } from "react-intl";
import {
  FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES,
  FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES,
  MAX_FREE_SERVER_HOSTED_JOINT_CHANNELS,
  MAX_JOINT_CHANNEL_FREE_SERVERS,
  PLAN_CONFIG,
  PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES,
} from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages";
import type { ExternalLimitContext, HistoryLimitContext, UpgradeGate } from "../../store/upgradeDialogStore";
import { hiddenMessageDateFormat } from "../message/historyPaywallLabels";

/**
 * The upgrade dialog's words for each paywall, apart from the dialog
 * (UpgradeDialog.tsx, loaded when it opens): an agent's upgrade card in a
 * message row reads the same copy.
 */

/** The query parameter Stripe brings back: which paywall the payment started from. */
export const UPGRADE_RETURN_PARAM = "upgrade";
/** Set beside it when the payment was cancelled. */
export const UPGRADE_CANCELED_PARAM = "upgradeCanceled";
/** What opened the dialog when not a paywall (an agent's card), so a cancelled payment reopens it as the same. */
export const UPGRADE_SOURCE_PARAM = "upgradeSource";
/** Plan & Billing's billing entry, so a cancelled payment reopened there is still counted from Settings. */
export const UPGRADE_ENTRY_PARAM = "upgradeEntry";
/** Renewing prepaid Pro: the paid end before the payment, so the return can tell when the renewal landed. */
export const UPGRADE_RENEW_FROM_PARAM = "upgradeRenewFrom";
/** Where on the page the paywall was met, so a cancelled payment reopened there still counts from it. */
export const UPGRADE_SURFACE_PARAM = "upgradeSurface";
/**
 * The server paid for, when it isn't the current one: a page outside the app
 * (the invite and approval pages) upgrades a server of the viewer's in place
 * (ServerUpgradeDialog), and Stripe brings them back to that page.
 */
export const UPGRADE_SERVER_PARAM = "upgradeServer";
/** Every parameter of a Stripe return. */
export const UPGRADE_RETURN_PARAMS = [UPGRADE_RETURN_PARAM, UPGRADE_CANCELED_PARAM, UPGRADE_SOURCE_PARAM, UPGRADE_ENTRY_PARAM, UPGRADE_RENEW_FROM_PARAM, UPGRADE_SURFACE_PARAM, UPGRADE_SERVER_PARAM] as const;

type GateCopy = { title: MessageId; hint: MessageId; ask: MessageId; done: MessageId };
// No specific limit (an agent's upgrade card without a gate): what Pro lifts overall.
const GENERAL_COPY: GateCopy = { title: "upgradeDialog.general.title", hint: "upgradeDialog.general.hint", ask: "upgradeDialog.general.ask", done: "upgradeDialog.general.done" };
export const GATE_COPY: Record<UpgradeGate, GateCopy> = {
  history_30d: { title: "upgradeDialog.history.title", hint: "upgradeDialog.history.hint", ask: "upgradeDialog.history.ask", done: "upgradeDialog.history.done" },
  upload_monthly_quota: { title: "upgradeDialog.uploadQuota.title", hint: "upgradeDialog.uploadQuota.hint", ask: "upgradeDialog.uploadQuota.ask", done: "upgradeDialog.uploadQuota.done" },
  upload_file_size: { title: "upgradeDialog.fileSize.title", hint: "upgradeDialog.fileSize.hint", ask: "upgradeDialog.fileSize.ask", done: "upgradeDialog.fileSize.done" },
  joint_channel_free_cap: { title: "upgradeDialog.jointFreeCap.title", hint: "upgradeDialog.jointFreeCap.hint", ask: "upgradeDialog.jointFreeCap.ask", done: "upgradeDialog.jointFreeServers.done" },
  joint_channel_host_limit: { title: "upgradeDialog.jointHostLimit.title", hint: "upgradeDialog.jointHostLimit.hint", ask: "upgradeDialog.jointHostLimit.ask", done: "upgradeDialog.jointHostLimit.done" },
  joint_channel_over_limit: { title: "upgradeDialog.jointOverLimit.title", hint: "upgradeDialog.jointOverLimit.hint", ask: "upgradeDialog.jointOverLimit.ask", done: "upgradeDialog.jointFreeServers.done" },
  joint_channel_read_only: { title: "upgradeDialog.jointReadOnly.title", hint: "upgradeDialog.jointReadOnly.hint", ask: "upgradeDialog.jointReadOnly.ask", done: "upgradeDialog.jointFreeServers.done" },
  agent_migration: { title: "upgradeDialog.migration.title", hint: "upgradeDialog.migration.hint", ask: "upgradeDialog.migration.ask", done: "upgradeDialog.migration.done" },
  plan_downgraded: { title: "upgradeDialog.downgraded.title", hint: "upgradeDialog.downgraded.hint", ask: "upgradeDialog.downgraded.ask", done: "upgradeDialog.downgraded.done" },
  pro_theme: { title: "upgradeDialog.proTheme.title", hint: "upgradeDialog.proTheme.hint", ask: "upgradeDialog.proTheme.ask", done: "upgradeDialog.proTheme.done" },
  // The Free plan's one external channel (cindyz, Warden): the server's slot is
  // in use (its words for a named channel: externalLimitCopy), or the server is
  // in more than one and read-only in all of them.
  external_channel_free_limit: { title: "upgradeDialog.externalLimit.title", hint: "upgradeDialog.externalLimit.hint", ask: "upgradeDialog.externalLimit.ask", done: "upgradeDialog.externalLimit.done" },
  external_channel_frozen: { title: "upgradeDialog.externalFrozen.title", hint: "upgradeDialog.externalFrozen.hint", ask: "upgradeDialog.externalFrozen.ask", done: "upgradeDialog.externalFrozen.done" },
  general: GENERAL_COPY,
};

export function gateValues(server: string) {
  return {
    server,
    days: PLAN_CONFIG.free.limits.messageHistoryDays,
    monthly: `${FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES / (1024 * 1024)} MB`,
    single: `${FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES / (1024 * 1024)} MB`,
    proSingle: `${PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES / (1024 * 1024)} MB`,
    freeServers: MAX_JOINT_CHANNEL_FREE_SERVERS,
    hosts: MAX_FREE_SERVER_HOSTED_JOINT_CHANNELS,
  };
}

/**
 * The message to an owner the dialog starts with for `gate`, at most `max`
 * characters (Unicode code points, as a request card's reason counts them):
 * a server name too long for that is cut short with an ellipsis, wherever it
 * appears, so the person can send the request as written (a server name runs
 * to 100 characters and the copy names it up to twice). The external channel
 * limit's names the channel holding the slot when `externalContext` has one;
 * a channel name too long for that (names have no limit, and the channel is
 * never cut) falls back to the message that names none.
 */
export function askOwnerPrefill(
  formatMessage: IntlShape["formatMessage"],
  gate: UpgradeGate,
  serverName: string,
  max: number,
  externalContext?: ExternalLimitContext,
): string {
  const channel = gate === "external_channel_free_limit" && externalContext?.kind === "slot" ? externalContext.channel : undefined;
  const id: MessageId = channel ? "upgradeDialog.externalLimit.askChannel" : GATE_COPY[gate].ask;
  const ask = (server: string) => formatMessage({ id }, { ...gateValues(server), channel });
  const length = (text: string) => Array.from(text).length;
  const full = ask(serverName);
  if (length(full) <= max) return full;
  const rest = length(ask(""));
  const uses = length(ask("x")) - rest;
  const room = uses > 0 ? Math.floor((max - rest) / uses) : 0;
  // No room for even one character and the ellipsis: the message without the
  // channel, else leave it for the person to edit.
  if (room < 2) return channel ? askOwnerPrefill(formatMessage, gate, serverName, max) : full;
  return ask(`${Array.from(serverName).slice(0, room - 1).join("").trimEnd()}…`);
}

/**
 * What the dialog says about one paywall: its title and the line under it. The one source
 * of this copy: the dialog's own frame and an agent's upgrade card (`plan:upgrade`) both
 * read it.
 */
export function upgradeGateCopy(
  formatMessage: IntlShape["formatMessage"],
  gate: UpgradeGate,
  serverName: string,
): { title: string; hint: string } {
  const copy = GATE_COPY[gate];
  const values = gateValues(serverName);
  return {
    title: formatMessage({ id: copy.title }, values),
    hint: formatMessage({ id: copy.hint }, values),
  };
}

/**
 * What the external channel limit's dialog says instead of the gate's own
 * title or line, when its Upgrade said where it was met: the channel holding
 * the server's one Free slot (or the open invite to it), or, upgrading this
 * server to connect it to another server's channel, that channel. Nothing for
 * a slot without a channel: the gate's own words.
 */
export function externalLimitCopy(
  formatMessage: IntlShape["formatMessage"],
  context: ExternalLimitContext | undefined,
  serverName: string,
): { title?: string; hint?: string } {
  if (!context?.channel) return {};
  const values = { ...gateValues(serverName), channel: context.channel };
  if (context.kind === "connect") {
    return {
      title: formatMessage({ id: "upgradeDialog.externalConnect.title" }, values),
      hint: formatMessage({ id: "upgradeDialog.externalConnect.hint" }, values),
    };
  }
  return { hint: formatMessage({ id: context.openInvite ? "upgradeDialog.externalLimit.hintInvite" : "upgradeDialog.externalLimit.hintChannel" }, values) };
}

const HISTORY_HINT: Record<Exclude<HistoryLimitContext["kind"], "target">, { counted: MessageId; capped: MessageId }> = {
  channel: { counted: "upgradeDialog.history.hintChannel", capped: "upgradeDialog.history.hintChannelCapped" },
  thread: { counted: "upgradeDialog.history.hintThread", capped: "upgradeDialog.history.hintThreadCapped" },
  conversation: { counted: "upgradeDialog.history.hintConversation", capped: "upgradeDialog.history.hintConversationCapped" },
};

/**
 * The line under the title when a conversation's history paywall opened the
 * dialog (task #24, proposals C and C+): what the window hides there (how many
 * older messages, or when the opened message was sent), and that agents read
 * only the same days. Its date reads as the paywall card's does (`timeZone`).
 * `agentTries` (C+ step 2, the billing summary's agentHistoryBlocks7d) adds
 * how often this server's agents reached behind the window in the past 7
 * days, in the same sentence; 0 adds nothing.
 */
export function historyLimitHint(
  formatMessage: IntlShape["formatMessage"],
  formatDate: IntlShape["formatDate"],
  context: HistoryLimitContext,
  timeZone?: string | null,
  agentTries = 0,
): string {
  const days = PLAN_CONFIG.free.limits.messageHistoryDays;
  if (context.kind === "target") {
    const date = formatDate(context.sentAt, hiddenMessageDateFormat(context.sentAt, timeZone));
    return formatMessage({ id: "upgradeDialog.history.hintTarget" }, { date, days, agentTries });
  }
  const ids = HISTORY_HINT[context.kind];
  const channel = context.kind === "channel" ? context.channel : "";
  return formatMessage({ id: context.capped ? ids.capped : ids.counted }, { channel, count: context.count, days, agentTries });
}
