import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { SystemMessage, SystemMessageContent, SystemMessageTime } from "@botiverse/raft-ui";
import type { AgentOperatorEventView } from "@botiverse/raft-shared";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import ConnectedSystemMessageGroupDisclosure from "../message/SystemMessageGroupDisclosure";
import { OPERATOR_EVENTS_FOLD_AT, operatorEventText } from "./operatorEventsTimeline";

/**
 * #proj-runtime:#51: what people did to the agent (start, stop, restart,
 * reset, Stop Current Turn, migration, model change), and Raft's own
 * restarts, as thin system lines between the overview's turns (design A,
 * xxchan #proj-runtime:d9875bae). Three or more in a row fold into one line.
 * Raft's own restarts are fainter and name no one.
 */

function OperatorEventLine({ event }: { event: AgentOperatorEventView }) {
  const intl = useIntl();
  const { formatClock } = useTimeFormatter();
  const text = operatorEventText(intl, event);
  const system = event.actor.kind === "system";
  return (
    <SystemMessage
      data-testid="activity-overview-operator-event"
      data-actor={system ? "system" : "user"}
      // Raft's own restarts are fainter than a person's action.
      className={system ? "opacity-60" : undefined}
    >
      <SystemMessageTime>{formatClock(event.at)}</SystemMessageTime>
      <SystemMessageContent title={text}>
        <span className="block truncate">{text}</span>
      </SystemMessageContent>
    </SystemMessage>
  );
}

/** One run of consecutive events, oldest first. */
export function OperatorEventLines({ events }: { events: readonly AgentOperatorEventView[] }) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((open) => !open), []);
  if (events.length === 0) return null;
  if (events.length < OPERATOR_EVENTS_FOLD_AT) {
    return <div className="flex flex-col">{events.map((event) => <OperatorEventLine key={event.id} event={event} />)}</div>;
  }
  const latest = operatorEventText(intl, events[events.length - 1]!);
  return (
    <div data-testid="activity-overview-operator-events-folded">
      <ConnectedSystemMessageGroupDisclosure
        summary={intl.formatMessage({ id: "activity.overview.operator.folded" }, { count: events.length, latest })}
        expanded={expanded}
        onToggle={toggle}
      >
        {events.map((event) => <OperatorEventLine key={event.id} event={event} />)}
      </ConnectedSystemMessageGroupDisclosure>
    </div>
  );
}

