import { useIntl } from "react-intl";
import {
  MessageActionCard,
  MessageActionCardContent,
  MessageActionCardHeader,
  MessageActionCardHeaderDescription,
  MessageActionCardHeaderMeta,
  MessageActionCardHeaderTitle,
} from "@botiverse/raft-ui";
import type { TaskAssignmentNoticeParty } from "@botiverse/raft-shared";

import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import type { Message } from "../../store/messageStore";
import { useServerStore } from "../../store/serverStore";
import AvatarSlot from "../ui/AvatarSlot";
import { sameParty } from "./taskHandoffNotice";
import type { TaskHandoffNotice, TaskHandoffReturn } from "./taskHandoffNotice";

/** A party's avatar and the name people read, from the server's people and agents; the line's own names as a fallback. */
function usePartyIdentity(party: TaskAssignmentNoticeParty): { name: string; avatarUrl: string | null } {
  const agent = useAgentStore((s) => (party.type === "agent" ? s.agents.find((a) => a.id === party.id) ?? null : null));
  const member = useServerStore((s) => (party.type === "user" ? s.members.find((m) => m.userId === party.id) ?? null : null));
  const me = useAuthStore((s) => (party.type === "user" && s.user?.id === party.id ? s.user : null));
  const known = agent ?? member ?? me;
  return {
    name: known?.displayName || known?.name || party.displayName || party.name || "",
    avatarUrl: known?.avatarUrl ?? null,
  };
}

/** A party as the title names them: their avatar at the size of a name in text, then their @handle (their name without one). */
function PartyName({ party, identity }: { party: TaskAssignmentNoticeParty; identity: { name: string; avatarUrl: string | null } }) {
  return (
    <span className="inline-flex items-center gap-1 align-bottom">
      {party.type === "agent"
        ? <AvatarSlot context="creator-link" type="agent" agentAvatarUrl={identity.avatarUrl} />
        : <AvatarSlot context="creator-link" type="human" humanAvatarUrl={identity.avatarUrl} />}
      {partyHandle(party, identity)}
    </span>
  );
}

function partyHandle(party: TaskAssignmentNoticeParty, identity: { name: string }): string {
  return party.name ? `@${party.name}` : identity.name;
}

/**
 * A task handed to someone with a reason, in the task's conversation: who
 * handed it to whom ("[avatar] @Otter → [avatar] @xxchan", the two alike), when, and what it waits on them for
 * as the card's body, instead of the one-line system notice (the line's text
 * stays the record for agents and notifications). When the task later comes
 * back to whoever handed it off, the card says so and fades: "Otter took it
 * back · 10:51" when they took it, "xxchan handed it back to Otter · 10:51"
 * when someone else gave it back. The wait it describes is over.
 */
export function TaskHandoffCard({ message, notice, returned, time }: {
  message: Pick<Message, "id">;
  notice: TaskHandoffNotice;
  returned: TaskHandoffReturn | null | undefined;
  /** The line's time, as the timeline formats it. */
  time: string;
}) {
  const { formatMessage } = useIntl();
  const { formatMessageTime } = useTimeFormatter();
  const from = usePartyIdentity(notice.actor);
  const to = usePartyIdentity(notice.assignee);
  const toHandle = partyHandle(notice.assignee, to);
  // Who gave it back: the actor themselves (took it back) or someone else (handed it back).
  const returner = usePartyIdentity(returned?.by ?? notice.actor);
  const returnedBySomeoneElse = returned ? !sameParty(returned.by, notice.actor) : false;
  return (
    <div
      role="group"
      aria-label={formatMessage({ id: "task.handoff.label" }, { from: partyHandle(notice.actor, from), to: toHandle, taskNumber: notice.taskNumber })}
      className="py-1"
      data-testid="task-handoff-card"
      data-message-id={message.id}
      data-state={returned ? "returned" : "waiting"}
    >
      <MessageActionCard className={returned ? "opacity-60" : undefined}>
        <MessageActionCardHeader>
          <MessageActionCardHeaderTitle>
            <span className="break-words" data-testid="task-handoff-title">
              <PartyName party={notice.actor} identity={from} /> → <PartyName party={notice.assignee} identity={to} />
            </span>
            <MessageActionCardHeaderDescription data-testid="task-handoff-meta">
              {!returned
                ? <MessageActionCardHeaderMeta>{time}</MessageActionCardHeaderMeta>
                : returnedBySomeoneElse
                  ? formatMessage({ id: "task.handoff.handedBack" }, { by: returner.name, name: from.name, time: formatMessageTime(returned.at) })
                  : formatMessage({ id: "task.handoff.returned" }, { name: from.name, time: formatMessageTime(returned.at) })}
            </MessageActionCardHeaderDescription>
          </MessageActionCardHeaderTitle>
        </MessageActionCardHeader>
        <MessageActionCardContent>
          <p className="m-0 whitespace-pre-wrap break-words text-callout text-foreground" data-testid="task-handoff-reason">
            {notice.reason}
          </p>
        </MessageActionCardContent>
      </MessageActionCard>
    </div>
  );
}
