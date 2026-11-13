import { useIntl } from "react-intl";

import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import { useActorFallback } from "../../store/localTables/useActorFallback";
import { useServerStore } from "../../store/serverStore";
import type { Task } from "../../store/taskStore";
import AgentActivityDot from "../agent/AgentActivityDot";
import AvatarSlot from "../ui/AvatarSlot";

/** Who a task's assignee is, as far as the caller knows. */
export interface TaskAssigneeIdentity {
  displayName?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
}

/**
 * A task's assignee as people read it everywhere (task rows under a message,
 * the Tasks card, the dialog): the avatar and the display name — an agent's
 * avatar carries its presence light, and the reader is "You" (raft-design
 * patterns/tasks.md). Nothing when the task has no assignee.
 */
export function TaskAssigneeLabel({ task, identity, viewerId, testId = "channel-task-assignee", property = false, avatar = true }: {
  task: Task;
  identity: TaskAssigneeIdentity | null | undefined;
  viewerId: string | null | undefined;
  testId?: string;
  /** In a property list (DescriptionList inline): the name is a value like
   *  the others (the list's text size and ink, not the trigger's caption), on
   *  the list's baseline with the avatar centered beside it. */
  property?: boolean;
  /** Off where the caller shows the avatar itself (the dialog's Assignee,
   *  whose avatar is its own button: it opens the assignee's profile). */
  avatar?: boolean;
}) {
  const { formatMessage } = useIntl();
  if (!task.claimedById || !task.claimedByType) return null;
  const label = identity?.displayName || identity?.name || task.claimedByName || "";
  // Text on the baseline, marks centred (raft-design foundations/alignment.md),
  // in a task row and in a property alike: the name gives this label its
  // baseline, and the avatar, a mark, is centred beside it (a self-centred
  // avatar does not take part in baseline alignment).
  const rowClass = "flex min-w-0 items-baseline gap-1.5 [&>[data-avatar-context]]:self-center";
  // The name's own line box (22px, taller than the 19px avatar) sets the
  // trigger's height, so its baseline lands where a plain value's does.
  const textClass = property ? "truncate text-callout" : "truncate text-caption";
  const nameInk = property ? "font-normal text-foreground" : "text-foreground-muted";
  if (task.claimedByType === "agent") {
    return (
      <span className={rowClass} data-testid={testId}>
        {avatar ? <TaskAssigneeAvatar task={task} identity={identity} /> : null}
        <span className={`${textClass} ${nameInk}`}>{label}</span>
      </span>
    );
  }
  const isViewer = !!viewerId && task.claimedById === viewerId;
  return (
    <span className={rowClass} data-testid={testId}>
      {avatar ? <TaskAssigneeAvatar task={task} identity={identity} /> : null}
      <span className={isViewer ? `${textClass} font-semibold text-foreground` : `${textClass} ${nameInk}`}>
        {isViewer ? formatMessage({ id: "task.sidePanel.you" }) : label}
      </span>
    </span>
  );
}

/** The assignee's avatar (an agent's with its presence light). */
export function TaskAssigneeAvatar({ task, identity }: {
  task: Task;
  identity: TaskAssigneeIdentity | null | undefined;
}) {
  if (!task.claimedById || !task.claimedByType) return null;
  return task.claimedByType === "agent" ? (
    <AvatarSlot
      context="compact-list"
      type="agent"
      agentAvatarUrl={identity?.avatarUrl ?? null}
      badge={<AgentActivityDot agentId={task.claimedById} size="sm" />}
    />
  ) : (
    <AvatarSlot
      context="compact-list"
      type="human"
      humanAvatarUrl={identity?.avatarUrl ?? null}
    />
  );
}

/**
 * The assignee resolved from the server's people and agents (no per-channel
 * roster request), for task rows that are not given a renderer.
 */
export function TaskAssignee({ task }: { task: Task }) {
  const { identity, viewerId } = useTaskAssigneeIdentity(task);
  return <TaskAssigneeLabel task={task} identity={identity} viewerId={viewerId} />;
}

/** The assignee's identity from the server's people and agents (or the
 *  signed-in reader), and the reader's id: what TaskAssigneeLabel needs. In a
 *  joint channel an assignee from the other server is on neither list, so,
 *  like a message sender's face, it falls back to the actors table. */
export function useTaskAssigneeIdentity(task: Task): { identity: TaskAssigneeIdentity | null; viewerId: string | null } {
  const viewerId = useAuthStore((s) => s.user?.id ?? null);
  const identity = useAgentStore((s) => (task.claimedByType === "agent"
    ? s.agents.find((a) => a.id === task.claimedById) ?? null
    : null));
  const member = useServerStore((s) => (task.claimedByType === "user"
    ? s.members.find((m) => m.userId === task.claimedById) ?? null
    : null));
  const currentUser = useAuthStore((s) => (task.claimedByType === "user" && s.user?.id === task.claimedById ? s.user : null));
  const local = identity ?? member ?? currentUser;
  const inJointChannel = useChannelStore((s) => findStoredChannel(s, task.channelId)?.type === "joint");
  const onJointChannel = task.channelType === "joint" || inJointChannel;
  const actor = useActorFallback(
    onJointChannel && !local && task.claimedById && task.claimedByType
      ? { kind: task.claimedByType === "agent" ? "agent" : "human", id: task.claimedById }
      : null,
  );
  return { identity: local ?? actor ?? null, viewerId };
}
