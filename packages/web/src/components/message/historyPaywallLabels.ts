import { currentTimeMs } from "@botiverse/raft-shared";
import { isLoungeChannel } from "../../store/channelDomain";

type PaywallChannel = { type?: string; name?: string | null; loungeAgentId?: string | null } | null | undefined;

/**
 * The name the history paywall gives the upgrade dialog for where it is: a
 * named channel as people read it (`#roadmap`). A DM, a thread or an agent's
 * lounge has none; the dialog calls those "this conversation" or "this thread".
 */
export function historyPaywallChannelName(channel: PaywallChannel): string | undefined {
  if (!channel?.name || channel.type === "dm" || channel.type === "thread" || isLoungeChannel(channel)) return undefined;
  return `#${channel.name}`;
}

/**
 * Where a conversation's history paywall is: its scope ("this channel", or
 * "here" in a DM; a thread shown as a channel counts replies and its first
 * message) and the channel name it gives the upgrade dialog.
 */
export function historyPaywallPlace(channel: PaywallChannel): { scope: "dm" | "thread" | "channel"; channelName: string | undefined } {
  const scope = channel?.type === "dm" ? "dm" : channel?.type === "thread" ? "thread" : "channel";
  return { scope, channelName: historyPaywallChannelName(channel) };
}

/**
 * How the paywall card and the upgrade dialog write the date a hidden message
 * was sent: month and day, with the year when it is not this year's.
 */
export function hiddenMessageDateFormat(
  sentAt: string,
  timeZone?: string | null,
): { month: "long"; day: "numeric"; year?: "numeric"; timeZone?: string } {
  const sameYear = new Date(sentAt).getUTCFullYear() === new Date(currentTimeMs()).getUTCFullYear();
  return { month: "long", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), ...(timeZone ? { timeZone } : {}) };
}
