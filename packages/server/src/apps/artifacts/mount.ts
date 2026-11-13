// Where the module's operations meet core's routes: the mount functions its
// registration (register.ts) hands core (platform/apps FirstPartyApp.routes).
// Core runs them with its transport: contract checks, auth, the answers
// written (`private, no-store`), the per-user limits, and what it still
// injects (the notice outbox).
//
// - Agent API, `/internal/agent-api/artifacts/*` (contract: packages/shared
//   agentApiArtifactsContract.ts): the operations of routes.ts, publish.ts,
//   comments.ts, reviews.ts, manage.ts, import.ts, save.ts and checkRead.ts. A publish's JSON body (files inline, up to
//   AGENT_API_ARTIFACT_PUBLISH_MAX_BODY_BYTES as base64, far over the global
//   100 KB) is parsed by a route-scoped parser after agent auth and the flag
//   check: a server with the flag off answers 403 ARTIFACTS_NOT_ENABLED
//   without reading the body. Over it: 413 REQUEST_TOO_LARGE. Core limits
//   every write here, not this mount: its agent write budgets, per agent and
//   per server across replicas (services/agentApiWriteLimits.ts; a push's
//   file uploads `artifactUploads` 600 / 1200 a minute, every other write
//   `artifactWrites` 60 / 600, a review one per comment; 429 RATE_LIMITED). While Artifacts is dogfooding, a `raft` CLI older than
//   ARTIFACTS_MIN_CLI_VERSION is refused on every one of these routes, 426
//   CLIENT_UPGRADE_REQUIRED, ahead of the limit, the flag and the body
//   (cliFloor.ts, core's client gate).
// - Web API, `/api/artifacts/*` (contract: webArtifactsContract.ts), behind
//   the person's auth and server scoping: the operations of webRoutes.ts;
//   the standalone page's `GET /:id/open` (webOpen.ts) is core's account
//   route instead, behind the person's auth with no server scoping. The
//   frame route, the viewer and open, which each sign a ticket, are limited
//   per user together (`frame`); the writes (comments, edits,
//   deletes, following, moving an Artifact to a larger home or a public one
//   back to the server, deleting it,
//   importing, saving an attachment, sending to a conversation) by `write`,
//   sending also by core's message limit;
//   comment image uploads by `commentImages`, both counted across replicas;
//   `@` candidates by
//   `mentionCandidates`; the dashboard (S7, reads only; its All tab, its authors and its conversations too) and a conversation's
//   Artifacts (its Files panel, reads only) by `dashboard`; S5's
//   reads by `attachmentSaves` and `shareAudience`; a version's files in one
//   zip (`download.zip`, a read) by `downloadZip`; where a canonical link
//   opens (`locate`, which of the reader's servers) by `locate`. Message links' cards are
//   core's object summaries (`POST /api/objects/summaries`), not a route here.
// - Signed-out web API, `/api/public/artifacts/*` (contract: packages/shared
//   publicArtifactsContract.ts), with no auth: the operations of
//   publicRoutes.ts, each limited per client address (`view`, `frame`,
//   `markdown`, `meta`, `file`, `downloadZip`).
// - Content Worker, `/internal/artifacts-content/*` (S2,
//   docs/development/workspace-artifacts-content-origin.md): authorize,
//   manifest and embeds (contentRoutes.ts) behind the Worker's token and rate limit.
// - Check Worker, `/internal/artifacts-check/*` (task #130,
//   docs/development/workspace-artifacts.md "The check Worker's API"): a
//   publish check's lease and result (checkRoutes.ts) behind its own token
//   and rate limit.
import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { AGENT_API_ARTIFACT_PUBLISH_MAX_BODY_BYTES } from "@botiverse/raft-shared";
import type { AgentApiMount, InternalMount, PublicWebApiMount, WebApiMount } from "../../platform/apps";
import { refuse } from "../../platform/refusals";
import { ARTIFACTS_NOT_ENABLED, artifactIdParam, byteSize, fail } from "./apiCommon";
import { artifactsCliFloor } from "./cliFloor";
import { INTERNAL_ROUTE_NOT_FOUND, mountArtifactCheck, WORKER_UNAUTHORIZED, workerRateLimited } from "./checkRoutes";
import { contentCallerTokens, createArtifactContentApi, matchContentCaller } from "./contentRoutes";
import { checkContentWorkerConfig } from "./contentWorker";
import { createArtifactPublicApi } from "./publicRoutes";
import { createArtifactAgentApi } from "./routes";
import { webNotVisible } from "./webCommon";
import { createArtifactWebApi } from "./webRoutes";

/**
 * The web and signed-out routes' `:id`: `pt_<uuid>` or the short id every
 * link carries (artifactIdParam), both as `pt_<uuid>`. The agent API's
 * `:artifact` is read the same way by resolveVisibleItem.
 */
const id = (call: { params: Record<string, string> }): string => artifactIdParam(call.params.id!);

export function mountArtifactAgentApi(mount: AgentApiMount): void {
  const api = createArtifactAgentApi();
  mount.clientGate((client) => artifactsCliFloor(client));
  mount.largeBody("artifactPublish", AGENT_API_ARTIFACT_PUBLISH_MAX_BODY_BYTES, {
    notEnabled: ARTIFACTS_NOT_ENABLED,
    onBodyError: (problem) => (problem === "too_large"
      ? fail(413, {
        code: "REQUEST_TOO_LARGE",
        error: `This push is over the request limit of ${byteSize(AGENT_API_ARTIFACT_PUBLISH_MAX_BODY_BYTES)}: send fewer or smaller files per push, since files not listed carry over and the rest can follow in the next one.`,
        details: { limit: AGENT_API_ARTIFACT_PUBLISH_MAX_BODY_BYTES },
      })
      : null),
  });
  const read = "Failed to read artifact";
  mount.json("artifactList", read, (call) => api.list(call.agent, call.query));
  mount.json("artifactRead", read, (call) => api.read(call.agent, call.params, call.query));
  mount.json("artifactFileContent", read, (call) => api.fileContent(call.agent, call.params, call.query));
  mount.json("artifactComments", read, (call) => api.comments(call.agent, call.params, call.query));
  // A version's publish check and its screenshots (checkRead.ts, task #130).
  mount.json("artifactCheck", read, (call) => api.check(call.agent, call.params, call.query));
  mount.bytes("artifactCheckShot", "Failed to serve check screenshot", (call) => api.checkShot(call.agent, call.params, call.query));
  mount.json("artifactPublish", "Failed to push artifact", (call) => api.publish(call.agent, call.body, call.noticeOutbox));
  mount.json("artifactImport", "Failed to import artifact", (call) => api.importArtifact(call.agent, call.body));
  mount.json("artifactComment", "Failed to comment on artifact", (call) => api.comment(call.agent, call.params, call.body, call.noticeOutbox));
  // S8: a review, several comments at once (reviews.ts; the web's review/submit goes through the same submitReview).
  mount.json("artifactReview", "Failed to submit review", (call) => api.review(call.agent, call.params, call.body, call.noticeOutbox));
  // #249: a thread's resolve (an optional note, a reply) and reopen (resolutions.ts).
  mount.json("artifactCommentResolve", "Failed to resolve comment thread", (call) => api.resolve(call.agent, call.params, call.body, call.noticeOutbox));
  mount.json("artifactCommentReopen", "Failed to reopen comment thread", (call) => api.reopen(call.agent, call.params, call.noticeOutbox));
  mount.json("artifactSubscribe", "Failed to follow artifact", (call) => api.subscribe(call.agent, call.params));
  mount.json("artifactUnsubscribe", "Failed to unfollow artifact", (call) => api.unsubscribe(call.agent, call.params));
  mount.json("artifactMove", "Failed to move artifact", (call) => api.move(call.agent, call.params, call.body));
  mount.json("artifactDelete", "Failed to delete artifact", (call) => api.delete(call.agent, call.params));
  mount.json("artifactSaveAttachment", "Failed to save attachment as artifact", (call) => api.saveAttachment(call.agent, call.body));
  mount.upload("artifactUpload", "Failed to upload artifact bytes", (call, input) => api.upload(call.agent, call.params, input));
  // An image for a comment (commentImages.ts): a core object file of the Artifact, on core's object files budget.
  mount.objectFileUpload("artifactCommentImageUpload", "Failed to upload comment image", (call, input) => api.uploadCommentImage(call.agent, call.params, input));
  mount.bytes("artifactCommentImage", "Failed to serve comment image", (call) => api.commentImage(call.agent, call.params));
  mount.bytes("artifactFile", "Failed to serve artifact file", (call) => api.file(call.agent, call.params, call.query));
}

export function mountArtifactWebApi(mount: WebApiMount): void {
  // Read the content frame configuration at startup, so a bad one (partial,
  // a short token, or the token Raft also accepts from the Worker)
  // is logged before the first frame is asked for. A content domain that
  // overlaps one of Raft's app hosts throws here: the server doesn't start.
  checkContentWorkerConfig();
  const api = createArtifactWebApi();
  // Each frame is a new one-time ticket (signed here), the frame route's, the viewer's and open's alike: 120 a
  // minute for them together, far above a reader opening Artifacts. Per replica: it guards the signing (a read,
  // writing nothing), each replica bounds its own, and a Redis round trip on every open would buy nothing.
  const frame = mount.rateLimit("frame", { perMinute: 120, message: "Too many artifact pages opened in a minute: wait a minute, then open it again." });
  // The writes and comment images count across replicas (Redis), so a person's budget is one budget however
  // their requests are spread. Sized from the fleet's 1-minute peaks over 7 days (2026-11-01..08, all replicas,
  // no 429s), at least twice the busiest: writes 10 a person (import bursts), comment images 0.
  // Comments, edits, deletes, threads' resolves and reopens, following, moves, renames, Artifact deletes, imports, saves and shares: 60 a minute,
  // far above a person writing comments.
  const write = mount.rateLimit("write", { perMinute: 60, message: "Too many artifact changes in a minute: wait a minute, then try the same change again.", acrossReplicas: true });
  // A comment's images (at most four a comment), each decoded and encoded again: 30 a minute.
  const commentImages = mount.rateLimit("commentImages", { perMinute: 30, message: "Too many comment images uploaded in a minute: wait a minute, then add the image again.", acrossReplicas: true });
  // `@` candidates are asked as a name is typed.
  const mentionCandidates = mount.rateLimit("mentionCandidates", { perMinute: 300, message: "Too many mention lookups in a minute: wait a moment, then type the name again." });
  // The dashboard (S7: each section a query over the server's visible Artifacts), far above a person opening the page;
  // a conversation's Artifacts (its Files panel) share it.
  const dashboard = mount.rateLimit("dashboard", { perMinute: 120, message: "Too many artifact lists loaded in a minute: wait a minute, then reload." });
  // S5 reads: asked for the attachments on screen, and per row while the share dialog is open.
  const attachmentSaves = mount.rateLimit("attachmentSaves", { perMinute: 300, message: "Too many saved-attachment lookups in a minute: wait a minute, then reload." });
  const shareAudience = mount.rateLimit("shareAudience", { perMinute: 300, message: "Too many share audience lookups in a minute: wait a minute, then open the share dialog again." });
  // The narrowing preview: as share-audience, a count over a roster.
  const homeChange = mount.rateLimit("homeChange", { perMinute: 300, message: "Too many home change previews in a minute: wait a minute, then try the change again." });
  // Where a canonical link opens: asked once per link opened, and each asks about every server the reader is in.
  const locate = mount.rateLimit("locate", { perMinute: 120, message: "Too many artifact links opened in a minute: wait a minute, then open the link again." });
  // A whole version in one zip (a read: up to 100 MiB of storage reads per request, so far fewer than files): 20 a
  // minute, far above a person downloading; a few at once per process besides (zipSlots.ts `web`, 429 BUSY).
  const downloadZip = mount.rateLimit("downloadZip", { perMinute: 20, message: "Too many artifact downloads in a minute: wait a minute, then download it again." });

  // S5, saving an attachment and what attachments were saved as. Before `/:id`, which would take them as ids.
  mount.route("post", "/save-attachment", "saveAttachment", (call) => api.saveAttachment(call.reader, call.body), { rateLimit: write });
  mount.route("get", "/attachment-saves", "attachmentSaves", (call) => api.attachmentSaves(call.reader, call.query), { rateLimit: attachmentSaves });

  // The Artifacts home page (S7); reads only. Before `/:id`, which would take "dashboard" as an id.
  mount.route("get", "/dashboard", "dashboard", (call) => api.dashboard(call.reader, call.query), { rateLimit: dashboard });
  // Its All tab (every Artifact the reader can see). Before `/dashboard/:section`, which would take "all" as a section.
  mount.route("get", "/dashboard/all", "dashboardAll", (call) => api.dashboardAll(call.reader, call.query), { rateLimit: dashboard });
  // The author filter's candidates, on the dashboard's budget. Before `/dashboard/:section` too.
  mount.route("get", "/dashboard/authors", "dashboardAuthors", (call) => api.dashboardAuthors(call.reader, call.query), { rateLimit: dashboard });
  // The conversation filter's candidates, likewise.
  mount.route("get", "/dashboard/conversations", "dashboardConversations", (call) => api.dashboardConversations(call.reader, call.query), { rateLimit: dashboard });
  mount.route("get", "/dashboard/:section", "dashboardSection", (call) => api.dashboardSection(call.reader, call.params.section!, call.query), { rateLimit: dashboard });
  // A conversation's Artifacts (its Files panel); reads only. Before `/:id/…`, which would take "conversations" as an id.
  mount.route("get", "/conversations/:channelId", "conversationArtifacts", (call) => api.conversationArtifacts(call.reader, call.params.channelId!, call.query), { rateLimit: dashboard });

  // Its answer carries a framed version's ticket (`frame`): in the frame route's budget.
  mount.route("get", "/:id", "viewer", (call) => api.viewer(call.reader, id(call), call.query), { rateLimit: frame });
  // The same answer without `frame` and without moving the read position (the App's own bar): no ticket, so not in that budget.
  mount.route("get", "/:id/details", "details", (call) => api.details(call.reader, id(call), call.query));
  mount.route("get", "/:id/locate", "locate", (call) => api.locate(call.reader, id(call)), { rateLimit: locate });
  // The standalone page's one call (webOpen.ts): no server scoping (core's account route), and its answer signs a
  // ticket as the viewer's does: in the frame route's budget. A segment that doesn't decode names no Artifact.
  mount.accountRoute("/:id/open", "open", (call) => api.open(call.reader, id(call), call.query), { rateLimit: frame, undecodable: webNotVisible });
  mount.route("get", "/:id/files/:path", "file", (call) => api.file(call.reader, id(call), call.params.path!, call.query));
  mount.route("get", "/:id/files/:path/content", "fileContent", (call) => api.fileContent(call.reader, id(call), call.params.path!, call.query));
  // Every file of the shown version in one zip (versionZip.ts): a read like a file's, outside the write budget, in its own.
  mount.route("get", "/:id/download.zip", "downloadZip", (call) => api.downloadZip(call.reader, id(call), call.query), { rateLimit: downloadZip });
  mount.route("get", "/:id/comments", "comments", (call) => api.comments(call.reader, id(call), call.query));
  mount.route("post", "/:id/comments", "postComment", (call) => api.postComment(call.reader, id(call), call.body, call.noticeOutbox), { rateLimit: write });
  // An image for a comment or review draft not posted yet (commentImages.ts); read back through core's object file route.
  mount.upload("/:id/comment-images", "uploadCommentImage", (call, input) => api.uploadCommentImage(call.reader, id(call), input), { rateLimit: commentImages });
  mount.route("patch", "/:id/comments/:commentId", "editComment", (call) => api.editComment(call.reader, id(call), call.params.commentId!, call.body, call.noticeOutbox), { rateLimit: write });
  // A thread's resolve and reopen (#249): writes, by its root comment.
  mount.route("post", "/:id/comments/:commentId/resolve", "resolveComment", (call) => api.resolveComment(call.reader, id(call), call.params.commentId!, call.body, call.noticeOutbox), { rateLimit: write });
  mount.route("post", "/:id/comments/:commentId/reopen", "reopenComment", (call) => api.reopenComment(call.reader, id(call), call.params.commentId!, call.noticeOutbox), { rateLimit: write });
  mount.route("delete", "/:id/comments/:commentId", "deleteComment", (call) => api.deleteComment(call.reader, id(call), call.params.commentId!), { rateLimit: write });
  // Batch comments (S8): the reader's own review drafts, and submitting them as one review.
  mount.route("get", "/:id/review/drafts", "reviewDrafts", (call) => api.reviewDrafts(call.reader, id(call)));
  mount.route("post", "/:id/review/drafts", "createReviewDraft", (call) => api.createReviewDraft(call.reader, id(call), call.body), { rateLimit: write });
  mount.route("delete", "/:id/review/drafts", "discardReviewDrafts", (call) => api.discardReviewDrafts(call.reader, id(call)), { rateLimit: write });
  mount.route("patch", "/:id/review/drafts/:draftId", "editReviewDraft", (call) => api.editReviewDraft(call.reader, id(call), call.params.draftId!, call.body), { rateLimit: write });
  mount.route("delete", "/:id/review/drafts/:draftId", "deleteReviewDraft", (call) => api.deleteReviewDraft(call.reader, id(call), call.params.draftId!), { rateLimit: write });
  mount.route("post", "/:id/review/submit", "submitReview", (call) => api.submitReview(call.reader, id(call), call.body, call.noticeOutbox), { rateLimit: write });
  mount.route("get", "/:id/will-notify", "willNotify", (call) => api.willNotify(call.reader, id(call), call.query));
  mount.route("get", "/:id/mention-candidates", "mentionCandidates", (call) => api.mentionCandidates(call.reader, id(call), call.query), { rateLimit: mentionCandidates });
  mount.route("get", "/:id/presence", "presence", (call) => api.presence(call.reader, id(call)));
  mount.route("put", "/:id/subscription", "follow", (call) => api.follow(call.reader, id(call)), { rateLimit: write });
  mount.route("delete", "/:id/subscription", "unfollow", (call) => api.unfollow(call.reader, id(call)), { rateLimit: write });
  // Moving to a larger home and deleting share the writes' budget.
  mount.route("post", "/:id/home", "changeHome", (call) => api.home(call.reader, id(call), call.body), { rateLimit: write });
  mount.route("get", "/:id/home-change", "homeChangePreview", (call) => api.homeChange(call.reader, id(call), call.query), { rateLimit: homeChange });
  mount.route("post", "/:id/unpublish", "unpublish", (call) => api.unpublish(call.reader, id(call)), { rateLimit: write });
  // A new title (rename.ts): a write, telling the Artifact's following agents.
  mount.route("patch", "/:id/title", "rename", (call) => api.rename(call.reader, id(call), call.body, call.noticeOutbox), { rateLimit: write });
  mount.route("delete", "/:id", "deleteArtifact", (call) => api.deleteArtifact(call.reader, id(call)), { rateLimit: write });
  // Moderation (takedown.ts): the server's owners and admins; in the writes' budget.
  mount.route("post", "/:id/takedown", "takedown", (call) => api.takedown(call.reader, id(call), call.body), { rateLimit: write });
  mount.route("post", "/:id/restore", "restore", (call) => api.restore(call.reader, id(call), call.body), { rateLimit: write });
  // Importing one Artifact of the standalone app: a write, in the writes' budget.
  mount.route("post", "/import", "import", (call) => api.webImport(call.reader, call.body), { rateLimit: write });
  // S5: who in a conversation couldn't see it, and sending it there (a message as the reader).
  mount.route("get", "/:id/share-audience", "shareAudience", (call) => api.shareAudience(call.reader, id(call), call.query), { rateLimit: shareAudience });
  // A message, so also core's message limit (Tenny): sharing can't send past what the composer may.
  mount.route("post", "/:id/share", "share", (call) => api.share(call.reader, id(call), call.body, call.messages), { rateLimit: write, messageLimit: true });
  // The answer carries a one-time ticket: never stored by any cache, never logged.
  mount.route("post", "/:id/frame", "frame", (call) => api.frame(call.reader, id(call), call.body), { rateLimit: frame });

  // A segment that isn't valid percent-encoding: the flag and visibility
  // still come first (403, one 404); then, under /files/, a malformed path,
  // anywhere else a malformed request. A conversation id that doesn't
  // decode names no conversation: the flag, then its one 404.
  mount.undecodable((call, path) => {
    const conversation = /^\/conversations\/([^/]*)\/?$/.exec(path);
    if (conversation) return api.undecodableConversation(call.reader, conversation[1]!);
    const [, rawId = "", rawPath] = /^\/([^/]*)(?:\/files\/([^/]+))?/.exec(path) ?? [];
    let decoded = rawId;
    try {
      decoded = decodeURIComponent(rawId);
    } catch {
      // An id that doesn't decode names no Artifact: the one 404.
    }
    return api.undecodable(call.reader, artifactIdParam(decoded), rawPath ?? null);
  });
}

export function mountArtifactPublicWebApi(mount: PublicWebApiMount): void {
  const api = createArtifactPublicApi();
  // Per client address: a visitor opens a page once, reloads now and then.
  const view = mount.rateLimit("view", { perMinute: 60, message: "Too many artifact pages opened from this address in a minute: wait a minute, then reload." });
  // Each signs a new one-time ticket.
  const frame = mount.rateLimit("frame", { perMinute: 30, message: "Too many artifact pages opened from this address in a minute: wait a minute, then reload." });
  // For AI tools (the page's head links it): as a visitor's view.
  const markdown = mount.rateLimit("markdown", { perMinute: 60, message: "Too many artifact reads from this address in a minute: wait a minute, then read it again." });
  // For link previews: the web's edge asks, from few addresses, on every page view (never cached: `private, no-store`).
  const meta = mount.rateLimit("meta", { perMinute: 300, message: "Too many artifact previews from this address in a minute: wait a minute, then try again." });
  // Files (index.md lists them), as an agent fetching an Artifact's files does.
  const file = mount.rateLimit("file", { perMinute: 120, message: "Too many artifact files fetched from this address in a minute: wait a minute, then fetch the file again." });
  const downloadZip = mount.rateLimit("downloadZip", { perMinute: 10, message: "Too many artifact downloads from this address in a minute: wait a minute, then download it again." });
  mount.route("get", "/:id", "view", (call) => api.view(id(call)), { rateLimit: view });
  // Markdown, never HTML; `private, no-store` like every answer here (the web's edge asks it beside meta on every page view).
  mount.route("get", "/:id/index.md", "markdown", (call) => api.markdown(id(call)), { rateLimit: markdown });
  mount.route("get", "/:id/meta", "meta", (call) => api.meta(id(call)), { rateLimit: meta });
  // One file of the current version to download (index.md lists them): an attachment, never rendered here.
  mount.route("get", "/:id/files/*path", "file", (call) => api.file(id(call), call.params.path!), { rateLimit: file });
  // Every file in one zip: a whole version's bytes per request, so fewer than files.
  mount.route("get", "/:id/download.zip", "downloadZip", (call) => api.downloadZip(id(call)), { rateLimit: downloadZip });
  // The answer carries a one-time ticket: never stored by any cache, never logged.
  mount.route("post", "/:id/frame", "frame", (call) => api.frame(id(call)), { rateLimit: frame });
  // A file at its path without `files/`: what an AI tool guesses with only index.md's text, whose
  // links its summary dropped (xxchan, #proj-workspace:ea136a38). Last, so every route above wins.
  mount.route("get", "/:id/*path", "fileByPath", (call) => api.file(id(call), call.params.path!), { rateLimit: file });
  // A segment that isn't valid percent-encoding names no Artifact: the one 404.
  mount.undecodable(() => webNotVisible());
}

/** Per caller and minute: the Worker by its token; anyone else (refused) by address. */
const WORKER_REQUESTS_PER_MINUTE = 6000;
const REFUSED_REQUESTS_PER_MINUTE = 30;
const CALLER = "artifactsContentCaller";
const callerOf = (res: Response): number | null => (typeof res.locals[CALLER] === "number" ? res.locals[CALLER] : null);

/**
 * The content Worker's routes. The caller is the content Worker only:
 * `Authorization: Bearer <token>`, one of ARTIFACTS_CONTENT_RAFT_TOKENS,
 * compared in constant time. With none configured every route here answers
 * 404 (core mounts this ahead of its machine-auth `/internal` router, so
 * nothing falls through to it). A refused token is logged with the route and
 * the source address only.
 */
export function mountArtifactContent(mount: InternalMount): void {
  const contentApi = createArtifactContentApi();
  // Read the tokens once at startup, so a bad configuration (short or shared
  // tokens) is logged before the first request.
  contentCallerTokens();
  const router = Router();

  router.use((req: Request, res: Response, next: NextFunction) => {
    const tokens = contentCallerTokens();
    if (tokens.length === 0) {
      refuse(res, 404, INTERNAL_ROUTE_NOT_FOUND);
      return;
    }
    res.locals[CALLER] = matchContentCaller(req.headers.authorization, tokens);
    next();
  });

  // replica-local: abuse guard, a per-replica budget is acceptable (the Worker
  // spreads over replicas and caches authorize 30 s and manifests per isolate).
  router.use(rateLimit({
    windowMs: 60 * 1000,
    limit: (_req, res) => (callerOf(res) === null ? REFUSED_REQUESTS_PER_MINUTE : WORKER_REQUESTS_PER_MINUTE),
    keyGenerator: (req, res) => {
      const caller = callerOf(res);
      return caller === null ? `refused:${ipKeyGenerator(mount.clientIp(req))}` : `worker:${caller}`;
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: workerRateLimited(),
  }));

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (callerOf(res) === null) {
      console.warn("[artifacts-content] refused token", { route: `${req.method} ${req.baseUrl}${req.path}`, source: mount.clientIp(req) });
      refuse(res, 401, WORKER_UNAUTHORIZED);
      return;
    }
    next();
  });

  router.post("/authorize", async (req, res) => {
    try {
      const result = await contentApi.authorize(req.body);
      if (result.kind === "error") refuse(res, result.status, result.refusal);
      else res.status(200).json(result.body);
    } catch (err) {
      if (res.headersSent) return;
      console.error("internal.artifacts-content.authorize failed", mount.serializeError(err));
      res.status(500).json({ error: "Failed to authorize" });
    }
  });

  // Whether an Artifact embeds now (contentRoutes.ts decideEmbeddable): the Worker's embed host asks.
  router.get("/embeds/:artifact", async (req, res) => {
    try {
      const result = await contentApi.embed(req.params.artifact);
      if (result.kind === "error") refuse(res, result.status, result.refusal);
      else res.status(200).json(result.body);
    } catch (err) {
      if (res.headersSent) return;
      console.error("internal.artifacts-content.embed failed", mount.serializeError(err));
      res.status(500).json({ error: "Failed to read embed" });
    }
  });

  router.get("/versions/:version", async (req, res) => {
    try {
      const result = await contentApi.manifest(req.params.version, req.query.artifact);
      if (result.kind === "error") refuse(res, result.status, result.refusal);
      else res.status(200).json(result.body);
    } catch (err) {
      if (res.headersSent) return;
      console.error("internal.artifacts-content.manifest failed", mount.serializeError(err));
      res.status(500).json({ error: "Failed to read version" });
    }
  });

  mount.use("artifacts-content", router);
}

/** Every internal route of the module: the content Worker's and the check Worker's, each behind its own token. */
export function mountArtifactInternals(mount: InternalMount): void {
  mountArtifactContent(mount);
  mountArtifactCheck(mount);
}
