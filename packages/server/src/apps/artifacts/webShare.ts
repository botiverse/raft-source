// S5 on the web API: sending an Artifact to a conversation, who there couldn't
// see it, saving an attachment as an Artifact, and what attachments were saved
// as (contract: packages/shared webArtifactsContract.ts `share`,
// `shareAudience`, `saveAttachment`, `attachmentSaves`).
//
// Messages carry nothing about Artifacts (xxchan 2026-10-26): no field on a
// message or its attachments, no message table of the module's own. Sending
// is an ordinary message the person posts (platform/apps AppMessagePoster,
// core's checks and pipeline): the note, then the Artifact's link, which the
// web draws as the card. What an attachment was saved as is this module's own
// `attachment_saves`, read by the web through `attachmentSaves`.
//
// `POST /:id/share` checks, in this order: the flag (403
// ARTIFACTS_NOT_ENABLED), visibility (one 404 NOT_VISIBLE), the body (400
// INVALID_REQUEST), the note's length (400 FIELD_TOO_LONG), then the
// conversation (404 TARGET_NOT_FOUND wherever the person couldn't send the
// message themselves). With `widenTo`, once those passed and before anything
// is written (the poster's `beforeWrite`), the move to that larger home
// through manage.ts widenArtifactHome, the home route's own function (its
// checks under the item's lock, audit row and `moved` event; refused as the
// home route refuses, nothing posted); a home already that wide is no
// refusal. A retry of the attempt (its `clientKey` already made the message)
// or a key reused for another conversation never moves it: the poster skips
// `beforeWrite` for a key that made a message, and answers the replayed
// message (`home` null) or keyReused. The move commits before the message is
// written: a send that fails after it (a race: the conversation archived or
// converted in between) leaves it moved, as the person asked.
//
// `GET /:id/share-audience` counts the members who couldn't see it and offers
// `widenTo`: the larger homes the reader may move it to now
// (manage.ts widerHomeChoices: widenArtifactHome's checks without the lock),
// narrowest first, each only when it reaches some of them a narrower one
// offered doesn't (`server` reaches the server's full members and agents;
// `public` also guests and other servers' members). A conversation is never
// offered: no conversation is larger than another home. A larger home that
// would reach some of them (the same test) but that the reader may not move
// it to is `widenRefused` with why (#77): `forbidden` (who may move it, or a
// person's step: nothing more said), `name_taken` with the name (the
// Artifact's own, which the reader sees). The reader sees the Artifact (the
// route's visibleItemFor), so this tells them nothing new.
// Core's message limit (`POST /api/messages`'s) is on the route as well as
// the writes' (mount.ts). The body's `clientKey` (one per attempt) makes the
// message's idempotency key (core's `randomId`): a retry with the same key
// answers the one message posted (400 INVALID_REQUEST if it went elsewhere).
//
// A message the share posted (not a retry's replay) becomes the Artifact's
// original message when it has none yet (`items.origin_message_id`, set once,
// `WHERE origin_via IS NULL`; xxchan #proj-workspace:2e5a5da3): one saved
// from an attachment, or shared before, keeps its own.
//
// `POST /save-attachment` checks the flag and the body, then saves it as the
// reader (save.ts saveAttachment, the rule an agent's save shares; its header
// lists the checks): an earlier save answers that Artifact if the reader can
// see it (the viewer's answer, 200), else 409 ALREADY_SAVED; a new one is
// the viewer's answer, 201. The viewer's answer without `frame`: a ticket is
// only ever in the viewer route's own answer. The refusals: 404 ATTACHMENT_NOT_FOUND, 422
// ATTACHMENT_NOT_SAVABLE, 403 FILE_UPLOAD_QUOTA_EXCEEDED with the
// attachments' fields, 503 CONTENT_UNAVAILABLE.
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  ARTIFACT_ATTACHMENT_SAVES_MAX_IDS,
  ARTIFACT_SHARE_AUDIENCE_MAX_COUNTED,
  ARTIFACT_SHARE_NOTE_MAX_CHARS,
  asMessageId,
  type ArtifactReference,
  type ArtifactViewerData,
  type ArtifactWebAttachmentSaves,
  type ArtifactWebSaved,
  type ArtifactWebShareAudience,
  type ArtifactWebShared,
  type ArtifactWebShareInput,
  type ArtifactWebWidenRefusal,
} from "@botiverse/raft-shared";
import type { AppMessagePoster } from "../../platform/apps";
import { attachmentSources } from "../../platform/attachments";
import { conversationMembers } from "../../platform/conversations";
import { getDb } from "../../platform/db";
import { artifactAppUrl, itemsServerEnabled, json, TARGET_NOT_FOUND_ERROR, type ArtifactApiJson } from "./apiCommon";
import { widenArtifactHome, widerHomeChoices, type ArtifactManageRefusal, type ArtifactWiderHome } from "./manage";
import { ALREADY_SAVED_ERROR, ATTACHMENT_NOT_FOUND_ERROR, attachmentTooLargeError, liveItem, saveAttachment } from "./save";
import { artifactAttachmentSaves, artifactItems } from "./schema";
import { atCurrentVersions, artifactCards, cardAuthorRef } from "./webCards";
import {
  answerWeb,
  profiler,
  readerViewActor,
  refuse,
  requireWebEnabled,
  visibleItemFor,
  webBadBody,
  webFail as fail,
  webFileUploadQuotaRefusal,
  webManageRefusal,
  type ArtifactWebApiError,
  type ArtifactWebReader,
} from "./webCommon";
import { canViewArtifacts, actorsWhoCanViewArtifact } from "./visibility";

/** How many members share-audience checks (the counting budget); tests lower it. */
export const shareAudienceLimits = { maxCounted: ARTIFACT_SHARE_AUDIENCE_MAX_COUNTED };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A share's `clientKey`: 1 to 64 of letters, digits, `-` and `_` (a uuid fits). */
const CLIENT_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const codePoints = (text: string): number => [...text].length;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (why: string): never => refuse(400, { code: "INVALID_REQUEST", error: `This share request isn't one the route takes (${why}): reload the page and share again.` });

/**
 * An Artifact's address on this deployment (`appUrl`, APP_URL:
 * https://app.raft.build in production), as its cards' `url` is (webCards.ts):
 * a share's message and an unavailable reference link where the reader is.
 */
export const artifactUrl = (id: string): string => artifactAppUrl(id);

/** ArtifactWebShareInput, checked: exactly its fields. */
function parseShareInput(body: unknown): ArtifactWebShareInput {
  if (!isRecord(body)) return invalid("the body is ArtifactWebShareInput");
  const { conversationId, threadRootId, note, widenTo, clientKey, ...rest } = body;
  if (Object.keys(rest).length > 0) return invalid("unknown fields");
  if (typeof clientKey !== "string" || !CLIENT_KEY.test(clientKey)) return invalid("clientKey is 1 to 64 letters, digits, - or _");
  if (typeof conversationId !== "string" || conversationId === "") return invalid("conversationId is a conversation id");
  if (threadRootId !== null && threadRootId !== undefined && typeof threadRootId !== "string") return invalid("threadRootId is a message id or null");
  if (note !== null && note !== undefined && typeof note !== "string") return invalid("note is text or null");
  if (widenTo !== null && widenTo !== undefined && widenTo !== "server" && widenTo !== "public") return invalid("widenTo is server, public or null");
  return {
    conversationId: conversationId as ArtifactWebShareInput["conversationId"],
    threadRootId: (threadRootId ?? null) as ArtifactWebShareInput["threadRootId"],
    note: note ?? null,
    widenTo: widenTo ?? null,
    clientKey,
  };
}

/**
 * Why share-audience doesn't offer `to` (a refusal of manage.ts
 * widenRefusal): its name taken there, by name; anything else (who may move
 * it, a person's step) is `forbidden` with nothing more. A home the reader
 * can't see it in (not_visible) or no larger (not_wider) can't reach this:
 * the route saw it, and widerHomeChoices lists only larger homes.
 */
function widenRefusalOf(to: ArtifactWiderHome, refusal: ArtifactManageRefusal): ArtifactWebWidenRefusal {
  return refusal.kind === "name_taken" ? { to, reason: "name_taken", name: refusal.name } : { to, reason: "forbidden" };
}

/** The message a share posts: the note (trimmed), a blank line, the link; the link alone without a note. */
export function shareMessageContent(note: string | null, artifactId: string): string {
  const link = artifactUrl(artifactId);
  const text = note?.trim() ?? "";
  return text === "" ? link : `${text}\n\n${link}`;
}

/**
 * A share's message becomes the Artifact's original message when it has none
 * yet (saved from an attachment, or shared before, it keeps that one). Once
 * set it never changes, so it never moves, not even after that message is
 * deleted (readers then show none).
 */
async function recordShareOrigin(itemId: string, messageId: string): Promise<void> {
  await getDb().update(artifactItems).set({ originMessageId: messageId, originVia: "share" })
    .where(and(eq(artifactItems.id, itemId), isNull(artifactItems.originVia)));
}

/** `viewerOf`: the viewer's answer for an Artifact, without `frame` (webViewer.ts viewerWithoutFrame). */
export function createShareOperations(viewerOf: (reader: ArtifactWebReader, id: string) => Promise<ArtifactApiJson<ArtifactViewerData> | ArtifactWebApiError>) {
  return {
    share: (reader: ArtifactWebReader, id: string, body: unknown, messages: AppMessagePoster): Promise<ArtifactApiJson<ArtifactWebShared> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await visibleItemFor(reader, id);
      const input = parseShareInput(body);
      if (input.note !== null && codePoints(input.note.trim()) > ARTIFACT_SHARE_NOTE_MAX_CHARS) {
        return fail(400, {
          code: "FIELD_TOO_LONG",
          error: `A share's note can be at most ${ARTIFACT_SHARE_NOTE_MAX_CHARS} characters: shorten it and share again.`,
          details: { field: "note", limit: ARTIFACT_SHARE_NOTE_MAX_CHARS },
        });
      }
      const widenTo = input.widenTo;
      // With `widenTo`: once core's send checks passed, before anything is
      // posted, the home route's move (widenArtifactHome: its checks under the
      // item's lock, its audit row and event). Already that wide (moved
      // meanwhile) goes on to send. A retry of the attempt (its key already
      // made the message) or the key used elsewhere never moves it: the poster
      // skips `beforeWrite` then.
      const widening: { home: ArtifactWebShared["home"]; refused: ArtifactManageRefusal | null } = { home: null, refused: null };
      const widen = async (to: ArtifactWiderHome): Promise<boolean> => {
        const moved = await widenArtifactHome(readerViewActor(reader), item.id, to);
        if (moved.kind === "moved" || moved.kind === "not_wider") {
          // not_wider: its home is `to` or larger (never a conversation).
          widening.home = { kind: moved.kind === "moved" ? to : moved.home === "public" ? "public" : "server" };
          return true;
        }
        widening.refused = moved;
        return false;
      };
      const posted = await messages.postAsReader({
        conversationId: input.conversationId,
        threadRootId: input.threadRootId,
        content: shareMessageContent(input.note, item.id),
        // Per Artifact and attempt: a retry answers the message the first try posted.
        idempotencyKey: `share:${item.id}:${input.clientKey}`,
        ...(widenTo !== null ? { beforeWrite: () => widen(widenTo) } : {}),
      });
      if (posted.kind === "stopped") return webManageRefusal(widening.refused!);
      if (posted.kind === "keyReused") {
        return fail(400, { code: "INVALID_REQUEST", error: "This share's clientKey was already used for a share to another conversation: reload the page and share again." });
      }
      if (posted.kind === "refused") {
        return fail(404, {
          code: "TARGET_NOT_FOUND",
          error: TARGET_NOT_FOUND_ERROR,
          details: {
            conversationId: input.conversationId,
            ...(input.threadRootId !== null ? { threadRootId: input.threadRootId } : {}),
          },
        });
      }
      // A message this attempt posted (not a retry's replay) is its original message while it has none.
      if (!posted.replayed) await recordShareOrigin(item.id, posted.messageId);
      return json<ArtifactWebShared>({ messageId: asMessageId(posted.messageId), home: widening.home });
    }),

    shareAudience: (reader: ArtifactWebReader, id: string, query: { conversationId?: unknown }): Promise<ArtifactApiJson<ArtifactWebShareAudience> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await visibleItemFor(reader, id);
      const conversationId = query.conversationId;
      if (typeof conversationId !== "string" || conversationId === "") {
        return fail(400, { code: "INVALID_REQUEST", error: "Who could see it is asked about one conversation, and none was named: pick a conversation to share to." });
      }
      const members = await conversationMembers(reader, conversationId);
      if (!members) return fail(404, { code: "TARGET_NOT_FOUND", error: TARGET_NOT_FOUND_ERROR, details: { conversationId } });
      const counted = members.slice(0, shareAudienceLimits.maxCounted);
      // Whether each could see it, standing in the server they take part through
      // (a joint channel's members on every server in it see an Artifact homed
      // there; another server's, otherwise, only a public one).
      const sees = await actorsWhoCanViewArtifact(counted.map((member) => ({ type: member.type, id: member.id, serverId: member.serverId })), item);
      const cannot = counted.filter((_member, index) => !sees[index]);
      // The larger homes (the home route's own decision, widerHomeChoices),
      // narrowest first, each kept when it reaches some of them a narrower one
      // offered doesn't: offered when the reader may move it there. One the
      // reader may not is said, with why (#77), when it reaches some of them
      // no narrower home offered or said already does.
      const widenTo: Array<ArtifactWiderHome> = [];
      const widenRefused: ArtifactWebWidenRefusal[] = [];
      let unreached = cannot;
      let unexplained = cannot;
      for (const { to, refusal } of cannot.length > 0 ? await widerHomeChoices(readerViewActor(reader), item) : []) {
        const reaches = await actorsWhoCanViewArtifact(unreached.map((member) => ({ type: member.type, id: member.id, serverId: member.serverId })), { ...item, homeKind: to, homeChannelId: null });
        const reached = new Set(unreached.filter((_member, index) => reaches[index]));
        if (refusal === null && reached.size > 0) {
          widenTo.push(to);
          unreached = unreached.filter((member) => !reached.has(member));
        } else if (refusal !== null && unexplained.some((member) => reached.has(member))) {
          widenRefused.push(widenRefusalOf(to, refusal));
        }
        unexplained = unexplained.filter((member) => !reached.has(member));
      }
      return json<ArtifactWebShareAudience>({
        members: members.length,
        cannotSee: cannot.length,
        guestsCannotSee: cannot.filter((member) => member.guest).length,
        ...(members.length > counted.length ? { capped: true } : {}),
        widenTo,
        widenRefused,
      });
    }),

    saveAttachment: (reader: ArtifactWebReader, body: unknown): Promise<ArtifactApiJson<ArtifactWebSaved> | ArtifactWebApiError> => answerWeb(async () => {
      await requireWebEnabled(reader);
      if (!isRecord(body) || typeof body.attachmentId !== "string" || Object.keys(body).length !== 1) return webBadBody("{ attachmentId }");
      const attachmentId = body.attachmentId;
      const outcome = await saveAttachment(readerViewActor(reader), attachmentId);
      switch (outcome.kind) {
        case "not_found": return fail(404, { code: "ATTACHMENT_NOT_FOUND", error: ATTACHMENT_NOT_FOUND_ERROR, details: { attachmentId } });
        case "earlier": {
          // That Artifact as the reader sees it (the viewer's answer, by its checks), or 409 when they can't.
          const viewer = await viewerOf(reader, outcome.item.id);
          if (viewer.kind === "error") return fail(409, { code: "ALREADY_SAVED", error: ALREADY_SAVED_ERROR, details: { attachmentId } });
          return json<ArtifactWebSaved>({ artifact: viewer.body, created: false }, 200);
        }
        case "too_large": return fail(422, { code: "ATTACHMENT_NOT_SAVABLE", error: attachmentTooLargeError(outcome.limit), details: { attachmentId, reason: "too_large", limit: outcome.limit } });
        case "content_unavailable": return fail(503, { code: "CONTENT_UNAVAILABLE", error: outcome.error });
        case "file_upload_quota_exceeded": return webFileUploadQuotaRefusal(reader.serverId, outcome.error, "artifact_save_attachment");
        case "created": {
          const answer = await viewerOf(reader, outcome.item.id);
          if (answer.kind === "error") return answer;
          return json<ArtifactWebSaved>({ artifact: answer.body, created: true }, 201);
        }
      }
    }),

    attachmentSaves: (reader: ArtifactWebReader, query: { attachmentIds?: unknown }): Promise<ArtifactApiJson<ArtifactWebAttachmentSaves> | ArtifactWebApiError> => answerWeb(async () => {
      await requireWebEnabled(reader);
      const raw = query.attachmentIds;
      if (typeof raw !== "string" || raw === "") {
        return fail(400, { code: "INVALID_REQUEST", error: "Which attachments to look up wasn't said: ask with attachmentIds, a comma-separated list of ids, after reloading the page." });
      }
      const asked = [...new Set(raw.split(","))];
      if (asked.some((attachmentId) => attachmentId === "") || asked.length > ARTIFACT_ATTACHMENT_SAVES_MAX_IDS) {
        return fail(400, {
          code: "INVALID_REQUEST",
          error: `A lookup of saved attachments takes 1 to ${ARTIFACT_ATTACHMENT_SAVES_MAX_IDS} ids, none of them empty: ask about fewer at a time.`,
          details: { limit: ARTIFACT_ATTACHMENT_SAVES_MAX_IDS },
        });
      }
      // Saved ones first (this module's own table; as a live Artifact: one deleted
      // or revoked since is no save), then which of those the reader can see,
      // within the plan's history window (platform/attachments).
      const ids = asked.filter((attachmentId) => UUID.test(attachmentId));
      const saves = ids.length > 0
        ? await getDb().select({ attachmentId: artifactAttachmentSaves.attachmentId, item: artifactItems }).from(artifactAttachmentSaves)
          .innerJoin(artifactItems, eq(artifactItems.id, artifactAttachmentSaves.itemId))
          .where(and(inArray(artifactAttachmentSaves.attachmentId, ids), liveItem))
        : [];
      const viewer = readerViewActor(reader);
      const seen = await attachmentSources(viewer, saves.map((save) => save.attachmentId));
      const shown = saves.filter((_, index) => seen[index] !== null);
      const items = [...new Map(shown.map((save) => [save.item.id, save.item])).values()];
      // As the viewer route decides: visible, and (another server's public one) its server's flag on.
      const [canSee, enabled] = await Promise.all([canViewArtifacts(viewer, items), itemsServerEnabled(items)]);
      const visible = items.map((_, index) => canSee[index]! && enabled[index]!);
      const atCurrent = await atCurrentVersions(items.filter((_, index) => visible[index]));
      const actorOf = await profiler(atCurrent.map(cardAuthorRef));
      const cards = new Map((await artifactCards(reader, atCurrent, actorOf)).map((card) => [card.id as string, card]));
      return json<ArtifactWebAttachmentSaves>({
        saves: shown.map((save) => {
          const card = cards.get(save.item.id);
          const savedAs: ArtifactReference = card ? { status: "ok", card } : { status: "unavailable", url: artifactUrl(save.item.id) };
          return { attachmentId: save.attachmentId, savedAs };
        }),
      });
    }),
  };
}
