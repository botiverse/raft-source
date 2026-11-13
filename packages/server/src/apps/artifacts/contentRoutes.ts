// What the content Worker asks Raft, `/internal/artifacts-content/*`
// (docs/development/workspace-artifacts-content-origin.md, "Flow" steps 5
// and 6, "Internal contract"). mount.ts mounts it (core's internal mount),
// checking the Worker's token (contentCallerTokens / matchContentCaller,
// contentWorker.ts) and rate limiting it. First-party only (A11): never
// reachable with a user's or an agent's credential.
//
// `POST authorize { artifact, version, subject }`, on every content request
// (the Worker caches answers 30 s and treats an error as deny), checks in
// this order:
// 1. the subject is exactly `v1:<server>:<user>:<family|->` (`bad-subject`);
// 2. the user exists and isn't retired, and the session family (if any)
//    exists, is the user's and isn't revoked (`signed-out`: signing out ends
//    content access; platform/session signedIn);
// 3. the Artifact exists and isn't deleted or revoked, and the version is a
//    published one of it (`deleted`);
// 4. Artifacts is on for the deployment and the Artifact's own server
//    isn't deleted (apiCommon itemServerEnabled), the user still stands in
//    the subject's server (a
//    member of any role: this binds the subject to its server for every
//    home, public included, so neither a removed member nor a subject naming
//    a server its user was never in passes), canViewArtifacts holds for the
//    user on that server now (home, membership, a joint through that
//    server's projection), and an outsider (another server's reader of a
//    public Artifact) asks for the current version of a members-only-history
//    Artifact (`not-visible`).
//
// A signed-out visitor's subject, `v1:anon:<artifact>:<version>`
// (contentWorker.ts anonymousContentSubject, issued by publicRoutes.ts), is
// decided by decideAnonymous instead, from the item row and the version row
// only (no user, session or membership to read), in this order:
// 1. the subject names exactly the `artifact` and `version` asked about
//    (`bad-subject`);
// 2. the Artifact exists and isn't deleted or revoked, and the version is a
//    published one of it (`deleted`);
// 3. its home is public (`not-public`; canViewArtifactsAnonymously);
// 4. the version is its current one (`not-current`: a newer version, or one
//    revoked, ends the old frame);
// 5. workspace_artifacts_v0 is on for the Artifact's own server, which
//    isn't deleted (`not-visible`; apiCommon itemServerEnabled).
// Unpublishing or deleting it therefore denies the next content request the
// Worker doesn't answer from its 30 s cache.
//
// An embed session's subject, `v1:embed:<artifact>:<version>` (contentWorker.ts
// embedContentSubject; minted by the content Worker below its embed host, never
// signed here), is decided by decideEmbed: exactly decideAnonymous's checks, in
// its order (a public Artifact's current version, its server live with
// workspace_artifacts_v0). An embed reads what a signed-out visitor reads, no
// more; its kill switch is the Worker's EMBEDS (no new flag).
//
// A publish check's subject, `v1:check:<artifact>:<version>` (contentWorker.ts
// checkContentSubject, signed only by the check's durable task: checkFrame.ts),
// is decided by decideCheck, from the item, version and check rows and the
// Artifact's own server's flags, in this order:
// 1. the subject names exactly the `artifact` and `version` asked about
//    (`bad-subject`);
// 2. the Artifact exists and isn't deleted or revoked, and the version is a
//    published one of it, current or not (`deleted`);
// 3. the deployment has a check Worker (checksConfigured) and
//    workspace_artifacts_v0 is on for the
//    Artifact's own server, which isn't deleted (`not-visible`); its home is
//    not asked: a check reads any Artifact's version, as its server does;
// 4. the version's entry is a kind a check opens (shared
//    ARTIFACT_CHECKED_KINDS: HTML, not Markdown, nor PDF for now) and that
//    version's check is running now (`not-checking`): the subject reads
//    only while the check task has it open, never after.
// It is nobody: no user, session or membership is read, nothing is written
// (no read position, presence or Activity, no notice), and the answer is the
// same `{ allow: true }` as any, which carries no level or capability; the
// grant the Worker makes of it must be the least there is (Porthole's
// anonymous one: no viewer level, so no runtime host function).
//
// `GET versions/:version?artifact=` is the version's manifest (immutable; the
// Worker caches it): a published version of a live Artifact whose kind is
// framed, else 404. Only files whose bytes are ready in R2, in a blob of the
// Artifact's own server, are listed, with their `r2_key`: the key relative to
// Artifacts' prefix (`servers/<server>/blobs/<sha256>/<blob id>`). The Worker
// adds the fixed `apps/artifacts/` itself and takes no full path from here.
//
// `GET embeds/:artifact` is whether an Artifact embeds now (#proj-workspace:#260,
// Porthole P143), for the Worker's embed host and `/_raft/embed`: `{ artifact,
// version, kind, title }` (its current version, the kind of its entry, its
// title) only where the signed-out public page would show it (publicRoutes.ts
// publicItemOf: public, live, not revoked, a current version, its server live
// with workspace_artifacts_v0) and the kind is framed (html, markdown, pdf);
// every other case (no such Artifact, a malformed id, private, server-only, a
// conversation's, deleted, taken down, a kind the shell draws, and every
// Artifact while the server's ARTIFACTS_EMBED_ORIGIN is unset: embeds off,
// the same switch that hides the web's Copy embed code) is the one 404,
// the same body. The Worker reuses a yes 30 s (the takedown bound). Counted in
// `slock_app_operations_total{app="artifacts",operation="content_embed"}`
// (embeds | not_embeddable), as the content reads (authorize, manifest) are
// counted per operation; nothing is written.
import { and, asc, eq } from "drizzle-orm";
import { artifactFileType, isArtifactCheckedKind, isArtifactFramedKind, type ArtifactFramedKind } from "@botiverse/raft-shared";
import { getDb } from "../../platform/db";
import { artifactsEmbedOrigin } from "../../platform/links";
import type { RefusalInput } from "../../platform/refusals";
import { signedIn } from "../../platform/session";
import { countAppOperation, withAppSpan } from "../../platform/tracing";
import { standsInOwnServer, type ViewActor } from "../../platform/visibility";
import { artifactsEnabled, currentVersionOf, itemServerEnabled, readableVersion, readsAsOutsider, type ArtifactApiJson } from "./apiCommon";
import { isCheckRunning } from "./checks";
import { checksConfigured } from "./checkWorkerToken";
import {
  parseAnonymousContentSubject,
  parseCheckContentSubject,
  parseContentSubject,
  parseEmbedContentSubject,
  type AnonymousContentSubject,
  type CheckContentSubject,
} from "./contentWorker";
import { publicItemOf } from "./publicRoutes";
import { artifactBlobs, artifactItems, artifactVersionFiles, artifactVersions } from "./schema";
import { canViewArtifacts, canViewArtifactsAnonymously } from "./visibility";

export { contentCallerTokens, matchContentCaller } from "./contentWorker";

export type ArtifactContentDenial = "bad-subject" | "signed-out" | "not-visible" | "deleted" | "not-public" | "not-current" | "not-checking";
export type ArtifactContentDecision = { allow: true } | { allow: false; code: ArtifactContentDenial };

export interface ArtifactContentManifest {
  artifact: string;
  version: string;
  number: number;
  kind: ArtifactFramedKind;
  entry: string;
  spa: boolean;
  title: string;
  /** Servable files only: `key` is relative to Artifacts' prefix; the Worker reads `apps/artifacts/<key>`. */
  files: Array<{ path: string; size: number; sha256: string; key: string }>;
}

/** What the Worker's embed host shows of an Artifact that embeds now (`GET embeds/:artifact`). */
export interface ArtifactContentEmbed {
  artifact: string;
  version: string;
  kind: ArtifactFramedKind;
  title: string;
}

/** A refusal of the content Worker's routes, in the refusal envelope (mount.ts writes it with refuse()). */
export type ArtifactContentError = { kind: "error"; status: 400 | 404; refusal: RefusalInput };

const deny = (code: ArtifactContentDenial): ArtifactApiJson<ArtifactContentDecision> => ({ kind: "json", body: { allow: false, code } });
// One answer for a version that isn't there, isn't published, belongs to a deleted or revoked Artifact, or isn't framed.
const notFound = (): ArtifactContentError => ({
  kind: "error",
  status: 404,
  refusal: { code: "CONTENT_NOT_FOUND", error: "No published version by that id can be framed for that artifact: it isn't there, was deleted, or isn't a framed kind, so don't serve it." },
});
// One answer for every Artifact that doesn't embed: no such Artifact, not public, not live, not framed.
const notEmbeddable = (): ArtifactContentError => ({
  kind: "error",
  status: 404,
  refusal: { code: "CONTENT_NOT_FOUND", error: "No public Artifact by that id can be embedded: it isn't there, isn't public, or isn't a framed kind, so don't serve it." },
});
const invalidBody = (): ArtifactContentError => ({
  kind: "error",
  status: 400,
  refusal: { code: "INVALID_REQUEST", error: "An authorize request is a JSON object with the strings artifact, version and subject: send it in that shape." },
});

/** The live Artifact `artifactId` and its published version `versionId`, or null. */
async function publishedVersion(artifactId: string, versionId: string) {
  const db = getDb();
  const [item] = await db.select().from(artifactItems).where(eq(artifactItems.id, artifactId)).limit(1);
  if (!item || item.deletedAt !== null || item.revokedAt !== null) return null;
  const [version] = await db.select().from(artifactVersions)
    .where(and(readableVersion(item.id), eq(artifactVersions.id, versionId)))
    .limit(1);
  return version ? { item, version } : null;
}

type AuthorizeAnswer = ArtifactApiJson<ArtifactContentDecision> | ArtifactContentError;

/**
 * A signed-out visitor's subject, or an embed session's (decideEmbed: an embed reads what a visitor
 * reads): the Artifact's current version while it is public (the checks in the file's header).
 */
async function decideAnonymous(subject: AnonymousContentSubject, artifact: string, version: string): Promise<AuthorizeAnswer> {
  if (subject.artifact !== artifact || subject.version !== version) return deny("bad-subject");
  const found = await publishedVersion(artifact, version);
  if (!found) return deny("deleted");
  const { item } = found;
  if (!canViewArtifactsAnonymously([item])[0]) return deny("not-public");
  if (item.currentVersionId !== version) return deny("not-current");
  if (!(await itemServerEnabled(item))) return deny("not-visible");
  return { kind: "json", body: { allow: true } };
}

/** A publish check's subject: exactly that version, while its check runs (the checks in the file's header). */
async function decideCheck(subject: CheckContentSubject, artifact: string, version: string): Promise<AuthorizeAnswer> {
  if (subject.artifact !== artifact || subject.version !== version) return deny("bad-subject");
  const found = await publishedVersion(artifact, version);
  if (!found) return deny("deleted");
  const { item } = found;
  if (!checksConfigured() || !(await itemServerEnabled(item))) return deny("not-visible");
  // A kind no check opens (shared ARTIFACT_CHECKED_KINDS: Markdown, PDF for now) is never being checked.
  if (!isArtifactCheckedKind(artifactFileType(found.version.entry).kind)) return deny("not-checking");
  if (!(await isCheckRunning(version))) return deny("not-checking");
  return { kind: "json", body: { allow: true } };
}

/** The Worker's authorize: whether the subject may read the version now. */
async function decideAuthorize(body: unknown): Promise<AuthorizeAnswer> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return invalidBody();
  const { artifact, version, subject } = body as Record<string, unknown>;
  if (typeof artifact !== "string" || typeof version !== "string" || typeof subject !== "string") return invalidBody();
  const anonymous = parseAnonymousContentSubject(subject);
  if (anonymous) return decideAnonymous(anonymous, artifact, version);
  // decideEmbed: an embed session reads exactly what a signed-out visitor reads.
  const embed = parseEmbedContentSubject(subject);
  if (embed) return decideAnonymous(embed, artifact, version);
  const check = parseCheckContentSubject(subject);
  if (check) return decideCheck(check, artifact, version);
  const reader = parseContentSubject(subject);
  if (!reader) return deny("bad-subject");
  if (!(await signedIn(reader.userId, reader.sessionFamilyId))) return deny("signed-out");
  const found = await publishedVersion(artifact, version);
  if (!found) return deny("deleted");
  const { item } = found;
  // Artifacts on for the deployment, and the Artifact's own server still exists (apiCommon itemServerEnabled).
  if (!(await itemServerEnabled(item))) return deny("not-visible");
  const actor: ViewActor = { type: "user", id: reader.userId, serverId: reader.serverId };
  if (!(await standsInOwnServer(actor))) return deny("not-visible");
  const [visible] = await canViewArtifacts(actor, [item]);
  if (!visible) return deny("not-visible");
  // An outsider (apiCommon readsAsOutsider) reads the current version only.
  if (readsAsOutsider(reader.serverId, item) && (await currentVersionOf(item))?.id !== version) return deny("not-visible");
  return { kind: "json", body: { allow: true } };
}

/** `server.artifacts.content.authorize`'s end (trace.ts): allow, the denial code, or invalid_body. */
function authorizeOutcome(answer: AuthorizeAnswer): { outcome: string } {
  if (answer.kind === "error") return { outcome: "invalid_body" };
  return { outcome: answer.body.allow ? "allow" : answer.body.code };
}

/** Whether `artifactId` embeds now: its current version, kind and title, or the one 404 (the checks in the file's header). */
async function decideEmbeddable(artifactId: string): Promise<ArtifactApiJson<ArtifactContentEmbed> | ArtifactContentError> {
  // Embeds off on this server (no ARTIFACTS_EMBED_ORIGIN, so the web offers no Embed): nothing embeds.
  const found = artifactsEmbedOrigin() === null ? null : await publicItemOf(artifactId);
  const kind = found && artifactFileType(found.version.entry).kind;
  if (!found || !kind || !isArtifactFramedKind(kind)) {
    countAppOperation("artifacts", "content_embed", "not_embeddable");
    return notEmbeddable();
  }
  countAppOperation("artifacts", "content_embed", "embeds");
  return { kind: "json", body: { artifact: found.item.id, version: found.version.id, kind, title: found.item.title } };
}

export function createArtifactContentApi() {
  return {
    embed: (artifactId: string) => decideEmbeddable(artifactId),
    authorize: (body: unknown): Promise<AuthorizeAnswer> => withAppSpan("server.artifacts.content.authorize", {}, () => decideAuthorize(body), { onSuccess: authorizeOutcome }),
    manifest: async (versionId: string, artifactId: unknown): Promise<ArtifactApiJson<ArtifactContentManifest> | ArtifactContentError> => {
      if (typeof artifactId !== "string") return notFound();
      const found = await publishedVersion(artifactId, versionId);
      if (!found) return notFound();
      const { item, version } = found;
      const kind = artifactFileType(version.entry).kind;
      if (!isArtifactFramedKind(kind)) return notFound();
      const files = await getDb()
        .select({ path: artifactVersionFiles.path, size: artifactVersionFiles.sizeBytes, sha256: artifactVersionFiles.sha256, key: artifactBlobs.r2Key })
        .from(artifactVersionFiles)
        .innerJoin(artifactBlobs, eq(artifactBlobs.id, artifactVersionFiles.blobId))
        .where(and(
          eq(artifactVersionFiles.versionId, version.id),
          eq(artifactBlobs.state, "ready"),
          eq(artifactBlobs.serverId, item.serverId),
        ))
        .orderBy(asc(artifactVersionFiles.path));
      return {
        kind: "json",
        body: {
          artifact: item.id,
          version: version.id,
          number: version.number,
          kind,
          entry: version.entry,
          spa: version.spa,
          title: version.title ?? item.title,
          files: files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256, key: file.key })),
        },
      };
    },
  };
}

export type ArtifactContentApi = ReturnType<typeof createArtifactContentApi>;
