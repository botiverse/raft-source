// Publishing through a personal assistant (#proj-assistant:#31): a caller
// that is not an Artifacts route (the assistant's own routes) makes a new
// Artifact, or a new version of one, for an author it names.
//
// The publish itself is the agent API's (publish.ts createPublishOperations):
// the same checks in the same order, the same refusals, the same quota and
// limits counted on the author, the same notices to followers. What this
// adds is the assistant's own rule (Tenny, #proj-assistant:#31): a new
// Artifact is marked with the assistant that published it
// (`items.published_by_assistant_agent_id`), and an assistant pushes a new
// version only to an Artifact that carries its own mark. An Artifact with
// another assistant's mark, or with none (a person's, another agent's, its
// owner's own), is refused: 403 NOT_PUBLISHED_BY_ASSISTANT. The author can't
// say this, since an assistant may publish as its owner.
//
// The author is the assistant itself, publishing into a conversation it can
// post in (its DM with its owner), or its owner, a person (#proj-assistant:#31
// step 3), publishing into a conversation the OWNER may post in, channels
// included. The caller decides where an assistant may publish and whether it
// may at all; this module takes the author and the home it is given, and
// checks them again:
//
// - an agent author as the agent API checks any agent (the home is one the
//   author can see and place into);
// - a person author by the person's own rules (publish.ts publishWith, the
//   same core): the Artifact by its id as the person sees it, while they
//   stand in the server (else the one 404 NOT_VISIBLE); a new version only
//   where the person may rename it (rename.ts mayRename, the viewer's
//   `capabilities.publish`; else 403 FORBIDDEN); a new Artifact's home a
//   top-level conversation the person may post in now (platform/conversations
//   postableConversation: not a thread, not archived or read-only; a joint's
//   canonical channel; else 404 TARGET_NOT_FOUND). The Artifact and its
//   version are the person's (creator, publisher, the object event's actor,
//   who follows it). The unseen-comments hold is the ASSISTANT's (Tenny,
//   option 2): its read position, comments by anyone but it (the owner's
//   too), and only its read position moves; the owner's read position and
//   Activity never do. Notices leave out the assistant (it isn't told of its
//   own push), and a quota refusal offers no upgrade card (the card is an
//   agent's to post). The answer names the home by id only, never by an
//   agent's names for conversations.
//
// Either way a new version needs the Artifact still homed in `requireHome`
// when given (an Artifact moved out answers as one not seen: the assistant
// should publish a new one), and the assistant's mark.
import type { AgentApiArtifactPublishBody, ServerId } from "@botiverse/raft-shared";
import { agentConversationRefs, postableConversation } from "../../platform/conversations";
import { standsInOwnServer } from "../../platform/visibility";
import {
  agentActor,
  answer,
  fail,
  json,
  notVisible,
  requireEnabled,
  resolveVisibleItem,
  resolveVisibleItemById,
  summarizeForPerson,
  targetNotFound,
  type ArtifactAgent,
  type ArtifactApiError,
  type ArtifactApiJson,
  type ArtifactNoticeOutbox,
} from "./apiCommon";
import { createPublishOperations, type PublishLocation, type Publisher } from "./publish";
import { mayRename } from "./rename";
import type { ArtifactItemRow } from "./schema";
import type { AppPaywallHit, AppPublishAsAnswer, AppPublishAsInput } from "../../platform/apps";

/** The agent API's push without `target` (named key by key: the body type also lets unknown keys through). */
export type ArtifactPublishAsRequest = Pick<AgentApiArtifactPublishBody, "artifact" | "title" | "description" | "entry" | "note" | "label" | "base" | "seen" | "files" | "delete">;

export interface ArtifactPublishAsInput {
  serverId: ServerId;
  /** Who the Artifact and its versions are by: the assistant itself, or its owner (a person of `serverId`). */
  author: { type: "agent" | "user"; id: string };
  /** The assistant publishing: a new Artifact's mark, and the mark a new version's Artifact must carry. */
  publishedByAssistantAgentId: string;
  /** A new Artifact's home: a conversation's id (one the author can see and post in; a person's: may post in). Unused for a new version. */
  home?: string;
  /**
   * For a new version: the conversation the Artifact must still live in, else it answers as one the author can't
   * see (the one 404 NOT_VISIBLE), before anything is said about whose it is. The assistant's DM with its current
   * owner: after a reassignment, or once it was moved out, the assistant can't push to it (Warden, #14524).
   */
  requireHome?: string;
  /**
   * The push, as the agent API's (`artifact` and `base` for a new version;
   * `title` and `files` for a new Artifact), without `target`: `home` names
   * the conversation. Files come inline (`content`, `content_base64`) or
   * carry over from the base; there is no upload step here, so a file listed
   * by `sha256` whose bytes the server lacks is refused (FILES_NOT_INLINE).
   */
  request: ArtifactPublishAsRequest;
  /** This request's notice outbox (core's appNoticeOutbox for the Artifacts app). */
  outbox: ArtifactNoticeOutbox;
}

export interface ArtifactPublishedAs {
  itemId: string;
  /** The version this request made, or the current one when it changed nothing (`unchanged`). */
  version: number;
  /** The Artifact's canonical link. */
  url: string;
  /** The conversation it is homed in, as the author's server knows it; null when it is homed elsewhere (the whole server, public). */
  homeConversationId: string | null;
  /** Nothing was written beyond, at most, the title: the current version already is what this request would make. */
  unchanged: boolean;
}

/** This module's own refusals, in the agent API's refusal shape (its codes are not the agent API's). */
export type ArtifactPublishAsRefusal = {
  kind: "error";
  status: 400 | 403;
  body: { code: "NOT_PUBLISHED_BY_ASSISTANT" | "HOME_REQUIRED" | "FILES_NOT_INLINE"; error: string; details?: Record<string, unknown> };
};

export type ArtifactPublishAsResult = ArtifactApiJson<ArtifactPublishedAs> | ArtifactApiError | ArtifactPublishAsRefusal;

const refuse = (status: 400 | 403, body: ArtifactPublishAsRefusal["body"]): ArtifactPublishAsRefusal => ({ kind: "error", status, body });

/**
 * The request's own fields and nothing a caller's wider body may carry beside
 * them (a route's schema can let unknown keys through): `target` in
 * particular is this module's to set, from `home`.
 */
export function knownRequest(request: ArtifactPublishAsRequest): ArtifactPublishAsRequest {
  const { artifact, title, description, entry, note, label, base, seen, files } = request;
  return {
    ...(artifact === undefined ? {} : { artifact }),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(entry === undefined ? {} : { entry }),
    ...(note === undefined ? {} : { note }),
    ...(label === undefined ? {} : { label }),
    ...(base === undefined ? {} : { base }),
    ...(seen === undefined ? {} : { seen }),
    files,
    ...(request.delete === undefined ? {} : { delete: request.delete }),
  };
}

const operations = createPublishOperations();

const notPublishedByAssistant = (item: ArtifactItemRow): ArtifactPublishAsRefusal => refuse(403, {
  code: "NOT_PUBLISHED_BY_ASSISTANT",
  error: "An assistant can push a new version only to an Artifact it published itself, and this one isn't: publish a new Artifact instead.",
  details: { artifact: item.id },
});

const homeRequired = (): ArtifactPublishAsRefusal => refuse(400, { code: "HOME_REQUIRED", error: "A new Artifact needs a home, the conversation whose members can see it." });

/** What the publish answered, as this module answers it. */
function publishedAs(result: Awaited<ReturnType<typeof operations.publish>>): ArtifactPublishAsResult {
  if (result.kind !== "json") return result;
  if ("missing" in result.body) {
    return refuse(400, {
      code: "FILES_NOT_INLINE",
      error: "Some files are listed by sha256, and the server doesn't have their bytes: send those files inline (content or content_base64).",
      details: { missing: result.body.missing },
    });
  }
  const { artifact, version, unchanged } = result.body;
  return json<ArtifactPublishedAs>({
    itemId: artifact.id,
    version: version.number,
    url: artifact.url,
    homeConversationId: artifact.home.kind === "conversation" ? artifact.home.conversation.id : null,
    unchanged,
  }, result.status);
}

/** A person may push a new version, or a new title: who may rename it (the viewer's `capabilities.publish`). */
const MAY_NOT_PUSH_AS_PERSON = "Only the artifact's author and the members of its own server who aren't guests can push to it: ask one of them to.";

/** The person author's publish (the file's header): its own checks, then publish.ts publishWith. */
async function publishAsPerson(input: ArtifactPublishAsInput, userId: string): Promise<ArtifactPublishAsResult> {
  const viewer = { type: "user" as const, id: userId, serverId: input.serverId };
  const assistantAgentId = input.publishedByAssistantAgentId;
  await requireEnabled(viewer);

  let located: PublishLocation;
  let body: AgentApiArtifactPublishBody;
  if (input.request.artifact !== undefined) {
    // A person who no longer stands in the server sees nothing of it here (a public Artifact included).
    if (!(await standsInOwnServer(viewer))) return notVisible();
    const existing = await resolveVisibleItemById(viewer, input.request.artifact);
    if (input.requireHome !== undefined && (existing.homeKind !== "conversation" || existing.homeChannelId !== input.requireHome)) return notVisible();
    if (existing.publishedByAssistantAgentId !== assistantAgentId) return notPublishedByAssistant(existing);
    if (!(await mayRename(viewer, existing))) return fail(403, { code: "FORBIDDEN", error: MAY_NOT_PUSH_AS_PERSON });
    located = { existing };
    body = { ...knownRequest(input.request), artifact: existing.id };
  } else {
    if (input.home === undefined) return homeRequired();
    // Posting asks the person's standing in the server first (core's channel access).
    const home = await postableConversation({ userId, serverId: input.serverId }, input.home);
    if (home === null) return targetNotFound({ home: input.home }, "push");
    // A joint's home is its canonical channel, the same on every server in it.
    located = { home: { kind: "conversation", channelId: home.homeChannelId } };
    body = knownRequest(input.request);
  }

  const publisher: Publisher = { actor: { type: "user", id: userId }, serverId: input.serverId, reader: agentActor({ agentId: assistantAgentId, serverId: input.serverId }) };
  return publishedAs(await operations.publishWith(publisher, body, input.outbox, {
    assistantAgentId,
    summaryOf: (items) => summarizeForPerson({ userId, serverId: input.serverId }, items),
    locate: async () => located,
  }));
}

export function publishArtifactAs(input: ArtifactPublishAsInput): Promise<ArtifactPublishAsResult> {
  return answer(async (): Promise<ArtifactPublishAsResult> => {
    if (input.author.type === "user") return publishAsPerson(input, input.author.id);
    const agent: ArtifactAgent = { agentId: input.author.id, serverId: input.serverId };
    const as = { assistantAgentId: input.publishedByAssistantAgentId };

    let body: AgentApiArtifactPublishBody;
    if (input.request.artifact !== undefined) {
      // What the author can't see answers as the agent API does (403 ARTIFACTS_NOT_ENABLED, the one 404 NOT_VISIBLE),
      // before anything is said about whose it is.
      const existing = await resolveVisibleItem(agent, input.request.artifact);
      if (input.requireHome !== undefined && (existing.homeKind !== "conversation" || existing.homeChannelId !== input.requireHome)) return notVisible();
      if (existing.publishedByAssistantAgentId !== as.assistantAgentId) return notPublishedByAssistant(existing);
      // By id from here: the publish resolves the same Artifact, not another one of the same title.
      body = { ...knownRequest(input.request), artifact: existing.id };
    } else {
      if (input.home === undefined) return homeRequired();
      // The conversation as the author addresses it; the publish checks from there that the author can see it and place into it.
      const target = (await agentConversationRefs(agent, [input.home])).get(input.home)?.target ?? null;
      if (target === null) return targetNotFound({ home: input.home }, "push");
      body = { ...knownRequest(input.request), target };
    }

    return publishedAs(await operations.publish(agent, body, input.outbox, as));
  });
}

/** publishArtifactAs as core's registry hands it out (register.ts actingFor): the refusal's code, sentence and details only. */
export async function publishArtifactAsForCore(input: AppPublishAsInput): Promise<AppPublishAsAnswer> {
  const result = await publishArtifactAs({ ...input, requireHome: input.home });
  if (result.kind === "json") return { kind: "json", status: result.status ?? 200, body: result.body };
  const body = result.body as { code: string; error: string; details?: Record<string, unknown> };
  const { retryAfterSeconds, paywallHit } = result as { retryAfterSeconds?: number; paywallHit?: AppPaywallHit };
  return {
    kind: "error",
    status: result.status,
    body: { code: body.code, error: body.error, ...(body.details ? { details: body.details } : {}) },
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    // A plan quota refusal: core records the paywall hit (Remy, #31), as for the agent API's own push.
    ...(paywallHit ? { paywallHit } : {}),
  };
}
