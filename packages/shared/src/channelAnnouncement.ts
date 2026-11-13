/**
 * Channel announcements (#proj-chat:#29, flag `channel_announcement_v0`).
 *
 * A channel's announcement is one Artifact homed in that channel, set by the
 * channel's owner (its channel admin) or a Server owner or admin: nothing is
 * stored beside it, so its versions are the edit history, its comments the
 * discussion, and who sees it follows the channel. One per channel; public,
 * private and joint channels only (a joint's every side shows the same one).
 * An announcement whose Artifact was deleted, taken down or moved out of the
 * channel reads as none.
 */
import { z } from "zod";

import { parseArtifactRef } from "./artifactRef";
import { lazySchema } from "./lazySchema";
import { asArtifactId, type ArtifactId } from "./workspaceArtifacts";

/** What a channel payload carries as its announcement (`announcement`), only while the flag is on. */
export type ChannelAnnouncement = {
  /** The Artifact's id (`pt_…`). */
  artifactId: ArtifactId;
  title: string;
  /** Its current version. */
  version: number;
  /** When it last changed (ISO 8601). */
  updatedAt: string;
};

/**
 * The announcement as a person's web channel payload carries it: who pushed
 * its current version and that version's note, whether this person has seen
 * that version (the Artifact's own read state: opening its current version
 * marks it seen). It can't be hidden: a channel's announcement shows to
 * everyone in it whenever there is one ("a pin is a pin", tygg, 2026-11-10).
 */
export type ChannelAnnouncementForPerson = ChannelAnnouncement & {
  updatedBy: { type: "user" | "agent"; id: string; name: string | null };
  note: string | null;
  seen: boolean;
  /**
   * The first line of the current version's text (a Markdown version's
   * excerpt, the one its card shows), what the strip shows once the person has
   * seen it; null when there is none (an HTML page, a version from before
   * excerpts). Absent from an older server.
   */
  excerpt?: string | null;
};

/**
 * A change to which Artifact is a channel's announcement, as the one event
 * line it posts in the channel (tygg, 2026-11-10: set, replaced and removed
 * post; a new version of it never does). The line's text is the record
 * (agents, notifications, older clients read it: channelAnnouncementChangeText);
 * the web reads this, the system message's `actionMetadata`, to say it in the
 * reader's language.
 */
export const CHANNEL_ANNOUNCEMENT_NOTICE_KIND = "channel-announcement";

export type ChannelAnnouncementChangeKind = "set" | "replaced" | "removed";

export interface ChannelAnnouncementNotice {
  kind: typeof CHANNEL_ANNOUNCEMENT_NOTICE_KIND;
  change: ChannelAnnouncementChangeKind;
  /** Who changed it, with the name people read (a display name; null when it couldn't be resolved). */
  actor: { type: "user" | "agent"; id: string; name: string | null };
  /** The Artifact now the announcement (set, replaced) or the one removed. */
  artifactId: string;
  /** Its title when the change was made; null when it couldn't be read. */
  title: string | null;
}

/** Which change this is, from the announcement before and after (null: none); null when nothing changed. */
export function channelAnnouncementChangeKind(before: string | null, after: string | null): ChannelAnnouncementChangeKind | null {
  if (before === after) return null;
  if (after === null) return "removed";
  return before === null ? "set" : "replaced";
}

/**
 * The event line's text, the record (English; agents read it): `who` as the
 * channel's other event lines name an actor (`@handle`), the Artifact's title
 * when it could be read.
 */
export function channelAnnouncementChangeText(change: ChannelAnnouncementChangeKind, who: string, title: string | null): string {
  return title === null ? `${who} ${change} the channel announcement.` : `${who} ${change} the channel announcement: ${title}`;
}

/** The notice from a system message's `actionMetadata`; null for anything else. */
export function readChannelAnnouncementNotice(actionMetadata: unknown): ChannelAnnouncementNotice | null {
  if (!actionMetadata || typeof actionMetadata !== "object") return null;
  const metadata = actionMetadata as Record<string, unknown>;
  if (metadata.kind !== CHANNEL_ANNOUNCEMENT_NOTICE_KIND) return null;
  if (metadata.change !== "set" && metadata.change !== "replaced" && metadata.change !== "removed") return null;
  if (typeof metadata.artifactId !== "string" || !metadata.artifactId) return null;
  const actor = metadata.actor as Record<string, unknown> | null | undefined;
  if (!actor || typeof actor !== "object" || (actor.type !== "user" && actor.type !== "agent") || typeof actor.id !== "string") return null;
  return {
    kind: CHANNEL_ANNOUNCEMENT_NOTICE_KIND,
    change: metadata.change,
    actor: { type: actor.type, id: actor.id, name: typeof actor.name === "string" && actor.name ? actor.name : null },
    artifactId: metadata.artifactId,
    title: typeof metadata.title === "string" && metadata.title ? metadata.title : null,
  };
}


export const channelAnnouncementSchema = lazySchema("channelAnnouncementSchema", () => z.object({
  artifactId: z.string().transform(asArtifactId),
  title: z.string(),
  version: z.number().int().positive(),
  updatedAt: z.string(),
}).passthrough());

/** Channel types that may have an announcement: public, private and joint channels (never a DM, thread or task). */
export function channelTypeSupportsAnnouncement(type: string | null | undefined): boolean {
  return type === "channel" || type === "private" || type === "joint";
}

/**
 * The Artifact id an agent's `--announcement` names: an id (`pt_…` or a short
 * id) or a link to it, as `raft artifact read` takes them; null for anything
 * else (a title is not accepted: two Artifacts may share one).
 */
export function channelAnnouncementArtifactId(input: string): ArtifactId | null {
  const parsed = parseArtifactRef(input);
  return parsed.kind === "id" ? parsed.id : null;
}

/** Said when channelAnnouncementArtifactId finds no id. */
export const CHANNEL_ANNOUNCEMENT_REF_INVALID = "The announcement must be an Artifact's id (pt_…) or its link, not a title. Nothing was changed.";

/**
 * A push refused because the Artifact is the announcement of `channel`
 * (`#name`) and the pusher may not set that channel's announcement
 * (CHANNEL_ANNOUNCEMENT_PUSH_FORBIDDEN): the Server's sentence, and the next
 * step. A pulled folder pushed again with --target is refused
 * (ARTIFACT_DIR_CONFLICT), so the step names a copy.
 */
export function channelAnnouncementPushForbiddenText(channel: string, style: "cli" | "tool" = "cli"): { message: string; nextAction: string } {
  return {
    message: `This artifact is the announcement of ${channel}, so only its owner (one of its channel admins) or a server owner or admin can push a new version. Nothing was pushed.`,
    nextAction: style === "cli"
      ? `Ask one of them to push it, or copy the folder and push the copy as a new artifact: raft artifact push <copy> --target "${channel}" --title "<title>"`
      : `Ask one of them to push it, or push your change as a new artifact homed in ${channel}.`,
  };
}

/**
 * A person's change refused for the same reason (the web's rename of the
 * announcement Artifact; CHANNEL_ANNOUNCEMENT_PUSH_FORBIDDEN).
 */
export function channelAnnouncementChangeForbiddenText(channel: string): { message: string; nextAction: string } {
  return {
    message: `This artifact is the announcement of ${channel}, so only its channel admins or a server owner or admin can change it. Nothing was changed.`,
    nextAction: "Ask a channel admin.",
  };
}
