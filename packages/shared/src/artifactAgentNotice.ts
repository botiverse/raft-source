// What an agent is told about an Artifact (S1c): the Artifacts app's
// notice, carried as the `app_event` (`{ ...notice, app: "artifacts", kind:
// "artifact" }`) the Server attaches to a system.artifacts notification, and
// everything `formatArtifactNotice` (agentText/artifactNotices.ts) needs to
// write it, so a client can render the notice itself (its own command style)
// instead of the Server's one-line summary. This schema is the one the app
// registers (agentNotice.schema); the Server sets `app_event` only on a
// payload that passes it.
//
// Who gets one (Sage's notices spec, agreed in #proj-workspace):
// - `mentioned`: @-mentioned in a comment; sent at once, never batched, and
//   being mentioned does not subscribe.
// - `subscribed`: others' comments on an Artifact the agent follows (it
//   published or commented there, or followed it); one per comment, sent at
//   once (until #55 batched per agent and Artifact over 2 minutes, so a
//   notice may still carry several comments).
// - `your_file_changed`: someone else published a version that changes a file
//   this agent was the last to publish. Other new versions are not sent; the
//   next read shows them.
// A review (S8) is one notice per agent, `mentioned` when its summary or any
// of its comments mentions the agent, else `subscribed`; it carries `review`.
// A rename (task #147: a person on the web, or an agent's push with only a
// title) tells the Artifact's other following agents, `subscribed` with
// `renamed`, so one that knew it by its old title can still find it.
// - `your_comment_resolved` (#249): someone else resolved a thread this agent
//   started; it carries `resolved`. Sent whether the agent follows or not (it
//   is about its own comment, as a mention is about it). A reopen tells no one.
// A channel's announcement (#proj-chat:#29, channel_announcement_v0): a new
// version of the Artifact a channel has as its announcement tells that
// channel's other agents, `subscribed` with `channelAnnouncement` (`following`,
// `comments` and `version` null; an agent already told `your_file_changed`
// is not told twice). Queued, never pushed: it wakes no agent.
// Visibility is checked when a notice is sent, not stored here.
import { z } from "zod";

import { agentApiArtifactActorSchema, agentApiArtifactCommentExcerptSchema } from "./agentApiArtifactsContract";
import { lazySchema } from "./lazySchema";

export const ARTIFACT_AGENT_NOTICE_REASONS = ["mentioned", "subscribed", "your_file_changed", "your_comment_resolved"] as const;
export type ArtifactAgentNoticeReason = (typeof ARTIFACT_AGENT_NOTICE_REASONS)[number];

export const artifactAgentNoticeSchema = lazySchema("artifactAgentNoticeSchema", () => z.object({
  artifact: z.object({ id: z.string(), title: z.string() }).passthrough(),
  reason: z.enum(ARTIFACT_AGENT_NOTICE_REASONS),
  /**
   * Why the agent follows the Artifact (`subscribed` only): it published
   * `version` (the last one it published), it commented, or it followed it.
   */
  following: z.object({
    kind: z.enum(["published", "commented", "followed"]),
    version: z.number().int().nullable(),
  }).passthrough().nullable(),
  /**
   * Comment notices (`mentioned`, `subscribed`): how many comments this
   * notice covers, and the newest few (oldest first), shaped as
   * artifactRead's unseen.comments. A mention is count 1, its comment in
   * `latest`.
   */
  comments: z.object({
    count: z.number().int().positive(),
    latest: z.array(agentApiArtifactCommentExcerptSchema).min(1),
  }).passthrough().nullable(),
  /**
   * Review notices (S8): the review as a whole. `comments` is filled too, so
   * a client from before S8 still writes a comment notice: `count` is the
   * review's comments, `latest` the ones that mention this agent (a
   * `mentioned` notice) or the review's last few, oldest first. Absent (or
   * null) for a single comment and a version.
   */
  review: z.object({
    /** The review's id: `artifactComments` with `review` lists its comments. */
    id: z.string(),
    author: agentApiArtifactActorSchema,
    version: z.number().int(),
    commentCount: z.number().int().positive(),
    /** Distinct files its comments are on (comments on the whole Artifact add none). */
    fileCount: z.number().int().nonnegative(),
    /** Its comments that mention this agent, the summary counted as one. */
    mentionsYou: z.number().int().nonnegative(),
    /** The summary's start (as a comment excerpt is cut), null without one. */
    summaryExcerpt: z.string().nullable(),
  }).passthrough().nullable().optional(),
  /**
   * Rename notices (`subscribed`, `comments` and `version` null): who gave
   * the Artifact a new title, and the title before and after (`to` is
   * `artifact.title`). A client from before it writes the notice as
   * "something changed" with a read of the Artifact's id. Absent (or null)
   * for every other notice.
   */
  renamed: z.object({
    by: agentApiArtifactActorSchema,
    from: z.string(),
    to: z.string(),
  }).passthrough().nullable().optional(),
  /**
   * Resolve notices (`your_comment_resolved`, `comments` and `version`
   * null): who resolved the agent's thread, its root comment (as an excerpt),
   * and the resolver's note's start, null without one. Absent (or null) for
   * every other notice.
   */
  resolved: z.object({
    by: agentApiArtifactActorSchema,
    comment: agentApiArtifactCommentExcerptSchema,
    noteExcerpt: z.string().nullable(),
  }).passthrough().nullable().optional(),
  /**
   * Announcement notices (`subscribed`; `following`, `comments` and
   * `version` null): the Artifact is the announcement of `channel` (as the
   * agent names it, `#name`), one of the agent's channels, and `publisher`
   * pushed its version `number`. A client from before it writes the notice
   * as "something changed" with a read of the Artifact's id. Absent (or
   * null) for every other notice.
   */
  channelAnnouncement: z.object({
    channel: z.string(),
    publisher: agentApiArtifactActorSchema,
    number: z.number().int(),
    note: z.string().nullable(),
  }).passthrough().nullable().optional(),
  /** Version notices (`your_file_changed`): the new version, and which of this agent's files it changed. */
  version: z.object({
    number: z.number().int(),
    publisher: agentApiArtifactActorSchema,
    note: z.string().nullable(),
    /** Files this agent was the last to publish, changed (or removed) in this version. */
    yourFiles: z.array(z.string()).min(1),
    /** The version in which this agent last published them. */
    yourVersion: z.number().int(),
  }).passthrough().nullable(),
}).passthrough());

export type ArtifactAgentNotice = z.infer<typeof artifactAgentNoticeSchema>;

/** An Artifacts notice as AgentMessage.app_event carries it. */
export type ArtifactAgentAppEvent = { app: "artifacts"; kind: "artifact" } & ArtifactAgentNotice;
