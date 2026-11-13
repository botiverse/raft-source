// Entities an action card names by reference (`EntityRef`, a Msg param, a
// Field value, a navigate target), drawn: a chip or a link, or the server's
// plain `fallback` when the viewer can't see it (actionCardEntities.ts looks
// them up). People and agents go by their display names (DS writing.md,
// Voice): the handle is for mentions in what someone writes, not for the
// product's own text.

import { useCallback, useMemo } from "react";
import { MessageReferenceChip, MessageReferenceText } from "@botiverse/raft-ui";
import type { ActionCardSpecEntityRef, ActionCardSpecNavigateTarget } from "@botiverse/raft-shared";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import type { Channel } from "../../store/channelStore";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import { useProfileStore } from "../../store/profileStore";
import { useTaskStore } from "../../store/taskStore";
import { openConversationAgentProfile } from "../../utils/profilePanelUrl";
import MentionLink from "../message/MentionLink";
import { useOpenTask } from "../task/useOpenTask";
import { useEntityLookupFor } from "./actionCardEntities";

// A fallback names someone or something the viewer can't open: bold as the
// link it would be, except a Computer's, whose name is plain text (a name
// someone gave it, not machine text, typography.md).
const FALLBACK_CLASS = "font-semibold text-foreground";

/**
 * A reference where rich text is allowed (title, Text, Notice, Field): a
 * person or an agent as their display name in bold ink, a link to their
 * profile with its hover card (never the yellow "you" sticker: a card names
 * people, it doesn't mention them); a channel as the pink reference chip, a
 * Computer as the cyan one (navigation.md, Going somewhere); or the plain
 * fallback. `inline`: bold link text, never a chip, for a line that must keep
 * its height (the folded done header).
 */
export function ActionCardEntityChip({ entityRef, inline = false }: { entityRef: ActionCardSpecEntityRef; inline?: boolean }) {
  // Only this entity: a list of chips doesn't re-render when another agent or channel changes.
  const entity = useEntityLookupFor([entityRef])(entityRef);
  const navigate = useActionCardNavigate();
  if (!entity) {
    return <span className={entityRef.kind === "computer" ? undefined : FALLBACK_CLASS} data-action-card-entity="fallback">{entityRef.fallback}</span>;
  }
  switch (entity.kind) {
    case "user":
    case "agent":
      return (
        <span data-action-card-entity={entity.kind}>
          <MentionLink
            mentionType={entity.kind}
            mentionId={entity.id}
            fallbackLabel={entity.handle}
            fallbackAgent={entity.kind === "agent" ? entity.agent : undefined}
            fallbackMember={entity.kind === "user" ? entity.member : undefined}
            onNavigateAgent={navigate.openAgentProfile}
            onNavigateHuman={navigate.openHumanProfile}
            highlightSelf={false}
          >
            {entity.name}
          </MentionLink>
        </span>
      );
    case "channel": {
      // The sigil the message body's channel chips carry.
      const channelRef = `#${entity.name}`;
      const link = <a href="#" onClick={(event) => { event.preventDefault(); navigate.toChannel(entity.channel); }}>{channelRef}</a>;
      return inline
        ? <MessageReferenceText variant="secondary" data-action-card-entity="channel" render={link} />
        : <MessageReferenceChip variant="accent" data-action-card-entity="channel" data-action-card-chip="" render={link} />;
    }
    case "computer": {
      const link = <a href="#" onClick={(event) => { event.preventDefault(); navigate.toComputer(entity.id); }}>{entity.name}</a>;
      return inline
        ? <MessageReferenceText variant="secondary" data-action-card-entity="computer" render={link} />
        : <MessageReferenceChip variant="link" data-action-card-entity="computer" data-action-card-chip="" render={link} />;
    }
  }
}

/**
 * Where a card's links and navigate buttons go, through the app's own
 * navigation: a channel or direct message, a message's permalink, a task, a
 * profile panel (what a mention opens), a Computer.
 */
export function useActionCardNavigate() {
  const nav = useAppNavigate();
  const openTask = useOpenTask();
  const openAgentProfile = useCallback((agentId: string) => {
    openConversationAgentProfile(useProfileStore.getState().openProfile, agentId, { openSource: "channel" });
  }, []);
  const openHumanProfile = useCallback((userId: string) => {
    useProfileStore.getState().openProfile("human", userId, { openSource: "channel" });
  }, []);
  return useMemo(() => {
    const knownChannel = (channelId: string) => {
      return findStoredChannel(useChannelStore.getState(), channelId);
    };
    return {
      openAgentProfile,
      openHumanProfile,
      toComputer: (machineId: string) => nav.toComputer(machineId),
      toChannel: (channel: Channel) => channel.type === "dm" ? nav.toDm(channel.id) : nav.toChannel(channel.id),
      /** A navigate button's target; the caller has checked it is on the viewer's server. */
      toTarget: (target: ActionCardSpecNavigateTarget) => {
        switch (target.kind) {
          case "channel":
            if (knownChannel(target.id)?.type === "dm") nav.toDm(target.id);
            else nav.toChannel(target.id);
            return;
          case "agent":
            openAgentProfile(target.id);
            return;
          case "user":
            openHumanProfile(target.id);
            return;
          case "message":
            if (knownChannel(target.channelId)?.type === "dm") nav.toDmMessage(target.channelId, target.id);
            else nav.toMessage(target.channelId, target.id);
            return;
          case "task": {
            // A task this tab has loaded opens as it does from the task list;
            // otherwise its channel's task tab, where it is listed.
            const state = useTaskStore.getState();
            const task = state.tasks.find((t) => t.id === target.id)
              ?? state.serverTasks.find((t) => t.id === target.id)
              ?? (state.tasksByChannelId[target.channelId] ?? []).find((t) => t.id === target.id);
            if (task) openTask(task);
            else nav.toChannel(target.channelId, { chatTab: "tasks" });
            return;
          }
        }
      },
    };
  }, [nav, openAgentProfile, openHumanProfile, openTask]);
}
