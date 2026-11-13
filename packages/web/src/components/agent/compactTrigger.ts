import type { ReactNode } from "react";
import type { IntlShape } from "react-intl";
import { formatTurnTrigger } from "./AgentActivityOverview";
import type { TurnSummaryView } from "./AgentActivityOverview";

/** Who woke a turn and where, short: "@Remy · #deploy", "DM from @xxchan"; the overview's sentence when it has no place. */
export function formatCompactTrigger(formatMessage: IntlShape["formatMessage"], trigger: TurnSummaryView["trigger"]): ReactNode | null {
  if (!trigger) return null;
  if (trigger.hidden) return formatMessage({ id: trigger.hidden === "dm" ? "agent.now.trigger.someDm" : "agent.now.trigger.private" });
  if (trigger.unresolved) return formatMessage({ id: "agent.now.trigger.unknown" });
  if (trigger.appEvent) return trigger.appEvent.appName;
  const display = trigger.display;
  if (display?.kind === "dm" && (display.senderName || display.peerName)) {
    return formatMessage({ id: "agent.now.trigger.dm" }, { sender: `@${display.senderName ?? display.peerName}` });
  }
  if ((display?.kind === "channel" || display?.kind === "thread") && display.senderName) {
    return formatMessage({ id: "agent.now.trigger.inChannel" }, { sender: `@${display.senderName}`, channel: display.channelName });
  }
  return formatTurnTrigger(formatMessage, trigger);
}
