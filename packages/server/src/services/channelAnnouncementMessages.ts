/**
 * Channel announcements (#proj-chat:#29, channel_announcement_v0): setting,
 * replacing or removing a channel's announcement is a change to the channel,
 * like a rename, and posts one event line in its timeline (tygg, 2026-11-10;
 * raft-design channel.md "What posts in the channel"). A new version of the
 * announcement posts nothing: the strip going bold is that notice.
 *
 * The line is an ordinary system message (`channel.announcement`): born-read
 * for whoever made the change, unread activity for everyone else, never a push
 * (systemMessageBornReadRegistry), so it follows each person's mute like a
 * rename does. Its text is the English record agents and older clients read;
 * its `actionMetadata` (shared ChannelAnnouncementNotice) lets the web say it
 * in the reader's language.
 */
import type { Server as SocketServer } from "socket.io";
import {
  CHANNEL_ANNOUNCEMENT_NOTICE_KIND,
  channelAnnouncementChangeKind,
  channelAnnouncementChangeText,
  type ChannelAnnouncementNotice,
} from "@botiverse/raft-shared";
import { actorKey, actorProfiles } from "../platform/actors";
import { channelAnnouncementObjectKind } from "../apps/firstPartyApps";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { channelAnnouncementsInForce } from "./channelAnnouncements";
import * as messageService from "./messageService";

/**
 * Posts the event line for a change of `channelId`'s announcement from
 * `before` to `after` (object ids; null for none) by `actor`. Nothing when
 * they are the same (set again, or another field changed). The title is the
 * Artifact's now (the one removed, for a removal); a title that can't be read
 * leaves it out of the line. No line for a channel that has no announcements
 * now (channelAnnouncementsInForce). Never throws: a failure is logged, the
 * change already made stands.
 */
export async function postChannelAnnouncementChange(input: {
  io: SocketServer | null | undefined;
  agentOrchestrator: AgentOrchestrator | null | undefined;
  channelId: string;
  actor: { type: "user" | "agent"; id: string };
  before: string | null;
  after: string | null;
}): Promise<void> {
  const { io, agentOrchestrator, channelId, actor, before, after } = input;
  const change = channelAnnouncementChangeKind(before, after);
  if (!change || !io || !agentOrchestrator) return;
  const artifactId = (after ?? before)!;
  try {
    // A joint one side of which has announcements off has none: clearing what
    // is left of one there posts no line, so its title reaches no side that can't open it.
    if (!await channelAnnouncementsInForce(channelId)) return;
    const registered = channelAnnouncementObjectKind();
    const [headlines, profiles] = await Promise.all([
      registered ? registered.objectKind.channelAnnouncement.headlines([artifactId]) : Promise.resolve(new Map()),
      actorProfiles([actor]),
    ]);
    const title = headlines.get(artifactId)?.title ?? null;
    const profile = profiles.get(actorKey(actor));
    const notice: ChannelAnnouncementNotice = {
      kind: CHANNEL_ANNOUNCEMENT_NOTICE_KIND,
      change,
      actor: { type: actor.type, id: actor.id, name: profile?.displayName ?? null },
      artifactId,
      title,
    };
    // The record names the actor as the channel's other event lines do (`@handle`).
    const who = profile ? `@${profile.name}` : "Someone";
    await messageService.broadcastSystemMessage(io, agentOrchestrator, channelId, channelAnnouncementChangeText(change, who, title), {
      inboxFactPolicy: {
        mode: "record",
        producer: "channel.announcement",
        reason: "a change of the channel's announcement is shared channel activity",
        causalActor: actor,
      },
      actionMetadata: notice,
    });
  } catch (err) {
    console.error("channel announcement: failed to post the change line:", err);
  }
}
