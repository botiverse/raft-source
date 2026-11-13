// Action card: rendered inline as the body of a regular agent message row
// when the message's `actionMetadata.kind === "action-card"`. The agent (or a
// person, or Raft) prepared it; a human runs it under their own identity.
// The card is drawn from the spec the server built for it
// (`presentation.card`, `action-card.v1`: ActionCardSpecCard.tsx); there is no
// card drawn by type.

import { useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { CircleHelp } from "lucide-react";
import {
  MessageActionCard,
  MessageActionCardCollapseTrigger,
  MessageActionCardContent,
  MessageActionCardHeader,
  MessageActionCardHeaderIcon,
  MessageActionCardHeaderDescription,
  MessageActionCardHeaderTitle,
  MessageActionCardNotice,
  MessageActionCardProperties,
  MessageActionCardProperty,
  MessageActionCardPropertyLabel,
  MessageActionCardPropertyValue,
  MessageActionCardStatus,
} from "@botiverse/raft-ui";
import { STORED_ACTION_CARD_ACTION_TYPES } from "@botiverse/raft-shared";
import type { ActionCardMetadata } from "@botiverse/raft-shared";
import { CommittedByLine } from "./actionCardCommon";
import { isActionCardShownExpired, useExpiredCardLine } from "./actionCardExpired";
import { ActionCardSpecCard } from "./ActionCardSpecCard";
import { readActionCardSpec } from "./actionCardSpecRead";

interface Props {
  messageId: string;
  metadata: ActionCardMetadata;
  /** Channel of the carrier message. Thread carriers resolve authority from
   *  their parent channel, matching the server writer. */
  channelId: string;
  /** The channel the carrier conversation hangs off, as the surface knows it:
   *  a thread's or a task conversation's parent channel. */
  parentChannelId?: string;
}

/**
 * A card the server describes as data (`presentation.card`, valid for this
 * client) renders from that spec, whatever its type. A button the spec frame
 * can't run is Reload on the web and "Open in web" on Raft Desktop
 * (actionCardUnrunnableOpensInWeb); the card stays the spec card. The web
 * does not read the `action_card_spec` flag (old Apps and old desktop builds
 * still do): the server always sends the card, and adds it on read to a card
 * stored before specs existed.
 *
 * Without a spec that reads (none stored, or the read parse refuses it), any
 * card, of a type this build knows or not, renders view only from the
 * server's display-only `presentation` envelope (UnknownActionCard): nothing
 * here runs a card except from its spec.
 *
 * A person's card (task #10: a seat request, a member asking for Pro, the
 * agent:create card an owner sends back) is the same card as an agent's: the
 * same spec, the same access rules by type.
 */
export function ActionCard(props: Props) {
  const rawSpec = props.metadata.presentation?.card;
  const spec = useMemo(() => readActionCardSpec(rawSpec), [rawSpec]);
  return spec ? <ActionCardSpecCard {...props} card={spec} /> : <UnknownActionCard metadata={props.metadata} />;
}

/**
 * View-only card for a card with no spec this build can read. It never
 * executes, which keeps every confirm on the spec path. Its line under the
 * title (Kirby, #proj-apps:#40):
 * - done: who ran it and when;
 * - ended: the state it was served (Expired, with its line), as the spec card
 *   draws it;
 * - a type this build knows (a card the server could not build a spec for,
 *   such as a retired type): no longer available, ask the agent again; a
 *   reload would not help;
 * - a type new to this build (shipped after this bundle loaded, or a spec
 *   from a newer catalog): reload to see it.
 */
function UnknownActionCard({ metadata }: { metadata: ActionCardMetadata }) {
  const { formatMessage } = useIntl();
  const presentation = metadata.presentation ?? null;
  const isExecuted = metadata.state === "executed";
  const isExpired = isActionCardShownExpired(metadata);
  const expiredLine = useExpiredCardLine(metadata);
  const isFrozen = metadata.state === "frozen";
  const knownType = (STORED_ACTION_CARD_ACTION_TYPES as readonly string[]).includes(metadata.action?.type);
  const [open, setOpen] = useState(false);
  const description = isExecuted
    ? metadata.executedByUserName ? <CommittedByLine metadata={metadata} /> : null
    : isExpired
      ? expiredLine
      : formatMessage({ id: knownType ? "actionCard.unknown.retired" : "actionCard.unknown.reload" });
  // The same words and tones as the spec card's status (ActionCardSpecCard).
  const status = isExecuted
    ? ({ variant: "success", id: "actionCard.done" } as const)
    : isExpired
      ? ({ variant: "muted", id: "actionCard.person.status.expired" } as const)
      : isFrozen
        ? ({ variant: "muted", id: "actionCard.frozen" } as const)
        : ({ variant: "muted", id: "actionCard.status.viewOnly" } as const);
  return (
    <MessageActionCard
      className="action-card text-left"
      open={open}
      onOpenChange={setOpen}
      data-state={metadata.state}
      data-select-screenshot-action-card="true"
    >
      <MessageActionCardHeader>
        <MessageActionCardHeaderIcon>
          <CircleHelp />
        </MessageActionCardHeaderIcon>
        <MessageActionCardHeaderTitle>
          {presentation?.title || formatMessage({ id: "actionCard.unknown.title" })}
          {description ? <MessageActionCardHeaderDescription>{description}</MessageActionCardHeaderDescription> : null}
        </MessageActionCardHeaderTitle>
        <MessageActionCardStatus variant={status.variant} data-select-screenshot-action-control="true">
          {formatMessage({ id: status.id })}
        </MessageActionCardStatus>
        <MessageActionCardCollapseTrigger
          aria-label={formatMessage({ id: "actionCard.toggleDetails" })}
          data-select-screenshot-action-control="true"
        />
      </MessageActionCardHeader>
      <MessageActionCardContent data-select-screenshot-action-detail="true">
        {presentation?.warning ? <MessageActionCardNotice>{presentation.warning}</MessageActionCardNotice> : null}
        {presentation && presentation.displayItems.length > 0 ? (
          <MessageActionCardProperties>
            {presentation.displayItems.map((item) => (
              <MessageActionCardProperty key={item.key}>
                <MessageActionCardPropertyLabel>{item.key}</MessageActionCardPropertyLabel>
                <MessageActionCardPropertyValue className={item.redacted ? "text-foreground-hint" : undefined}>
                  {item.value}
                </MessageActionCardPropertyValue>
              </MessageActionCardProperty>
            ))}
          </MessageActionCardProperties>
        ) : null}
      </MessageActionCardContent>
    </MessageActionCard>
  );
}
