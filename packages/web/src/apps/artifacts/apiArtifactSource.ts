import axios from "axios";
import type { AxiosRequestConfig } from "axios";
import { artifactFileType, artifactPublicPaths, artifactWebPaths, asArtifactCommentDraftId, asFirstPartyAppId, asFirstPartyObjectId, asFirstPartyObjectKind, mentionAudiencePaths, objectWebPaths } from "@botiverse/raft-shared";
import type {
  ArtifactCommentImage,
  ArtifactId,
  ArtifactObjectRef,
  ArtifactPublicFrame,
  ArtifactPublicMeta,
  ArtifactPublicView,
  ArtifactPresence,
  ArtifactReviewRejected,
  ArtifactReviewSubmitted,
  ArtifactViewerData,
  ArtifactWebCommentCreated,
  ArtifactWebCommentsPage,
  ArtifactWebResolveInput,
  ArtifactWebThreadResolution,
  ArtifactWebDashboardAll,
  ArtifactWebDashboardAuthors,
  ArtifactWebDashboardConversations,
  ArtifactWebFileContent,
  ArtifactWebFrame,
  ArtifactWebHomeChange,
  ArtifactWebLocation,
  ArtifactWebOpen,
  ArtifactWebReviewDrafts,
  ArtifactWebReviewDraftSaved,
  ArtifactWebAttachmentSaves,
  ArtifactWebConversationArtifacts,
  ArtifactWebSaved,
  ArtifactWebShareAudience,
  ArtifactWebShared,
  ArtifactWebTitleInput,
  ArtifactWillNotify,
  MentionAudienceCandidates,
  MentionAudienceInput,
} from "@botiverse/raft-shared";

import api from "../../api/client";
import { viewerResultOf } from "./artifactApi";
import type { ArtifactApiError, ArtifactSource } from "./artifactApi";
import type { ArtifactLinkTarget } from "./artifactLinks";

/**
 * The Artifacts data source backed by Raft's web API (`/api/artifacts/*`,
 * packages/shared webArtifactsContract.ts; server: packages/server
 * src/apps/artifacts/webRoutes.ts). Each method is one route.
 *
 * - Errors come back as the contract's ArtifactApiError ({status, code,
 *   details}) so the components read them the same way from either source;
 *   anything that isn't an HTTP answer (offline, cancelled) is thrown as is.
 * - A file's text comes from the file-content route: a binary file answers
 *   `{kind: "binary"}` there, which a text view can't show (thrown as
 *   NOT_TEXT). Bytes come from the file route, typed by its Content-Type.
 * - No message refs here: the Artifact links in a message are read by core's
 *   per-message link-card hook (components/message/useMessageLinkCards.ts)
 *   through `useArtifactLinkSummaries` (artifactSource.ts), which uses core's
 *   object summaries loader as is (objects/useObjectSummaries.ts over
 *   `POST /api/objects/summaries`): no side effects (the viewer route moves
 *   the read position), and a link the reader can't open is "unavailable",
 *   saying nothing about why. That is the one path for them.
 */

const ARTIFACTS_APP = asFirstPartyAppId("artifacts");
const ARTIFACT_KIND = asFirstPartyObjectKind("artifact");

/** `artifactWebPaths` are absolute (`/api/…`); the client's base already ends in `/api`. */
function route(path: string): string {
  return path.replace(/^\/api(?=\/)/, "");
}

function apiErrorOf(error: unknown): unknown {
  if (!axios.isAxiosError(error) || !error.response) return error;
  const data = error.response.data as { code?: unknown; details?: unknown } | undefined;
  // Core's own limits (the message limit on sending) answer 429 without a code.
  const code = data && typeof data.code === "string" ? data.code : error.response.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR";
  const answer: ArtifactApiError = { status: error.response.status, code };
  if (data && typeof data.details === "object" && data.details !== null) {
    answer.details = data.details as ArtifactApiError["details"];
  }
  return answer;
}

async function call<T>(config: AxiosRequestConfig): Promise<T> {
  try {
    const { data } = await api.request<T>({ ...config, url: route(config.url ?? "") });
    return data;
  } catch (error) {
    throw apiErrorOf(error);
  }
}

const get = <T>(url: string) => call<T>({ method: "GET", url });

/** A GET of bytes, typed by the answer's Content-Type. */
async function getBlob(url: string): Promise<Blob> {
  try {
    const response = await api.get<Blob>(route(url), { responseType: "blob" });
    const type = String(response.headers["content-type"] ?? response.data.type ?? "");
    return response.data.type === type ? response.data : new Blob([response.data], { type });
  } catch (error) {
    // With responseType "blob" the error body is a Blob too: read it as JSON first.
    if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
      try {
        error.response.data = JSON.parse(await error.response.data.text());
      } catch {
        // not JSON: the status alone
      }
    }
    throw apiErrorOf(error);
  }
}
const send = <T>(method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, data?: unknown) => call<T>({ method, url, data });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isActor = (value: unknown): boolean => isRecord(value) && (value.type === "user" || value.type === "agent") && typeof value.id === "string";

/**
 * Whether a 422's `details` are what ArtifactReviewRejected gives its code (the contract's
 * per-code shapes), so the UI can switch on the code and read them typed.
 */
function rejectionDetailsOk(code: ArtifactReviewRejected["code"], details: unknown): boolean {
  switch (code) {
    case "INVALID_REQUEST":
      return details === undefined;
    case "INVALID_PATH":
      return isRecord(details) && typeof details.path === "string";
    case "FIELD_TOO_LONG":
      return isRecord(details) && (details.field === "body" || details.field === "anchor") && typeof details.limit === "number";
    case "VERSION_NOT_FOUND":
      return details === undefined || (isRecord(details) && typeof details.version === "number" && typeof details.currentVersion === "number");
    case "FILE_NOT_FOUND":
      return isRecord(details) && typeof details.path === "string" && typeof details.version === "number";
    case "TOO_MANY_MENTIONS":
      return isRecord(details) && typeof details.limit === "number";
    case "MENTION_NOT_VISIBLE":
      return isRecord(details) && Array.isArray(details.actors) && details.actors.every(isActor);
    case "COMMENT_NOT_FOUND":
      return details === undefined;
  }
}

/** Every code ArtifactReviewRejected can carry (never FORBIDDEN; COMMENT_NOT_FOUND: a reply draft's comment deleted). */
const REVIEW_REJECT_CODES: Readonly<Record<ArtifactReviewRejected["code"], true>> = {
  INVALID_REQUEST: true,
  INVALID_PATH: true,
  FIELD_TOO_LONG: true,
  VERSION_NOT_FOUND: true,
  FILE_NOT_FOUND: true,
  TOO_MANY_MENTIONS: true,
  MENTION_NOT_VISIBLE: true,
  COMMENT_NOT_FOUND: true,
};

/**
 * A submit's 422 body as the contract's ArtifactReviewRejected, or null when it isn't one (then
 * it is thrown as any other error): `draftId` a string or null (the summary), one of its codes,
 * and that code's `details`.
 */
function rejectedOf(error: unknown): ArtifactReviewRejected | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 422) return null;
  const data: unknown = error.response.data;
  if (!isRecord(data) || data.status !== "rejected") return null;
  const { draftId, code, error: label, details } = data;
  if (!(draftId === null || typeof draftId === "string") || typeof code !== "string" || !Object.hasOwn(REVIEW_REJECT_CODES, code)) return null;
  const known = code as ArtifactReviewRejected["code"];
  if (!rejectionDetailsOk(known, details)) return null;
  // Proved above: the code is one of the union's and `details` has its shape.
  return {
    status: "rejected",
    draftId: draftId === null ? null : asArtifactCommentDraftId(draftId),
    code: known,
    error: typeof label === "string" ? label : "",
    ...(details === undefined ? {} : { details }),
  } as ArtifactReviewRejected;
}

/** How a link in a message is asked for: `version` only for a pinned (`/v/<n>`) link. */
export function artifactObjectRefOf(target: ArtifactLinkTarget): ArtifactObjectRef {
  return target.version === null ? { id: target.id } : { id: target.id, version: target.version };
}

/**
 * The public routes and `open` read no server: none is sent (`false`, api/client.ts),
 * whichever is current. A signed-in reader's current server may be one whose
 * Artifacts are off; it has nothing to do with whether a public Artifact opens.
 */
const NO_SERVER = { "X-Server-Id": false } as const;

export const apiArtifactSource: ArtifactSource = {
  kind: "api",
  viewer(target) {
    return viewerResultOf(() => get<ArtifactViewerData>(artifactWebPaths.viewer(target.id, target.version ?? undefined)));
  },
  async versionSummary({ id, version }) {
    const data = await get<ArtifactViewerData>(artifactWebPaths.details(id, version));
    return data.versions.find((summary) => summary.number === version) ?? null;
  },
  async readText(file) {
    const content = await get<ArtifactWebFileContent>(artifactWebPaths.fileContent(file.id, file.path, file.version));
    if (content.kind !== "text") throw { status: 415, code: "NOT_TEXT" } satisfies ArtifactApiError;
    return content.content;
  },
  readBytes(file) {
    return getBlob(artifactWebPaths.file(file.id, file.path, file.version));
  },
  readZip(target) {
    return getBlob(artifactWebPaths.downloadZip(target.id, target.version));
  },
  frame(id, input) {
    return send<ArtifactWebFrame>("POST", artifactWebPaths.frame(id), input);
  },
  setFollowing(id, following) {
    return send<{ following: boolean }>(following ? "PUT" : "DELETE", artifactWebPaths.subscription(id));
  },
  changeHome(id, input) {
    return send<ArtifactViewerData>("POST", artifactWebPaths.home(id), input);
  },
  homeChange(id, to) {
    return get<ArtifactWebHomeChange>(artifactWebPaths.homeChange(id, to));
  },
  unpublish(id) {
    return unpublishArtifact(id);
  },
  setTitle(id, title) {
    return send<ArtifactViewerData>("PATCH", artifactWebPaths.title(id), { title } satisfies ArtifactWebTitleInput);
  },
  async deleteArtifact(id) {
    await send<void>("DELETE", artifactWebPaths.artifact(id));
  },
  getComments(id, options) {
    return get<ArtifactWebCommentsPage>(artifactWebPaths.comments(id, options));
  },
  postComment(id, input) {
    return send<ArtifactWebCommentCreated>("POST", artifactWebPaths.comments(id), input);
  },
  editComment(id, commentId, body) {
    return send<ArtifactWebCommentCreated>("PATCH", artifactWebPaths.comment(id, commentId), { body });
  },
  async deleteComment(id, commentId) {
    await send<void>("DELETE", artifactWebPaths.comment(id, commentId));
  },
  resolveComment(id, commentId) {
    return send<ArtifactWebThreadResolution>("POST", artifactWebPaths.commentResolve(id, commentId), {} satisfies ArtifactWebResolveInput);
  },
  reopenComment(id, commentId) {
    return send<ArtifactWebThreadResolution>("POST", artifactWebPaths.commentReopen(id, commentId));
  },
  uploadCommentImage(id, image, options = {}) {
    const { onProgress, signal } = options;
    return call<ArtifactCommentImage>({
      method: "POST",
      signal,
      url: artifactWebPaths.commentImages(id),
      data: image,
      // The raw bytes, typed as the file is: the Server decides by the bytes, never this.
      headers: { "Content-Type": image.type || "application/octet-stream" },
      onUploadProgress: onProgress ? (event) => onProgress(event.total ? Math.min(100, Math.round((event.loaded / event.total) * 100)) : 0) : undefined,
    });
  },
  readCommentImage(id, fileId) {
    // Core's object file route, on Raft's API origin with the session and X-Server-Id: never a bare <img src>.
    return getBlob(objectWebPaths.file("artifact", id, fileId));
  },
  reviewDrafts(id) {
    return get<ArtifactWebReviewDrafts>(artifactWebPaths.reviewDrafts(id));
  },
  createReviewDraft(id, input) {
    return send<ArtifactWebReviewDraftSaved>("POST", artifactWebPaths.reviewDrafts(id), input);
  },
  editReviewDraft(id, draftId, body) {
    return send<ArtifactWebReviewDraftSaved>("PATCH", artifactWebPaths.reviewDraft(id, draftId), { body });
  },
  async deleteReviewDraft(id, draftId) {
    await send<void>("DELETE", artifactWebPaths.reviewDraft(id, draftId));
  },
  async discardReviewDrafts(id) {
    await send<void>("DELETE", artifactWebPaths.reviewDrafts(id));
  },
  async submitReview(id, input) {
    try {
      const { data } = await api.request<ArtifactReviewSubmitted>({ method: "POST", url: route(artifactWebPaths.reviewSubmit(id)), data: input });
      return data;
    } catch (error) {
      // 422 is an answer, not a failure: the review refused, nothing posted.
      const rejected = rejectedOf(error);
      if (rejected) return rejected;
      throw apiErrorOf(error);
    }
  },
  mentionCandidates(id, q) {
    // Core's audience route; an Artifact is an object of the artifacts app.
    const input: MentionAudienceInput = { audience: { kind: "object", app: ARTIFACTS_APP, objectKind: ARTIFACT_KIND, objectId: asFirstPartyObjectId(id) }, q };
    return send<MentionAudienceCandidates>("POST", mentionAudiencePaths.audience(), input);
  },
  willNotify(id, options) {
    return get<ArtifactWillNotify>(artifactWebPaths.willNotify(id, options));
  },
  presence(id) {
    return get<ArtifactPresence>(artifactWebPaths.presence(id));
  },
  saveAttachment(input) {
    return send<ArtifactWebSaved>("POST", artifactWebPaths.saveAttachment(), input);
  },
  attachmentSaves(attachmentIds) {
    return get<ArtifactWebAttachmentSaves>(artifactWebPaths.attachmentSaves(attachmentIds));
  },
  shareAudience(id, options) {
    return get<ArtifactWebShareAudience>(artifactWebPaths.shareAudience(id, options));
  },
  share(id, input) {
    return send<ArtifactWebShared>("POST", artifactWebPaths.share(id), input);
  },
  dashboardAll(options) {
    return get<ArtifactWebDashboardAll>(artifactWebPaths.dashboardAll(options));
  },
  dashboardAuthors(options) {
    return get<ArtifactWebDashboardAuthors>(artifactWebPaths.dashboardAuthors(options));
  },
  dashboardConversations(options) {
    return get<ArtifactWebDashboardConversations>(artifactWebPaths.dashboardConversations(options));
  },
  conversationArtifacts(conversationId, options) {
    return get<ArtifactWebConversationArtifacts>(artifactWebPaths.conversationArtifacts(conversationId, options));
  },
  open(target) {
    // Its canonical link names no server: none is sent, whichever is current (the server answers where it opens).
    return call<ArtifactWebOpen>({ method: "GET", url: artifactWebPaths.open(target.id, target.version === null ? {} : { version: target.version }), headers: NO_SERVER });
  },
  locate(id, askFrom) {
    // Asked from a server the reader names (not necessarily the current one): the canonical link has none.
    return call<ArtifactWebLocation>({ method: "GET", url: artifactWebPaths.locate(id), headers: { "X-Server-Id": askFrom.id } });
  },
};

/**
 * Unpublish (public Artifacts v1): a public Artifact back to its whole
 * server → the new viewer data. FORBIDDEN, NOT_PUBLIC, NAME_TAKEN, NOT_VISIBLE.
 */
export function unpublishArtifact(id: ArtifactId): Promise<ArtifactViewerData> {
  return send<ArtifactViewerData>("POST", artifactWebPaths.unpublish(id));
}

/**
 * The signed-out public view (public Artifacts v1): what the page shows, or
 * the one 404 for every failure. Asked by a visitor, or by someone signed in
 * whose `open` answered 401 (ArtifactPermalink); the routes read
 * no Authorization or cookie, and set none.
 */
export function publicArtifactView(id: ArtifactId): Promise<ArtifactPublicView> {
  return call<ArtifactPublicView>({ method: "GET", url: artifactPublicPaths.view(id), headers: NO_SERVER });
}

/**
 * Where the public page loads the current version on the content origin: a
 * one-time ticket, asked on every mount (no body: the route reads none).
 * NOT_VISIBLE, NOT_FRAMED, CONTENT_UNAVAILABLE, RATE_LIMITED.
 */
export function publicArtifactFrame(id: ArtifactId): Promise<ArtifactPublicFrame> {
  return call<ArtifactPublicFrame>({ method: "POST", url: artifactPublicPaths.frame(id), headers: NO_SERVER });
}

/**
 * The current version's entry file and its files' sizes: what the public page needs to draw a
 * kind Raft draws itself (the view names the kind, not the file). NOT_VISIBLE, RATE_LIMITED.
 */
export function publicArtifactMeta(id: ArtifactId): Promise<ArtifactPublicMeta> {
  return call<ArtifactPublicMeta>({ method: "GET", url: artifactPublicPaths.meta(id), headers: NO_SERVER });
}

/**
 * How a signed-out visitor reads a file of a public Artifact's current version, for what Raft
 * draws itself: the public file route, as is. Its text as it is (never parsed: `responseType`
 * text); its bytes typed by the path, as that route says `application/octet-stream` for all that
 * isn't text and the reader takes only the image types it knows (useArtifactImageSrc).
 */
export const publicArtifactFileReader = {
  readText(file: { id: ArtifactId; path: string }): Promise<string> {
    return call<string>({ method: "GET", url: artifactPublicPaths.file(file.id, file.path), headers: NO_SERVER, responseType: "text" });
  },
  async readBytes(file: { id: ArtifactId; path: string }): Promise<Blob> {
    const bytes = await call<Blob>({ method: "GET", url: artifactPublicPaths.file(file.id, file.path), headers: NO_SERVER, responseType: "blob" });
    return new Blob([bytes], { type: artifactFileType(file.path).contentType });
  },
};
