// FAKE DATA (S3 web, before the server side exists). Every Artifact the web
// app shows behind workspace_artifacts_v0 comes from here until Remy's routes
// land (docs/development/workspace-artifacts.md, S3). The methods answer the
// way the API draft does: a hidden, missing or deleted Artifact throws 404
// NOT_VISIBLE; home changes (larger and smaller, with the narrowing
// preview, back only to the original conversation), the share's widenTo
// and widenRefused, and the capabilities follow the server's
// rules (packages/server src/apps/artifacts/manage.ts, webShare.ts).
// Ids are `pt_fake-…`, so a real link never resolves to a fixture; any other
// id is not visible.
import {
  ARTIFACT_COMMENT_MAX_CHARS,
  ARTIFACT_DRAFT_MAX_PER_ARTIFACT,
  ARTIFACT_DRAFT_TTL_DAYS,
  ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT,
  ARTIFACT_DASHBOARD_CONVERSATIONS_LIMIT,
  ARTIFACT_COMMENT_MAX_MENTIONS,
  ARTIFACT_SAVE_MAX_BINARY_BYTES,
  ARTIFACT_SAVE_MAX_TEXT_BYTES,
  ARTIFACT_SHARE_NOTE_MAX_CHARS,
  artifactFileType,
  artifactTitleFromFileName,
  asArtifactCommentDraftId,
  asArtifactCommentId,
  asArtifactId,
  asChannelId,
  asArtifactReviewId,
  asMessageId,
  asServerId,
  currentTimeMs,
  isArtifactFramedKind,
} from "@botiverse/raft-shared";
import type {
  ArtifactActor,
  ArtifactCard,
  ArtifactComment,
  ArtifactCommentAnchor,
  ArtifactCommentDraft,
  ArtifactCommentDraftId,
  ArtifactCommentId,
  ArtifactCommentPart,
  ArtifactDashboardAuthor,
  ArtifactDashboardConversation,
  ArtifactDashboardHome,
  ArtifactFile,
  ArtifactHome,
  ArtifactId,
  ArtifactNoticeReason,
  ArtifactPresence,
  ArtifactReference,
  ArtifactReviewId,
  ArtifactReviewRejected,
  ArtifactVersionSummary,
  ArtifactViewerData,
  ArtifactWebCommentInput,
  ArtifactWebCommentsPage,
  ArtifactWebErrorDetails,
  ArtifactWebFrame,
  ArtifactWebHomeChange,
  ArtifactWebShareAudience,
  ArtifactWebShared,
  ArtifactWillNotify,
} from "@botiverse/raft-shared";

import { artifactUrl } from "./artifactLinks";
// Fixture titles and descriptions are user content, kept as data (not UI copy).
import fakeArtifactText from "./fakeArtifactText.json";
import fakeArtifactComments from "./fakeArtifactComments.json";
import { FLOW_SVG, SIGNUPS_CSV, WIREFRAME_PNG_BASE64 } from "./fakeArtifactFiles";
import { claimFakeCommentImages, fakeCommentImageRoutes, fakeFixtureCommentImages, releaseFakeCommentImages, resetFakeCommentImages, withoutFakeImages } from "./fakeArtifactCommentImages";
import { ACTORS, ME, MENTIONABLE, MENTION_CANDIDATES, actorKey, artin, cindy, fakeAuthorCandidates, fakeAuthorKeys, niko, pico, remy, xxchan } from "./fakeArtifactActors";
import { fakeDashboardAllPage } from "./fakeDashboardAllOrder";
import { fakeDashboardAllListed } from "./fakeDashboardAllFilter";
import { changeFakeResolution, reopenFakeThreadOf } from "./fakeArtifactResolutions";
import type { ArtifactLinkTarget } from "./artifactLinks";
import { useServerStore } from "../../store/serverStore";
import { viewerResultOf } from "./artifactApi";
import type { FakeArtifactEntry } from "./artifactSource";
import type { ArtifactApiError, ArtifactFileTarget, ArtifactHomeChangeTarget, ArtifactSource } from "./artifactApi";

const TEXT: Record<string, { title: string; description: string | null }> = fakeArtifactText;

const MINUTE = 60_000;
const ago = (minutes: number) => new Date(currentTimeMs() - minutes * MINUTE).toISOString();

/** The longest comment text the fake accepts (FIELD_TOO_LONG past it). */
/** The server's limit (ARTIFACT_COMMENT_MAX_CHARS); the fake counts only the text parts. */
export const FAKE_COMMENT_MAX_LENGTH = ARTIFACT_COMMENT_MAX_CHARS;

/** A text file the shell draws, with line comments (S4). */
const RUNBOOK_TEXT = fakeArtifactComments.runbookText;

/**
 * The fake frame route (S2): one fixed FrameLocation per framed fixture, on
 * a local content origin, `http://w-<uuid>.content.localhost:8791` (the
 * content Worker's `w-` labels; every `*.localhost` name is loopback and a
 * site of its own). `scripts/fake-artifact-content.ts` serves it: its
 * `/_fake/enter` asks its own Porthole host for a ticket on every load, so
 * each mount still enters with a fresh one; it answers the door (P125) too.
 * Unit tests use their own fixed location and never need it.
 */
export const FAKE_CONTENT_DOMAIN = "content.localhost:8791";

function fakeFrameLocation(id: ArtifactId, version: number): ArtifactWebFrame {
  const origin = `http://w-${id.slice("pt_".length)}.${FAKE_CONTENT_DOMAIN}`;
  return { url: `${origin}/_fake/enter?version=${version}`, origin, reports: true, door: { url: `${origin}/__porthole/door/_fake?version=${version}` } };
}

/** The fake's reader is always of the Artifact's server, so its author and publishers have their ids. */
type FakeVersion = ArtifactVersionSummary & { publisher: ArtifactActor };
interface Fixture {
  card: Omit<ArtifactCard, "url" | "version" | "pinned" | "author"> & { author: ArtifactActor };
  /** Text and bytes per path, as the file-content endpoint answers. */
  texts?: Record<string, string>;
  bytes?: Record<string, { type: string; base64: string }>;
  files: ArtifactFile[];
  versions: FakeVersion[];
  /**
   * As at the fixture's own home. Any of changeHome, unpublish and
   * narrowHome says the viewer may move it (the server's mayManageArtifact);
   * those three then follow the home it is in now (capabilitiesAt).
   */
  capabilities: ArtifactViewerData["capabilities"];
  following: boolean;
  savedFrom: ArtifactViewerData["savedFrom"];
  /** Absent: none. */
  origin?: ArtifactViewerData["origin"];
  /** Who follows it besides the viewer (willNotify `subscribed`). */
  subscribers?: ArtifactActor[];
  presence?: ArtifactPresence;
}

function versionsOf(latest: number, publisher: ArtifactActor, path: string): FakeVersion[] {
  return Array.from({ length: latest }, (_, i) => latest - i).map((number) => ({
    number,
    publisher,
    createdAt: ago(10 + (latest - number) * 180),
    note: number === 1 ? null : `Update ${number}`,
    changedPaths: [path],
  }));
}

const channelHome = (id: string, name: string, type: "channel" | "private" | "dm"): ArtifactHome => ({ kind: "conversation", conversation: { id, name, type } });

const FIXTURES: Record<string, Fixture> = {
  "pt_fake-bundle-report": {
    card: {
      id: asArtifactId("pt_fake-bundle-report"),
      ...TEXT["pt_fake-bundle-report"],
      kind: "html",
      facts: { sizeBytes: 48_213, fileCount: 2 },
      preview: { kind: "excerpt", text: "Daemon bundle size: 1.0.48 candidate" },
      latestVersion: 4,
      author: niko,
      createdAt: ago(2 * 24 * 60),
      updatedAt: ago(10),
      commentCount: 7,
      home: channelHome("fake-channel-daemon-size", "proj-daemon-size", "channel"),
    },
    files: [
      { path: "index.html", kind: "html", sizeBytes: 41_002, entry: true },
      { path: "data.json", kind: "text", sizeBytes: 7_211, entry: false },
    ],
    texts: { "data.json": "{}" },
    versions: versionsOf(4, niko, "index.html"),
    capabilities: { publish: true, comment: true, changeHome: true, unpublish: false, narrowHome: false, delete: true },
    following: true,
    savedFrom: null,
    subscribers: [artin],
    presence: {
      viewing: [
        { actor: { ...cindy, type: "user" }, state: "viewing", path: "index.html", since: ago(3) },
        { actor: { ...niko, type: "agent" }, state: "writing", path: "index.html", since: ago(1) },
        { actor: { ...remy, type: "agent" }, state: "reading", path: null, since: ago(2) },
      ],
      readCurrentVersion: [{ actor: artin, at: ago(8) }],
      readOtherVersion: [],
    },
  },
  "pt_fake-launch-plan": {
    card: {
      id: asArtifactId("pt_fake-launch-plan"),
      ...TEXT["pt_fake-launch-plan"],
      kind: "markdown",
      facts: { sizeBytes: 3_420, fileCount: 1 },
      preview: { kind: "excerpt", text: "Goal: ship 1.1 before September 30…" },
      latestVersion: 2,
      author: xxchan,
      createdAt: ago(5 * 24 * 60),
      updatedAt: ago(3 * 60),
      commentCount: 2,
      home: { kind: "server" },
    },
    files: [{ path: "plan.md", kind: "markdown", sizeBytes: 3_420, entry: true }],
    versions: versionsOf(2, xxchan, "plan.md"),
    capabilities: { publish: false, comment: true, changeHome: false, unpublish: false, narrowHome: false, delete: false },
    following: false,
    savedFrom: null,
  },
  "pt_fake-signups": {
    card: {
      id: asArtifactId("pt_fake-signups"),
      ...TEXT["pt_fake-signups"],
      kind: "csv",
      facts: { sizeBytes: SIGNUPS_CSV.length, fileCount: 1, rows: 5, columns: 4, columnNames: ["Channel", "September", "October", "Change"] },
      preview: { kind: "none" },
      latestVersion: 1,
      author: cindy,
      createdAt: ago(45),
      updatedAt: ago(45),
      commentCount: 1,
      home: channelHome("fake-channel-growth", "growth", "private"),
    },
    files: [{ path: "signups.csv", kind: "csv", sizeBytes: SIGNUPS_CSV.length, entry: true }],
    texts: { "signups.csv": SIGNUPS_CSV },
    versions: versionsOf(1, cindy, "signups.csv"),
    capabilities: { publish: true, comment: true, changeHome: true, unpublish: false, narrowHome: false, delete: true },
    following: true,
    // Saved from an attachment (S5): the viewer data names the message it came from.
    savedFrom: { attachmentId: "fake-attachment-1", messageId: "fake-message-1", conversationId: "fake-channel-growth" },
    // Its original message (#proj-workspace:#72): that attachment's. The other fixtures have none.
    origin: { messageId: asMessageId("fake-message-1"), conversationId: asChannelId("fake-channel-growth"), via: "attachment" },
    // Only people follow it and comment on it: no agent among those a comment here notifies.
    subscribers: [artin],
    presence: {
      viewing: [{ actor: { ...artin, type: "user" }, state: "viewing", path: "signups.csv", since: ago(4) }],
      readCurrentVersion: [{ actor: cindy, at: ago(30) }],
      readOtherVersion: [],
    },
  },
  "pt_fake-runbook": {
    card: {
      id: asArtifactId("pt_fake-runbook"),
      ...TEXT["pt_fake-runbook"],
      kind: "text",
      facts: { sizeBytes: RUNBOOK_TEXT.length, fileCount: 1, lines: RUNBOOK_TEXT.split("\n").length - 1 },
      preview: { kind: "excerpt", text: "Staging deploy runbook: 1.0.48 candidate" },
      latestVersion: 2,
      author: niko,
      createdAt: ago(26 * 60),
      updatedAt: ago(10),
      commentCount: 4,
      home: channelHome("fake-channel-daemon-size", "proj-daemon-size", "channel"),
    },
    files: [{ path: "runbook.txt", kind: "text", sizeBytes: RUNBOOK_TEXT.length, entry: true }],
    texts: { "runbook.txt": RUNBOOK_TEXT },
    versions: versionsOf(2, niko, "runbook.txt"),
    capabilities: { publish: true, comment: true, changeHome: true, unpublish: false, narrowHome: false, delete: true },
    following: false,
    savedFrom: null,
    presence: {
      viewing: [{ actor: { ...niko, type: "agent" }, state: "reading", path: "runbook.txt", since: ago(2) }],
      readCurrentVersion: [{ actor: cindy, at: ago(20) }],
      readOtherVersion: [],
    },
  },
  "pt_fake-wireframe": {
    card: {
      id: asArtifactId("pt_fake-wireframe"),
      ...TEXT["pt_fake-wireframe"],
      kind: "image",
      facts: { sizeBytes: 1_291, fileCount: 1, width: 64, height: 40 },
      preview: { kind: "none" },
      latestVersion: 3,
      author: remy,
      createdAt: ago(3 * 24 * 60),
      updatedAt: ago(26 * 60),
      commentCount: 7,
      home: { kind: "public" },
    },
    files: [{ path: "wireframe.png", kind: "image", sizeBytes: 1_291, entry: true }],
    bytes: { "wireframe.png": { type: "image/png", base64: WIREFRAME_PNG_BASE64 } },
    versions: versionsOf(3, remy, "wireframe.png"),
    capabilities: { publish: false, comment: true, changeHome: false, unpublish: false, narrowHome: false, delete: false },
    following: false,
    savedFrom: null,
  },
  "pt_fake-flow": {
    card: {
      id: asArtifactId("pt_fake-flow"),
      ...TEXT["pt_fake-flow"],
      kind: "image",
      facts: { sizeBytes: FLOW_SVG.length, fileCount: 1, width: 480, height: 200 },
      preview: { kind: "none" },
      latestVersion: 1,
      author: niko,
      createdAt: ago(90),
      updatedAt: ago(90),
      commentCount: 0,
      home: channelHome("fake-channel-daemon-size", "proj-daemon-size", "channel"),
    },
    // SVG is drawn like png: bytes from the file route as an <img src=blob:>, never inline.
    bytes: { "flow.svg": { type: "image/svg+xml", base64: btoa(FLOW_SVG) } },
    files: [{ path: "flow.svg", kind: "image", sizeBytes: FLOW_SVG.length, entry: true }],
    versions: versionsOf(1, niko, "flow.svg"),
    capabilities: { publish: true, comment: true, changeHome: true, unpublish: false, narrowHome: false, delete: true },
    following: false,
    savedFrom: null,
  },
  "pt_fake-contract": {
    card: {
      id: asArtifactId("pt_fake-contract"),
      ...TEXT["pt_fake-contract"],
      kind: "pdf",
      facts: { sizeBytes: 1_258_291, fileCount: 1, pages: 6 },
      preview: { kind: "none" },
      latestVersion: 1,
      author: xxchan,
      createdAt: ago(4 * 60),
      updatedAt: ago(4 * 60),
      commentCount: 0,
      home: channelHome("fake-dm-cindyz", "cindyz", "dm"),
    },
    files: [{ path: "contract.pdf", kind: "pdf", sizeBytes: 1_258_291, entry: true }],
    versions: versionsOf(1, xxchan, "contract.pdf"),
    capabilities: { publish: true, comment: true, changeHome: true, unpublish: false, narrowHome: false, delete: true },
    following: false,
    savedFrom: null,
  },
};

/** An id the fake answers as not visible (any id not in the fixtures is). */
export const FAKE_UNAVAILABLE_ARTIFACT_ID: ArtifactId = asArtifactId("pt_fake-hidden-budget");

/** The fake's writes, per Artifact, for the session. */
const overrides = new Map<string, { home?: ArtifactHome; following?: boolean; deleted?: boolean; originalHome?: string | null; title?: string }>();

/**
 * The conversation it was made in (the server's `original_home_channel_id`,
 * #75): the fixture's own conversation home, never moved by a home change;
 * none for one made on the server or public. Tests may set another (or none).
 */
function originalHomeOf(fixture: Fixture): string | null {
  const override = overrides.get(fixture.card.id);
  if (override && override.originalHome !== undefined) return override.originalHome;
  return fixture.card.home.kind === "conversation" ? fixture.card.home.conversation.id : null;
}

/** Tests: the Artifact's original conversation (an id the fake doesn't know: deleted or unseen), or none; undefined puts back the fixture's. */
export function setFakeOriginalHomeForTests(id: string, conversationId: string | null | undefined): void {
  overrides.set(id, { ...overrides.get(id), originalHome: conversationId });
}

/**
 * The original conversation as the server tells it to this viewer
 * (manage.ts shownOriginalHome): while it exists as a conversation an
 * Artifact can live in (not a thread, not a joint channel); else null.
 */
function shownOriginalHome(fixture: Fixture): string | null {
  const original = originalHomeOf(fixture);
  if (original === null) return null;
  const conversation = FAKE_CONVERSATIONS[original];
  return conversation && !conversation.unsupported ? original : null;
}

const notVisible = (): ArtifactApiError => ({ status: 404, code: "NOT_VISIBLE" });

function fixtureOf(id: string): Fixture {
  const fixture = FIXTURES[id];
  if (!fixture || overrides.get(id)?.deleted) throw notVisible();
  return fixture;
}

/** Where it lives now: the fake's move, else the fixture's home. */
function homeOf(fixture: Fixture): ArtifactHome {
  return overrides.get(fixture.card.id)?.home ?? fixture.card.home;
}

/** Whether the fake viewer may move it (the server's mayManageArtifact: author, agent's manager, owners and admins). */
function manages(fixture: Fixture): boolean {
  const { changeHome, unpublish, narrowHome } = fixture.capabilities;
  return changeHome || unpublish || narrowHome;
}

/** Where a narrowing may take it, as the viewer says it (webViewer.ts viewerDataOf `originalHome`). */
function originalHomeAt(fixture: Fixture, home: ArtifactHome): ArtifactViewerData["originalHome"] {
  const shown = manages(fixture) && home.kind !== "conversation" ? shownOriginalHome(fixture) : null;
  return shown === null ? null : { conversationId: asChannelId(shown) };
}

/** The capabilities as the server says them for the home it is in now (webViewer.ts viewerDataOf). */
function capabilitiesAt(fixture: Fixture, home: ArtifactHome): ArtifactViewerData["capabilities"] {
  const may = manages(fixture);
  return {
    ...fixture.capabilities,
    changeHome: may && home.kind !== "public",
    unpublish: may && home.kind === "public",
    // Only back to the original conversation (#75): none without one.
    narrowHome: originalHomeAt(fixture, home) !== null,
  };
}

function cardFor(fixture: Fixture, version: number | null): ArtifactCard {
  const latest = fixture.card.latestVersion;
  const shown = version ?? latest;
  if (shown < 1 || shown > latest) throw notVisible();
  // A pinned card shows its version's publisher and publishing time, as the server's.
  const pinnedVersion = version === null ? undefined : fixture.versions.find((entry) => entry.number === shown);
  return {
    ...fixture.card,
    ...(pinnedVersion ? { author: pinnedVersion.publisher, updatedAt: pinnedVersion.createdAt } : {}),
    // The Artifact's title, a pinned card's too (the server's card: the item's).
    title: overrides.get(fixture.card.id)?.title ?? fixture.card.title,
    home: homeOf(fixture),
    url: artifactUrl(fixture.card.id, version),
    version: shown,
    pinned: version !== null,
  };
}

function viewerData(target: ArtifactLinkTarget): ArtifactViewerData {
  const fixture = fixtureOf(target.id);
  const card = cardFor(fixture, target.version);
  return {
    card,
    files: fixture.files,
    versions: fixture.versions,
    capabilities: capabilitiesAt(fixture, card.home),
    originalHome: originalHomeAt(fixture, card.home),
    // The fake source's signed-in person (contract #10877).
    viewer: ME,
    following: overrides.get(card.id)?.following ?? fixture.following,
    savedFrom: fixture.savedFrom,
    origin: fixture.origin ?? null,
  };
}

function resolve(target: ArtifactLinkTarget): ArtifactReference {
  try {
    return { status: "ok", card: cardFor(fixtureOf(target.id), target.version) };
  } catch {
    return { status: "unavailable", url: artifactUrl(target.id, target.version) };
  }
}

function fileOf(file: ArtifactFileTarget): Fixture {
  const fixture = fixtureOf(file.id);
  if (file.version < 1 || file.version > fixture.card.latestVersion) throw notVisible();
  return fixture;
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}


// ---- Comments (S4) ----

type CommentKey = keyof typeof fakeArtifactComments.comments;

/** Fixture text with `@handle` words as mentions of the fake actors. */
function bodyOf(key: CommentKey): ArtifactCommentPart[] {
  const parts: ArtifactCommentPart[] = [];
  for (const piece of fakeArtifactComments.comments[key].split(/(@[a-z]+)/)) {
    const actor = piece.startsWith("@") ? ACTORS[piece.slice(1)] : undefined;
    if (actor) parts.push({ type: "mention", actor });
    else if (piece) parts.push({ type: "text", text: piece });
  }
  return parts;
}

function annotation(key: keyof typeof fakeArtifactComments.anchors): ArtifactCommentAnchor {
  const { label, quote } = fakeArtifactComments.anchors[key];
  return { type: "annotation", data: { kind: "text", label, selectors: [{ type: "TextQuoteSelector", exact: quote }] } };
}

const fileTarget = (path: string, anchor: ArtifactCommentAnchor | null = null): ArtifactComment["target"] => ({ scope: "file", path, anchor });

function fixtureComment(
  key: CommentKey,
  author: ArtifactActor,
  minutesAgo: number,
  version: number,
  target: ArtifactComment["target"],
  extra: { replyTo?: CommentKey; editedMinutesAgo?: number } = {},
): ArtifactComment {
  return {
    id: asArtifactCommentId(`fake-c-${key}`),
    author,
    body: bodyOf(key),
    createdAt: ago(minutesAgo),
    editedAt: extra.editedMinutesAgo === undefined ? null : ago(extra.editedMinutesAgo),
    deletedAt: null,
    version,
    target,
    replyTo: extra.replyTo ? asArtifactCommentId(`fake-c-${extra.replyTo}`) : null,
    ...fakeFixtureCommentImages(key),
    resolvedAt: null,
    resolvedBy: null,
  };
}

/** Every version's comments per Artifact, as the server would store them (not yet in order). */
function fixtureComments(): Record<string, ArtifactComment[]> {
  const runbookStep3 = { start: 5, end: 5, quote: "3. Check the bundle is under 40 MB (1.0.47 was 51 MB)." };
  return {
    "pt_fake-bundle-report": [
      fixtureComment("bundle-weekly", cindy, 300, 2, { scope: "artifact" }),
      fixtureComment("bundle-weekly-reply", niko, 290, 2, { scope: "artifact" }, { replyTo: "bundle-weekly" }),
      fixtureComment("bundle-undici", remy, 500, 1, fileTarget("index.html", annotation("bundle-undici"))),
      fixtureComment("bundle-compressed", xxchan, 150, 3, fileTarget("index.html", annotation("bundle-compressed")), { editedMinutesAgo: 140 }),
      fixtureComment("bundle-compressed-reply", niko, 8, 4, fileTarget("index.html", annotation("bundle-compressed")), { replyTo: "bundle-compressed" }),
      fixtureComment("bundle-data", remy, 6, 4, fileTarget("data.json", { type: "lines", data: { start: 1, end: 1, quote: "{}" } })),
      fixtureComment("bundle-ship", xxchan, 4, 4, fileTarget("index.html")),
    ],
    "pt_fake-signups": [
      fixtureComment("signups-events", cindy, 40, 1, fileTarget("signups.csv", { type: "csv-rows", data: { start: 5, end: 5, quote: "Events <b>(beta)</b>,40,88,+120%" } })),
      fixtureComment("signups-events-reply", xxchan, 35, 1, fileTarget("signups.csv", { type: "csv-rows", data: { start: 5, end: 5 } }), { replyTo: "signups-events" }),
      fixtureComment("signups-partners", artin, 20, 1, fileTarget("signups.csv", { type: "csv-rows", data: { start: 4, end: 4, quote: "Partners,95,140,+47%" } })),
    ],
    "pt_fake-runbook": [
      fixtureComment("runbook-old", cindy, 150, 1, fileTarget("runbook.txt", { type: "lines", data: { start: 13, end: 13, quote: "9. Approve the rollback with the on-call." } })),
      fixtureComment("runbook-watch", cindy, 120, 1, fileTarget("runbook.txt", { type: "lines", data: { start: 8, end: 8, quote: "6. Watch the error rate for 15 minutes." } })),
      fixtureComment("runbook-size", xxchan, 9, 2, fileTarget("runbook.txt", { type: "lines", data: runbookStep3 })),
      fixtureComment("runbook-size-reply", niko, 7, 2, fileTarget("runbook.txt", { type: "lines", data: runbookStep3 }), { replyTo: "runbook-size" }),
    ],
    // Comments that mention the fake reader: what the list's `news.mentions` counts.
    "pt_fake-launch-plan": [
      fixtureComment("launch-date", cindy, 25, 2, { scope: "artifact" }),
      fixtureComment("launch-scope", remy, 12, 2, fileTarget("plan.md")),
    ],
    "pt_fake-wireframe": [
      fixtureComment("wireframe-rail", artin, 50, 3, fileTarget("wireframe.png")),
    ],
  };
}

/**
 * TODO(S4, Porthole P104): whether a page anchor is still found is reported by the frame
 * (Porthole) at run time. Until then every page anchor is attached, except
 * these, which the fake says the page no longer has.
 */
const FAKE_LOST_ANNOTATIONS: ReadonlySet<string> = new Set(["fake-c-bundle-undici"]);

export function fakeAnnotationLost(commentId: string): boolean {
  return FAKE_LOST_ANNOTATIONS.has(commentId);
}

/** The comments the fake holds this session, per Artifact (writes change them). */
let comments: Record<string, ArtifactComment[]> | null = null;
let nextCommentNumber = 1;

function commentsOf(id: ArtifactId): ArtifactComment[] {
  fixtureOf(id);
  comments ??= fixtureComments();
  comments[id] ??= [];
  return comments[id]!;
}

/** Comments per page (the contract's 50; tests make it smaller to page). */
let fakeCommentsPageSize = 50;

export function setFakeCommentsPageSizeForTests(size: number | null): void {
  fakeCommentsPageSize = size ?? 50;
}
function apiError<C extends keyof ArtifactWebErrorDetails>(status: number, code: C, details: ArtifactWebErrorDetails[C]): ArtifactApiError {
  return { status, code, details };
}

/** Who can't see the fake's Artifacts (a mention of them is MENTION_NOT_VISIBLE): Pico, unless a test says otherwise. */
const hiddenMentions = new Set<string>([pico.id]);

/** Tests: whether an actor can see the fake's Artifacts (one who loses access after a draft mentioned them). */
export function setFakeMentionHiddenForTests(actorId: string, hidden: boolean): void {
  if (hidden) hiddenMentions.add(actorId);
  else hiddenMentions.delete(actorId);
}

/** The input's body as stored: mentions named, text checked for length, mentioned actors checked for access. */
function storedBody(body: ArtifactWebCommentInput["body"]): ArtifactCommentPart[] {
  const length = body.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
  if (length > FAKE_COMMENT_MAX_LENGTH) throw apiError(400, "FIELD_TOO_LONG", { field: "body", limit: FAKE_COMMENT_MAX_LENGTH });
  // Distinct people and agents, the author included; exactly the cap is fine.
  const mentions = new Set(body.flatMap((part) => (part.type === "mention" ? [actorKey(part.actor)] : [])));
  if (mentions.size > ARTIFACT_COMMENT_MAX_MENTIONS) throw apiError(400, "TOO_MANY_MENTIONS", { limit: ARTIFACT_COMMENT_MAX_MENTIONS });
  const hidden = body.flatMap((part) => (part.type === "mention" && hiddenMentions.has(part.actor.id) ? [part.actor] : []));
  const unknown = body.flatMap((part) => (part.type === "mention" && !MENTIONABLE.some((a) => actorKey(a) === actorKey(part.actor)) ? [part.actor] : []));
  if (hidden.length + unknown.length > 0) throw apiError(422, "MENTION_NOT_VISIBLE", { actors: [...hidden, ...unknown] });
  return body.map((part) => (part.type === "text" ? part : { type: "mention", actor: MENTIONABLE.find((a) => actorKey(a) === actorKey(part.actor))! }));
}

/** A comment as the comment route checks it: its body as stored, or the route's refusal thrown. */
function checkedComment(id: ArtifactId, input: ArtifactWebCommentInput): ArtifactCommentPart[] {
  const fixture = fixtureOf(id);
  if (!fixture.capabilities.comment) throw { status: 403, code: "FORBIDDEN" } satisfies ArtifactApiError;
  if (input.version < 1 || input.version > fixture.card.latestVersion) {
    throw apiError(404, "VERSION_NOT_FOUND", { version: input.version, currentVersion: fixture.card.latestVersion });
  }
  if (input.target.scope === "file" && !fixture.files.some((f) => f.path === (input.target as { path: string }).path)) {
    throw apiError(404, "FILE_NOT_FOUND", { path: input.target.path, version: input.version });
  }
  if (input.replyTo && !commentsOf(id).some((c) => c.id === input.replyTo)) throw { status: 404, code: "COMMENT_NOT_FOUND" } satisfies ArtifactApiError;
  return storedBody(input.body);
}

// ---- Review drafts (S8), as the server keeps them: the signed-in person's own, per Artifact ----

const DAY_MS = 24 * 60 * 60 * 1000;
const drafts = new Map<ArtifactId, ArtifactCommentDraft[]>();
/** Reviews posted under a clientKey: the same key answers them again (200), as the server's do. */
const reviewsByKey = new Map<string, { digest: string; comments: ArtifactComment[] }>();
/** Posted reviews, as the server keeps them: whose Artifact, its summary (a comment of its own), who and when. */
const reviews = new Map<ArtifactReviewId, { artifact: ArtifactId; summary: ArtifactCommentId | null; createdAt: string }>();
let nextReviewNumber = 1;
let nextDraftNumber = 1;

function draftUuid(): ArtifactCommentDraftId {
  // A fixed shape (the server's uuids), numbered so tests can read them.
  return asArtifactCommentDraftId(`00000000-0000-4000-8000-${String(nextDraftNumber++).padStart(12, "0")}`);
}

/** The person's live drafts on the Artifact (an expired one is gone, as on the server). */
function draftsOf(id: ArtifactId): ArtifactCommentDraft[] {
  const now = currentTimeMs();
  const live = (drafts.get(id) ?? []).filter((d) => Date.parse(d.expiresAt) > now);
  drafts.set(id, live);
  return live;
}

const draftNotFound = (): ArtifactApiError => ({ status: 404, code: "DRAFT_NOT_FOUND" });
const draftInput = (draft: ArtifactCommentDraft): ArtifactWebCommentInput => ({
  body: draft.body.map((part) => (part.type === "text" ? part : { type: "mention", actor: { type: part.actor.type, id: part.actor.id } })),
  version: draft.version,
  target: draft.target,
  replyTo: draft.replyTo,
});
const stamped = (at: number) => ({ updatedAt: new Date(at).toISOString(), expiresAt: new Date(at + ARTIFACT_DRAFT_TTL_DAYS * DAY_MS).toISOString() });

/** The codes a submit's 422 carries (ArtifactReviewRejected); any other refusal is thrown as the route's (403 FORBIDDEN). */
const REJECTED_CODES: ReadonlySet<string> = new Set<ArtifactReviewRejected["code"]>([
  "MENTION_NOT_VISIBLE", "FILE_NOT_FOUND", "VERSION_NOT_FOUND", "FIELD_TOO_LONG", "TOO_MANY_MENTIONS", "INVALID_REQUEST", "INVALID_PATH", "COMMENT_NOT_FOUND",
]);

/** A reply draft's comment, live (as the server's drafts check it): none, 404 COMMENT_NOT_FOUND. */
function liveParent(id: ArtifactId, replyTo: ArtifactCommentId): ArtifactComment {
  const parent = commentsOf(id).find((c) => c.id === replyTo && !c.deletedAt);
  if (!parent) throw { status: 404, code: "COMMENT_NOT_FOUND" } satisfies ArtifactApiError;
  return parent;
}

/** One review's page (`?review=`) as the server answers it: its comments without the summary, which is `review.body`. */
function reviewPage(id: ArtifactId, review: ArtifactReviewId, list: ArtifactComment[]): Pick<ArtifactWebCommentsPage, "comments" | "review"> {
  const kept = reviews.get(review);
  if (!kept || kept.artifact !== id) return { comments: [], review: null };
  const summary = kept.summary ? list.find((c) => c.id === kept.summary && !c.deletedAt) : undefined;
  return {
    comments: list.filter((c) => c.reviewId === review && c.id !== kept.summary),
    review: { id: review, author: ME, body: summary ? summary.body : null, createdAt: kept.createdAt },
  };
}

/** Tests: a draft as if last changed `daysAgo` days ago (its expiry follows). */
export function backdateFakeReviewDraftForTests(id: ArtifactId, draftId: ArtifactCommentDraftId, daysAgo: number): void {
  const at = currentTimeMs() - daysAgo * DAY_MS;
  drafts.set(id, (drafts.get(id) ?? []).map((d) => (d.id === draftId ? { ...d, createdAt: new Date(at).toISOString(), ...stamped(at) } : d)));
}

/** The root of the thread a comment is in. */
function threadRoot(list: ArtifactComment[], id: ArtifactCommentId): ArtifactComment | undefined {
  let comment = list.find((c) => c.id === id);
  for (let hops = 0; comment?.replyTo && hops < 50; hops += 1) {
    const parent = list.find((c) => c.id === comment!.replyTo);
    if (!parent) break;
    comment = parent;
  }
  return comment;
}

const sameTarget = (a: ArtifactComment["target"], path: string | undefined) => (path === undefined ? a.scope === "artifact" : a.scope === "file" && a.path === path);

/** Who would hear about a comment here, as the server answers (no draft @mentions; the viewer left out). */
function willNotifyFor(id: ArtifactId, options: { replyTo?: ArtifactCommentId; path?: string }): ArtifactWillNotify {
  const fixture = fixtureOf(id);
  const list = commentsOf(id);
  const recipients: ArtifactWillNotify["recipients"] = [];
  const add = (actor: ArtifactActor, reason: ArtifactNoticeReason) => {
    if (actorKey(actor) === actorKey(ME) || recipients.some((r) => actorKey(r.actor) === actorKey(actor))) return;
    recipients.push({ actor, reason });
  };
  add(fixture.card.author, "author");
  const publisher = fixture.versions[0]?.publisher;
  if (publisher) add(publisher, "publisher");
  const root = options.replyTo ? threadRoot(list, options.replyTo) : undefined;
  if (options.replyTo && !root) throw { status: 404, code: "COMMENT_NOT_FOUND" } satisfies ArtifactApiError;
  const inThread = (c: ArtifactComment) => (root ? threadRoot(list, c.id)?.id === root.id : sameTarget(c.target, options.path));
  for (const comment of list) if (inThread(comment)) add(comment.author, "commented");
  for (const actor of fixture.subscribers ?? []) add(actor, "subscribed");
  return { recipients };
}

const HOME_ORDER: Array<ArtifactHome["kind"]> = ["conversation", "server", "public"];

// ---- Save and share (S5) ----

/**
 * What the fake knows about an attachment, which the server reads from the
 * message: the file and the conversation it was posted in (the new
 * Artifact's home, D1). The web app tells the fake before it saves
 * (rememberFakeAttachment); the real source sends only the id.
 */
export interface FakeAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  messageId: string;
  conversation: { id: string; name: string; type: "channel" | "private" | "dm" };
}

const fakeAttachments = new Map<string, FakeAttachment>();
/** Attachment id → the Artifact it was saved as (the server's link from the attachment). */
const savedAttachments = new Map<string, ArtifactId>();
/** Saved before as an Artifact the viewer can't see now (a guest, a server home): 409 ALREADY_SAVED. */
export const FAKE_ALREADY_SAVED_HIDDEN_ATTACHMENT_ID = "fake-attachment-saved-hidden";
/** Gone, or not visible to this person: 404 ATTACHMENT_NOT_FOUND. */
export const FAKE_MISSING_ATTACHMENT_ID = "fake-attachment-gone";
/** A conversation the viewer can no longer post in: 404 TARGET_NOT_FOUND. */
export const FAKE_GONE_CONVERSATION_ID = "fake-channel-archived";
let nextSavedNumber = 1;
let nextSharedNumber = 1;
/** What each share attempt (Artifact and clientKey) answered. */
const sharedByKey = new Map<string, ArtifactWebShared>();

/**
 * The server's `artifact:attachment-saved { channelId, messageId, attachmentId }`
 * (Remy, S5): broadcast to the channel after a save, with no Artifact id or
 * title; each client refetches the message and gets `savedAsArtifact` for
 * itself. The fake emits it to these listeners instead of a socket.
 */
export interface FakeAttachmentSavedEvent {
  channelId: string;
  messageId: string;
  attachmentId: string;
}
const savedListeners = new Set<(event: FakeAttachmentSavedEvent) => void>();

export function onFakeAttachmentSaved(listener: (event: FakeAttachmentSavedEvent) => void): () => void {
  savedListeners.add(listener);
  return () => { savedListeners.delete(listener); };
}

/** `savedAsArtifact` as the fake server computes it for this viewer, for a refetched message. */
export function fakeSavedAsFor(attachmentId: string): ArtifactReference | null {
  if (attachmentId === FAKE_ALREADY_SAVED_HIDDEN_ATTACHMENT_ID) return { status: "unavailable", url: artifactUrl(FAKE_UNAVAILABLE_ARTIFACT_ID) };
  const id = savedAttachments.get(attachmentId);
  return id ? resolve({ id, version: null }) : null;
}

export function rememberFakeAttachment(attachment: FakeAttachment): void {
  fakeAttachments.set(attachment.id, attachment);
}

/** The fake's limit for an attachment, as for publishing: 16 MiB text, 15 MiB binary. */
function saveLimitOf(filename: string): number {
  return artifactFileType(filename).text ? ARTIFACT_SAVE_MAX_TEXT_BYTES : ARTIFACT_SAVE_MAX_BINARY_BYTES;
}

/** The fake has no copy of an attachment's bytes: a saved text file shows this. */
const SAVED_TEXT_STAND_IN = "(Fake data: the attachment's text would be here.)\n";

/** A new Artifact from an attachment: named after the file, at home in its conversation, the bytes shared. */
function savedFixture(attachment: FakeAttachment): Fixture {
  const id = asArtifactId(`pt_fake-saved-${nextSavedNumber++}`);
  const type = artifactFileType(attachment.filename);
  const createdAt = new Date(currentTimeMs()).toISOString();
  return {
    card: {
      id,
      title: artifactTitleFromFileName(attachment.filename),
      description: null,
      kind: type.kind,
      facts: { sizeBytes: attachment.sizeBytes, fileCount: 1 },
      preview: { kind: "none" },
      latestVersion: 1,
      author: ME,
      createdAt,
      updatedAt: createdAt,
      commentCount: 0,
      home: channelHome(attachment.conversation.id, attachment.conversation.name, attachment.conversation.type),
    },
    texts: type.kind === "text" || type.kind === "csv" ? { [attachment.filename]: SAVED_TEXT_STAND_IN } : undefined,
    files: [{ path: attachment.filename, kind: type.kind, sizeBytes: attachment.sizeBytes, entry: true }],
    versions: [{ number: 1, publisher: ME, createdAt, note: null, changedPaths: [attachment.filename] }],
    capabilities: { publish: true, comment: true, changeHome: true, unpublish: false, narrowHome: false, delete: true },
    following: true,
    savedFrom: { attachmentId: attachment.id, messageId: attachment.messageId, conversationId: attachment.conversation.id },
    origin: { messageId: asMessageId(attachment.messageId), conversationId: asChannelId(attachment.conversation.id), via: "attachment" },
  };
}

/**
 * Who in a conversation couldn't see an Artifact, as the fake counts them:
 * nobody where it lives, or where it's public; guests where it's at home in
 * the server (D4); otherwise a fixed table per conversation, so each
 * scenario shows up somewhere. Tests set their own (setFakeShareAudienceForTests).
 */
const FAKE_CONVERSATION_AUDIENCE: Record<string, { members: number; guests: number }> = {
  "fake-channel-general": { members: 18, guests: 2 },
  "fake-channel-release": { members: 4, guests: 0 },
};
const audienceOverrides = new Map<string, ArtifactWebShareAudience>();

export function setFakeShareAudienceForTests(conversationId: string, audience: ArtifactWebShareAudience | null): void {
  if (audience) audienceOverrides.set(conversationId, audience);
  else audienceOverrides.delete(conversationId);
}

function audienceFor(fixture: Fixture, conversationId: string): ArtifactWebShareAudience {
  const override = audienceOverrides.get(conversationId);
  if (override) return override;
  const home = homeOf(fixture);
  const known = FAKE_CONVERSATION_AUDIENCE[conversationId];
  // Any other conversation: a few people, no guests.
  const { members, guests } = known ?? { members: 6, guests: 0 };
  const everyone: ArtifactWebShareAudience = { members, cannotSee: 0, guestsCannotSee: 0, widenTo: [], widenRefused: [] };
  if (home.kind === "public") return everyone;
  if (home.kind === "conversation" && home.conversation.id === conversationId) return everyone;
  // A server home reaches everyone but guests (D4): only public reaches them.
  const cannotSee = home.kind === "server" ? guests : Math.max(1, Math.ceil((members - guests) / 3) + guests);
  if (cannotSee === 0) return everyone;
  // As the server offers them (webShare.ts, manage.ts widerHomesFor): the larger homes this viewer may
  // move it to, narrowest first, each only when it reaches some the narrower one offered doesn't: the
  // server reaches everyone but guests, public the guests too.
  // A viewer who may not move it is refused each such home, `forbidden` (#77, webShare.ts widenRefused).
  // A name taken in a larger home is the tests' own answer (setFakeShareAudienceForTests).
  const helps: ArtifactWebShareAudience["widenTo"] = [];
  if (home.kind === "conversation" && cannotSee > guests) helps.push("server");
  if (guests > 0) helps.push("public");
  const may = manages(fixture);
  return {
    members,
    cannotSee,
    guestsCannotSee: guests,
    widenTo: may ? helps : [],
    widenRefused: may ? [] : helps.map((to) => ({ to, reason: "forbidden" as const })),
  };
}

// ---- Moving to a smaller home (the home route's narrowing and its preview) ----

/** The fake server's people (guests among them) and agents. */
const FAKE_SERVER = { people: 24, guests: 2, agents: 6 };
let fakeServerPeople = FAKE_SERVER.people;

/** Tests: more (or fewer) people in the fake server, so a confirmed count no longer holds (LOSS_CHANGED). */
export function setFakeServerPeopleForTests(people: number | null): void {
  fakeServerPeople = people ?? FAKE_SERVER.people;
}

/** A thread's own id, named as a home: 400 TARGET_NOT_SUPPORTED `thread`. */
export const FAKE_THREAD_CONVERSATION_ID = "fake-thread-standup";
/** A joint channel: 400 TARGET_NOT_SUPPORTED `joint`. */
export const FAKE_JOINT_CONVERSATION_ID = "fake-channel-joint";

/**
 * The conversations a fake Artifact can move into: who is in each (people
 * and agents, and which fixture authors), guests, and what can't be a home.
 * Any other id is one the viewer can't see: 404 TARGET_NOT_FOUND.
 */
const FAKE_CONVERSATIONS: Record<string, {
  name: string;
  type: "channel" | "private" | "dm";
  people: number;
  agents: number;
  members: string[];
  guests?: "guest_members" | "open_to_guests";
  unsupported?: "thread" | "joint";
}> = {
  "fake-channel-daemon-size": { name: "proj-daemon-size", type: "channel", people: 9, agents: 3, members: [niko.id, remy.id, xxchan.id, cindy.id, artin.id] },
  "fake-channel-general": { name: "general", type: "channel", people: 18, agents: 0, members: [xxchan.id, cindy.id, artin.id], guests: "guest_members" },
  "fake-channel-release": { name: "release-war-room", type: "private", people: 4, agents: 0, members: [xxchan.id, cindy.id, artin.id] },
  "fake-channel-growth": { name: "growth", type: "private", people: 5, agents: 1, members: [xxchan.id, cindy.id, pico.id] },
  "fake-dm-cindyz": { name: "cindyz", type: "dm", people: 2, agents: 0, members: [xxchan.id, cindy.id] },
  "fake-dm-artin": { name: "artin", type: "dm", people: 2, agents: 0, members: [xxchan.id, artin.id] },
  [FAKE_THREAD_CONVERSATION_ID]: { name: "standup", type: "channel", people: 9, agents: 3, members: [], unsupported: "thread" },
  [FAKE_JOINT_CONVERSATION_ID]: { name: "partners", type: "channel", people: 30, agents: 2, members: [], unsupported: "joint" },
};

/** Who of the fake server sees an Artifact in `home`: people and agents (a public channel: every full member). */
function seers(home: ArtifactHome): { people: number; agents: number } {
  const members = { people: fakeServerPeople - FAKE_SERVER.guests, agents: FAKE_SERVER.agents };
  if (home.kind === "public") return { people: fakeServerPeople, agents: FAKE_SERVER.agents };
  if (home.kind === "server") return members;
  const conversation = FAKE_CONVERSATIONS[home.conversation.id ?? ""];
  if (!conversation || conversation.type === "channel") return members;
  return { people: conversation.people, agents: conversation.agents };
}

/**
 * The home route's narrowing checks (manage.ts narrowingTarget), in its
 * order, and what the move would take away: the refusal is thrown.
 */
function narrowing(fixture: Fixture, to: ArtifactHomeChangeTarget): { home: ArtifactHome; impact: ArtifactWebHomeChange } {
  const current = homeOf(fixture);
  if (!manages(fixture)) throw { status: 403, code: "FORBIDDEN" } satisfies ArtifactApiError;
  if (HOME_ORDER.indexOf(to.to) >= HOME_ORDER.indexOf(current.kind)) throw apiError(409, "HOME_NOT_NARROWER", { home: current.kind, to: to.to });
  let home: ArtifactHome = { kind: "server" };
  if (to.to === "conversation") {
    const { conversationId } = to;
    // Only back to the original conversation (#75); its own checks follow (gone: TARGET_NOT_FOUND).
    if (conversationId !== originalHomeOf(fixture)) {
      const shown = shownOriginalHome(fixture);
      throw apiError(409, "NOT_ORIGINAL_HOME", { originalConversationId: shown === null ? null : asChannelId(shown) });
    }
    const conversation = FAKE_CONVERSATIONS[conversationId];
    if (!conversation) throw apiError(404, "TARGET_NOT_FOUND", { conversationId });
    if (conversation.unsupported) throw apiError(400, "TARGET_NOT_SUPPORTED", { conversationId, reason: conversation.unsupported });
    if (conversation.guests) throw apiError(403, "TARGET_HAS_GUESTS", { conversationId, reason: conversation.guests });
    // Its author keeps it: sees it there (a public channel, or a member), and an agent author is in it.
    const author = fixture.card.author;
    const inIt = conversation.members.includes(author.id);
    if (!inIt && conversation.type !== "channel") throw apiError(409, "AUTHOR_LOSES_ACCESS", { reason: "cannot_see" });
    if (!inIt && author.type === "agent") throw apiError(409, "AUTHOR_LOSES_ACCESS", { reason: "agent_not_member" });
    home = channelHome(conversationId, conversation.name, conversation.type);
  }
  const now = seers(current);
  const after = seers(home);
  return {
    home,
    impact: {
      peopleLosingAccess: Math.max(0, now.people - after.people),
      agentsLosingAccess: Math.max(0, now.agents - after.agents),
      leavesPublic: current.kind === "public",
    },
  };
}

/**
 * The move to a larger home (manage.ts widenArtifactHome): who may (else
 * FORBIDDEN), then `to` if it is larger; a home already that wide stays as
 * it is (`moved` false, the home it has: never a conversation). Never
 * narrows. The home route refuses `moved` false; a share's `widenTo` goes on.
 */
function widen(fixture: Fixture, to: "server" | "public"): { moved: boolean; home: ArtifactHome } {
  if (!manages(fixture)) throw { status: 403, code: "FORBIDDEN" } satisfies ArtifactApiError;
  const current = homeOf(fixture);
  if (HOME_ORDER.indexOf(to) <= HOME_ORDER.indexOf(current.kind)) return { moved: false, home: { kind: current.kind === "public" ? "public" : "server" } };
  overrides.set(fixture.card.id, { ...overrides.get(fixture.card.id), home: { kind: to } });
  return { moved: true, home: { kind: to } };
}

export const fakeArtifactSource: ArtifactSource = {
  kind: "stand-in",
  // Stands in for core's object summaries (the API source has none of its own).
  async getMessageArtifactRefs(inText) {
    return inText.map(resolve);
  },
  viewer(target) {
    return viewerResultOf(async () => {
      const data = viewerData(target);
      // Opening the current version moves the reader's read position (what the list says is new clears).
      if (data.card.version === data.card.latestVersion) readPositions.set(data.card.id, new Date(currentTimeMs()).toISOString());
      return data;
    });
  },
  async versionSummary({ id, version }) {
    // No read position moves (the details route's).
    return viewerData({ id, version }).versions.find((summary) => summary.number === version) ?? null;
  },
  async readText(file) {
    const text = fileOf(file).texts?.[file.path];
    if (text === undefined) throw { status: 404, code: "FILE_NOT_FOUND" } satisfies ArtifactApiError;
    return text;
  },
  async readBytes(file) {
    const fixture = fileOf(file);
    const bytes = fixture.bytes?.[file.path];
    if (bytes) return new Blob([decodeBase64(bytes.base64)], { type: bytes.type });
    const text = fixture.texts?.[file.path];
    if (text !== undefined) return new Blob([text], { type: "text/plain" });
    throw { status: 404, code: "FILE_NOT_FOUND" } satisfies ArtifactApiError;
  },
  async readZip() {
    // No archive is built from fixtures: the menu says it couldn't download, as for a refusal it doesn't name.
    throw { status: 503, code: "CONTENT_UNAVAILABLE" } satisfies ArtifactApiError;
  },
  async frame(id, input) {
    // The route's order: visibility, the version, the kind.
    const fixture = fixtureOf(id);
    const version = input.version ?? fixture.card.latestVersion;
    if (version < 1 || version > fixture.card.latestVersion) {
      throw apiError(404, "VERSION_NOT_FOUND", { version, currentVersion: fixture.card.latestVersion });
    }
    if (!isArtifactFramedKind(fixture.card.kind)) throw { status: 409, code: "NOT_FRAMED" } satisfies ArtifactApiError;
    return fakeFrameLocation(fixture.card.id, version);
  },
  async setFollowing(id, following) {
    fixtureOf(id);
    overrides.set(id, { ...overrides.get(id), following });
    return { following };
  },
  async changeHome(id, input) {
    const fixture = fixtureOf(id);
    const current = homeOf(fixture);
    const expectedLost = input.to === "public" ? undefined : input.expectedLost;
    // The route's body check: `expectedLost` only on a narrowing, a non-negative integer.
    const badCount = input.to === "public" ? "expectedLost" in input : expectedLost !== undefined && !(Number.isSafeInteger(expectedLost) && expectedLost >= 0);
    if (badCount) {
      throw { status: 400, code: "INVALID_REQUEST" } satisfies ArtifactApiError;
    }
    // The home route's split (Remy, #45): only a confirmed count (`expectedLost`, from the preview)
    // narrows; without one it only widens, and a smaller `to` is HOME_NOT_WIDER, so a stale choice
    // never narrows unconfirmed.
    if (expectedLost !== undefined) {
      const to: ArtifactHomeChangeTarget = input.to === "conversation" ? { to: "conversation", conversationId: input.conversationId } : { to: "server" };
      const { home, impact } = narrowing(fixture, to);
      const actual = impact.peopleLosingAccess + impact.agentsLosingAccess;
      if (expectedLost !== undefined && expectedLost !== actual) {
        throw apiError(409, "LOSS_CHANGED", { expected: expectedLost, actual, capped: impact.capped === true });
      }
      overrides.set(id, { ...overrides.get(id), home });
      return viewerData({ id, version: null });
    }
    if (input.to === "conversation") {
      throw { status: 409, code: "HOME_NOT_WIDER", details: { home: current.kind, to: "conversation" } } satisfies ArtifactApiError;
    }
    if (!widen(fixture, input.to).moved) throw apiError(409, "HOME_NOT_WIDER", { home: current.kind, to: input.to });
    return viewerData({ id, version: null });
  },
  async homeChange(id, to) {
    return narrowing(fixtureOf(id), to).impact;
  },
  async unpublish(id) {
    // The same people as widening (the fake's changeHome), and only from public.
    const fixture = fixtureOf(id);
    if (!manages(fixture)) throw { status: 403, code: "FORBIDDEN" } satisfies ArtifactApiError;
    const current = homeOf(fixture);
    if (current.kind !== "public") throw { status: 409, code: "NOT_PUBLIC" } satisfies ArtifactApiError;
    overrides.set(id, { ...overrides.get(id), home: { kind: "server" } });
    return viewerData({ id, version: null });
  },
  async setTitle(id, title) {
    // The title route (rename.ts): whoever may publish, the title trimmed and not blank.
    const fixture = fixtureOf(id);
    if (!fixture.capabilities.publish) throw { status: 403, code: "FORBIDDEN" } satisfies ArtifactApiError;
    const trimmed = title.trim();
    if (trimmed === "") throw { status: 400, code: "INVALID_REQUEST" } satisfies ArtifactApiError;
    overrides.set(id, { ...overrides.get(id), title: trimmed });
    return viewerData({ id, version: null });
  },
  async deleteArtifact(id) {
    const fixture = fixtureOf(id);
    if (!fixture.capabilities.delete) throw { status: 403, code: "FORBIDDEN" } satisfies ArtifactApiError;
    overrides.set(id, { ...overrides.get(id), deleted: true });
  },
  async getComments(id, options = {}) {
    // The newest page first; each page oldest first; `olderCursor` is where the page before ends.
    const sorted = commentsOf(id)
      .filter((c) => options.path === undefined || (c.target.scope === "file" && c.target.path === options.path))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const reviewed = options.review === undefined ? null : reviewPage(id, options.review, sorted);
    const all = reviewed ? reviewed.comments : sorted;
    const end = options.before ? Number(options.before) : all.length;
    const start = Math.max(0, end - fakeCommentsPageSize);
    return { comments: all.slice(start, end), olderCursor: start > 0 ? String(start) : null, ...(reviewed ? { review: reviewed.review } : {}) };
  },
  async postComment(id, input) {
    const body = checkedComment(id, input);
    const list = commentsOf(id);
    const notified = willNotifyFor(id, { replyTo: input.replyTo ?? undefined, path: input.target.scope === "file" ? input.target.path : undefined }).recipients;
    for (const part of body) {
      if (part.type === "mention" && actorKey(part.actor) !== actorKey(ME) && !notified.some((r) => actorKey(r.actor) === actorKey(part.actor))) {
        notified.push({ actor: part.actor, reason: "mentioned" });
      }
    }
    const comment: ArtifactComment = {
      id: asArtifactCommentId(`fake-c-new-${nextCommentNumber++}`),
      author: ME,
      body,
      createdAt: new Date(currentTimeMs()).toISOString(),
      editedAt: null,
      deletedAt: null,
      version: input.version,
      target: input.target,
      replyTo: input.replyTo,
      ...claimFakeCommentImages(id, input.images),
      resolvedAt: null,
      resolvedBy: null,
    };
    reopenFakeThreadOf(list, comment.replyTo);
    list.push(comment);
    return { comment, notified };
  },
  async editComment(id, commentId, body) {
    const list = commentsOf(id);
    const index = list.findIndex((c) => c.id === commentId);
    if (index < 0 || list[index]!.deletedAt) throw { status: 404, code: "COMMENT_NOT_FOUND" } satisfies ArtifactApiError;
    if (actorKey(list[index]!.author) !== actorKey(ME)) throw { status: 403, code: "FORBIDDEN" } satisfies ArtifactApiError;
    // Mentions are checked again (MENTION_NOT_VISIBLE on edit too); only the ones this edit adds
    // are notified, as with message edits (contract #10877).
    const stored = storedBody(body);
    const before = new Set(list[index]!.body.flatMap((p) => (p.type === "mention" ? [actorKey(p.actor)] : [])));
    const notified: ArtifactWillNotify["recipients"] = [];
    for (const part of stored) {
      const key = part.type === "mention" ? actorKey(part.actor) : null;
      if (part.type === "mention" && key && !before.has(key) && key !== actorKey(ME) && !notified.some((r) => actorKey(r.actor) === key)) {
        notified.push({ actor: part.actor, reason: "mentioned" });
      }
    }
    const edited: ArtifactComment = { ...list[index]!, body: stored, editedAt: new Date(currentTimeMs()).toISOString() };
    list[index] = edited;
    return { comment: edited, notified };
  },
  ...fakeCommentImageRoutes,
  async deleteComment(id, commentId) {
    const list = commentsOf(id);
    const index = list.findIndex((c) => c.id === commentId);
    if (index < 0 || list[index]!.deletedAt) throw { status: 404, code: "COMMENT_NOT_FOUND" } satisfies ArtifactApiError;
    if (actorKey(list[index]!.author) !== actorKey(ME)) throw { status: 403, code: "FORBIDDEN" } satisfies ArtifactApiError;
    // With replies it stays as a placeholder so they keep their place; without, it's gone.
    if (list.some((c) => c.replyTo === commentId)) {
      list[index] = { ...withoutFakeImages(list[index]!), body: [], deletedAt: new Date(currentTimeMs()).toISOString() };
    } else {
      releaseFakeCommentImages(list.splice(index, 1));
    }
  },
  async resolveComment(id, commentId) {
    return changeFakeResolution(commentsOf(id), commentId, capabilitiesAt(fixtureOf(id), homeOf(fixtureOf(id))), true);
  },
  async reopenComment(id, commentId) {
    return changeFakeResolution(commentsOf(id), commentId, capabilitiesAt(fixtureOf(id), homeOf(fixtureOf(id))), false);
  },
  async reviewDrafts(id) {
    fixtureOf(id);
    return { drafts: [...draftsOf(id)] };
  },
  async createReviewDraft(id, input) {
    const replyTo = input.replyTo ?? null;
    // A reply takes its thread's place: none of its own.
    if (replyTo && input.target.scope !== "artifact") throw { status: 400, code: "INVALID_REQUEST" } satisfies ArtifactApiError;
    if (replyTo) liveParent(id, replyTo);
    const body = checkedComment(id, { ...input, replyTo });
    const list = draftsOf(id);
    if (list.length >= ARTIFACT_DRAFT_MAX_PER_ARTIFACT) throw apiError(409, "DRAFT_LIMIT", { limit: ARTIFACT_DRAFT_MAX_PER_ARTIFACT });
    const now = currentTimeMs();
    const draft: ArtifactCommentDraft = { id: draftUuid(), version: input.version, target: input.target, body, replyTo, ...claimFakeCommentImages(id, input.images), createdAt: new Date(now).toISOString(), ...stamped(now) };
    drafts.set(id, [...list, draft]);
    return { draft };
  },
  async editReviewDraft(id, draftId, body) {
    const list = draftsOf(id);
    const current = list.find((d) => d.id === draftId);
    if (!current) throw draftNotFound();
    const next: ArtifactCommentDraft = { ...current, body: checkedComment(id, { ...draftInput(current), body }), ...stamped(currentTimeMs()) };
    drafts.set(id, list.map((d) => (d.id === draftId ? next : d)));
    return { draft: next };
  },
  async deleteReviewDraft(id, draftId) {
    const list = draftsOf(id);
    if (!list.some((d) => d.id === draftId)) throw draftNotFound();
    drafts.set(id, list.filter((d) => d.id !== draftId));
  },
  async discardReviewDrafts(id) {
    fixtureOf(id);
    drafts.delete(id);
  },
  async submitReview(id, { version, summary, clientKey }) {
    fixtureOf(id);
    const summaryBody = summary?.some((part) => part.type === "mention" || part.text.trim() !== "") ? summary : null;
    const digest = JSON.stringify({ version, summary: summaryBody });
    const earlier = clientKey ? reviewsByKey.get(`${id}:${clientKey}`) : undefined;
    if (earlier) {
      if (earlier.digest !== digest) throw { status: 409, code: "CLIENT_KEY_REUSED" } satisfies ArtifactApiError;
      return { status: "ok", comments: earlier.comments };
    }
    const list = draftsOf(id);
    if (list.length === 0) throw { status: 409, code: "NO_DRAFTS" } satisfies ArtifactApiError;
    // Every draft checked again as a comment now, then the summary; the first refused refuses all.
    const inputs: Array<{ draftId: ArtifactCommentDraftId | null; input: ArtifactWebCommentInput }> = [
      ...list.map((draft) => ({ draftId: draft.id, input: draftInput(draft) })),
      ...(summaryBody ? [{ draftId: null, input: { body: summaryBody, version, target: { scope: "artifact" as const }, replyTo: null } }] : []),
    ];
    const bodies: ArtifactCommentPart[][] = [];
    for (const { draftId, input } of inputs) {
      try {
        if (input.replyTo) liveParent(id, input.replyTo);
        bodies.push(checkedComment(id, input));
      } catch (error) {
        const refusal = error as ArtifactApiError;
        if (!REJECTED_CODES.has(refusal.code)) throw error;
        // checkedComment refuses with apiError, which gives each code its contract details: ArtifactReviewRejected's.
        return { status: "rejected", draftId, code: refusal.code, error: refusal.code, ...(refusal.details ? { details: { ...refusal.details } } : {}) } as ArtifactReviewRejected;
      }
    }
    const reviewId = asArtifactReviewId(`fake-review-${nextReviewNumber++}`);
    const at = new Date(currentTimeMs()).toISOString();
    const posted = inputs.map(({ input }, index): ArtifactComment => ({
      id: asArtifactCommentId(`fake-c-new-${nextCommentNumber++}`),
      author: ME,
      body: bodies[index]!,
      createdAt: at,
      editedAt: null,
      deletedAt: null,
      version: input.version,
      // A reply draft is posted as a reply, where its thread is.
      target: input.replyTo ? liveParent(id, input.replyTo).target : input.target,
      replyTo: input.replyTo,
      reviewId,
      ...(list[index]?.images ? { images: list[index]!.images } : {}),
      resolvedAt: null,
      resolvedBy: null,
    }));
    for (const comment of posted) reopenFakeThreadOf(commentsOf(id), comment.replyTo);
    commentsOf(id).push(...posted);
    reviews.set(reviewId, { artifact: id, summary: summaryBody ? posted.at(-1)!.id : null, createdAt: at });
    drafts.delete(id);
    if (clientKey) reviewsByKey.set(`${id}:${clientKey}`, { digest, comments: posted });
    return { status: "ok", comments: posted };
  },
  async mentionCandidates(id, q) {
    fixtureOf(id);
    const query = q.trim().toLowerCase();
    const matches = (a: ArtifactActor) => a.name.toLowerCase().includes(query) || a.displayName.toLowerCase().includes(query);
    return { candidates: query ? MENTIONABLE.filter(matches) : MENTION_CANDIDATES };
  },
  async willNotify(id, options) {
    return willNotifyFor(id, options);
  },
  async presence(id) {
    return fixtureOf(id).presence ?? { viewing: [], readCurrentVersion: [], readOtherVersion: [] };
  },
  async saveAttachment({ attachmentId }) {
    if (attachmentId === FAKE_ALREADY_SAVED_HIDDEN_ATTACHMENT_ID) throw apiError(409, "ALREADY_SAVED", { attachmentId });
    const attachment = fakeAttachments.get(attachmentId);
    if (!attachment || attachmentId === FAKE_MISSING_ATTACHMENT_ID) throw apiError(404, "ATTACHMENT_NOT_FOUND", { attachmentId });
    if (attachmentId.startsWith("optimistic-att-")) throw apiError(422, "ATTACHMENT_NOT_SAVABLE", { attachmentId, reason: "uploading" });
    const limit = saveLimitOf(attachment.filename);
    if (attachment.sizeBytes > limit) throw apiError(422, "ATTACHMENT_NOT_SAVABLE", { attachmentId, reason: "too_large", limit });
    const existing = savedAttachments.get(attachmentId);
    if (existing && FIXTURES[existing] && !overrides.get(existing)?.deleted) {
      return { artifact: viewerData({ id: existing, version: null }), created: false };
    }
    const fixture = savedFixture(attachment);
    FIXTURES[fixture.card.id] = fixture;
    savedAttachments.set(attachmentId, fixture.card.id);
    const event = { channelId: attachment.conversation.id, messageId: attachment.messageId, attachmentId };
    // After the answer, as the server's broadcast would arrive.
    setTimeout(() => { for (const listener of savedListeners) listener(event); }, 0);
    return { artifact: viewerData({ id: fixture.card.id, version: null }), created: true };
  },
  async attachmentSaves(attachmentIds) {
    // What this session saved, as the server lists it (the fake keeps no other saves).
    const saves = attachmentIds.flatMap((attachmentId) => {
      const savedAs = savedAttachments.has(attachmentId) ? fakeSavedAsFor(attachmentId) : null;
      return savedAs ? [{ attachmentId, savedAs }] : [];
    });
    return { saves };
  },
  async shareAudience(id, { conversationId }) {
    const fixture = fixtureOf(id);
    if (conversationId === FAKE_GONE_CONVERSATION_ID) throw apiError(404, "TARGET_NOT_FOUND", { conversationId });
    return audienceFor(fixture, conversationId);
  },
  async share(id, input) {
    fixtureOf(id);
    // Idempotent per clientKey, as the server: the same attempt answers the message it posted.
    // A retry never moves it again: `home` null (the home the dialog shows stays).
    const earlier = sharedByKey.get(`${id}:${input.clientKey}`);
    if (earlier) return { ...earlier, home: null };
    if (input.conversationId === FAKE_GONE_CONVERSATION_ID) {
      throw apiError(404, "TARGET_NOT_FOUND", { conversationId: input.conversationId, ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}) });
    }
    if (input.note !== null && input.note.length > ARTIFACT_SHARE_NOTE_MAX_CHARS) {
      throw apiError(400, "FIELD_TOO_LONG", { field: "note", limit: ARTIFACT_SHARE_NOTE_MAX_CHARS });
    }
    let home: ArtifactHome | null = null;
    if (input.widenTo) {
      // Moves the home first, by the home route's rules (refused as it refuses, nothing sent), then sends;
      // already that wide is no refusal (the home it has, never a conversation).
      home = widen(fixtureOf(id), input.widenTo).home;
    }
    const shared = { messageId: asMessageId(`fake-shared-message-${nextSharedNumber++}`), home };
    sharedByKey.set(`${id}:${input.clientKey}`, shared);
    return shared;
  },
  async dashboardAll(options = {}) {
    // As the server answers: every Artifact the reader sees (the fake's reader sees them all), the home, author and
    // conversation filters, `q` and `relevant` (fakeDashboardAllListed), in the order the options ask (fakeDashboardAllPage:
    // newest update first by default; its cursor an offset of that order), ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT a page
    // (fakeDashboardAllPageSize in tests). Each row says `openedAt` and `news`, a first page `counts` and a later one null.
    const { listed, withNews } = fakeDashboardAllListed(dashboardEntries(dashboardFilter(options)), options, allRow, involved);
    const page = fakeDashboardAllPage(listed, options, fakeDashboardAllPageSize);
    const counts = options.cursor === undefined
      ? { total: dashboardEntries({ home: undefined, authors: null, conversation: undefined }).length, filtered: listed.length, relevant: withNews }
      : null;
    return { ...page, counts };
  },
  async dashboardAuthors(options = {}) {
    const authors = dashboardEntries({ home: undefined, authors: null, conversation: undefined }).map(({ fixture }) => fixture.card.author);
    return { authors: fakeAuthorCandidates(authors, options.q ?? "") };
  },
  async dashboardConversations(options = {}) {
    // As the server answers: the conversations of what the reader sees, most recently updated first, `q` on the names, a leading # dropped.
    const q = (options.q ?? "").trim().replace(/^#/, "").toLowerCase();
    const byId = new Map<string, ArtifactDashboardConversation>();
    for (const { card } of dashboardEntries({ home: undefined, authors: null, conversation: undefined })) {
      if (card.home.kind !== "conversation" || card.home.conversation.id === null) continue;
      const { id } = card.home.conversation;
      const seen = byId.get(id);
      byId.set(id, {
        ...card.home.conversation,
        id,
        count: (seen?.count ?? 0) + 1,
        updatedAt: seen && seen.updatedAt > card.updatedAt ? seen.updatedAt : card.updatedAt,
      });
    }
    const named = (text: string | undefined) => text?.toLowerCase().includes(q) === true;
    return {
      conversations: [...byId.values()]
        .filter((conversation) => named(conversation.name) || named(conversation.peerDisplayName))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
        .slice(0, ARTIFACT_DASHBOARD_CONVERSATIONS_LIMIT),
    };
  },
  async conversationArtifacts(conversationId, options = {}) {
    // As the server answers: 20 a page (fakeConversationPageSize in tests), newest update first; the cursor an offset here.
    const offset = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isInteger(offset) || offset < 0) throw { status: 400, code: "INVALID_REQUEST" } satisfies ArtifactApiError;
    const cards = Object.keys(FIXTURES)
      .filter((id) => !overrides.get(id)?.deleted)
      .map((id) => cardFor(FIXTURES[id]!, null))
      .filter((card) => card.home.kind === "conversation" && card.home.conversation.id === conversationId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const end = offset + fakeConversationPageSize;
    return { rows: cards.slice(offset, end).map((card) => ({ card })), nextCursor: end < cards.length ? String(end) : null };
  },
  async open(target) {
    // The fake's Artifacts are every server's: each opens in the current server, else the first of the reader's.
    const { current, servers } = useServerStore.getState();
    const server = current ?? servers[0];
    const result = await fakeArtifactSource.viewer(target);
    if (result.status !== "ok") throw notVisible();
    return { opensIn: server ? { serverId: asServerId(server.id), slug: server.slug, name: server.name } : null, viewer: result.data };
  },
  async locate(id, askFrom) {
    // The fake's Artifacts are every server's: each is seen from the server asked from.
    fixtureOf(id);
    return { serverSlug: askFrom.slug };
  },
};

/**
 * The fake reader's read positions (what the list says is new): when they last
 * opened each Artifact's current version; absent, never. The viewer moves it.
 */
let readPositions = initialReadPositions();

function initialReadPositions(): Map<string, string> {
  return new Map([
    ["pt_fake-bundle-report", ago(30)],
    ["pt_fake-signups", ago(30)],
    ["pt_fake-runbook", ago(60)],
    ["pt_fake-wireframe", ago(26 * 60)],
  ]);
}

/** A conversation's Artifacts per page (the server's 20); tests make it smaller to page. */
let fakeConversationPageSize = 20;
export function setFakeConversationArtifactsPageSizeForTests(size: number | null): void {
  fakeConversationPageSize = size ?? 20;
}

/** Rows per page of the home page's list (the contract's 50; tests make it smaller to page). */
let fakeDashboardAllPageSize = ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT;
export function setFakeDashboardAllPageSizeForTests(size: number | null): void {
  fakeDashboardAllPageSize = size ?? ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT;
}

function homeKindOf(home: ArtifactHome): ArtifactDashboardHome {
  if (home.kind !== "conversation") return home.kind;
  return home.conversation.type === "dm" ? "dm" : "channel";
}

interface DashboardEntry {
  id: string;
  fixture: Fixture;
  card: ArtifactCard;
  readAt: string | null;
  /** Comments by others after the read position, not deleted. */
  unreadComments: ArtifactComment[];
}

const isMine = (actor: ArtifactActor) => actorKey(actor) === actorKey(ME);

/** The dashboard's filters: the kind of home, the authors kept (actorKey; null: everyone), and the conversation. */
interface DashboardFilter {
  home: ArtifactDashboardHome | undefined;
  authors: ReadonlySet<string> | null;
  conversation: string | undefined;
}

function dashboardFilter(options: { home?: ArtifactDashboardHome; author?: readonly ArtifactDashboardAuthor[]; conversation?: string }): DashboardFilter {
  return { home: options.home, authors: fakeAuthorKeys(options.author ?? []), conversation: options.conversation };
}

/** The Artifacts the reader can see with that kind of home and by those authors, and what is unread on each. */
function dashboardEntries({ home, authors, conversation }: DashboardFilter): DashboardEntry[] {
  return Object.keys(FIXTURES).flatMap((id) => {
    if (overrides.get(id)?.deleted) return [];
    const fixture = FIXTURES[id]!;
    const card = cardFor(fixture, null);
    if (home && homeKindOf(card.home) !== home) return [];
    if (authors && !authors.has(actorKey(fixture.card.author))) return [];
    if (conversation !== undefined && !(card.home.kind === "conversation" && card.home.conversation.id === conversation)) return [];
    const readAt = readPositions.get(id) ?? null;
    const unreadComments = commentsOf(card.id).filter((c) => !c.deletedAt && !isMine(c.author) && (readAt === null || c.createdAt > readAt));
    return [{ id, fixture, card, readAt, unreadComments }];
  });
}

/** The entry as a row of the list: what the sections' rules say is new on it (ArtifactDashboardAllNews). */
function allRow({ id, fixture, card, readAt, unreadComments }: DashboardEntry) {
  const mentions = unreadComments.filter((comment) => comment.body.some((part) => part.type === "mention" && isMine(part.actor))).length;
  const following = overrides.get(id)?.following ?? fixture.following;
  const versions = following ? fixture.versions.filter((v) => !isMine(v.publisher) && (readAt === null || v.createdAt > readAt)).length : 0;
  return { card, openedAt: readAt, news: { mentions, versions, comments: following ? unreadComments.length : 0 } };
}

/**
 * Whether the reader is involved with it, read or not (the server's involvedSql): published a version of it (the
 * creator publishes v1), follows it, or a live comment by someone else mentions it. The fake's agents have no creator,
 * so none of them counts as the reader's.
 */
function involved({ id, fixture, card }: DashboardEntry): boolean {
  if (fixture.versions.some((version) => isMine(version.publisher))) return true;
  if (overrides.get(id)?.following ?? fixture.following) return true;
  return commentsOf(card.id).some((c) => !c.deletedAt && !isMine(c.author) && c.body.some((part) => part.type === "mention" && isMine(part.actor)));
}

/** Tests: forget the fake's writes. */
export function resetFakeArtifactSourceForTests(): void {
  overrides.clear();
  readPositions = initialReadPositions();
  fakeDashboardAllPageSize = ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT;
  fakeConversationPageSize = 20;
  comments = null;
  nextCommentNumber = 1;
  drafts.clear();
  reviewsByKey.clear();
  reviews.clear();
  hiddenMentions.clear();
  hiddenMentions.add(pico.id);
  nextReviewNumber = 1;
  nextDraftNumber = 1;
  fakeCommentsPageSize = 50;
  for (const id of savedAttachments.values()) delete FIXTURES[id];
  fakeAttachments.clear();
  savedAttachments.clear();
  audienceOverrides.clear();
  nextSavedNumber = 1;
  nextSharedNumber = 1;
  sharedByKey.clear();
  fakeServerPeople = FAKE_SERVER.people;
  resetFakeCommentImages();
}

/**
 * The fake and its stand-ins, as artifactSource.ts installs them: tests get
 * it through the fakeArtifactSourceSlot alias (vitest.config.ts), the fake
 * dev build through its dynamic import. No production module imports it.
 */
export const fakeArtifactEntry: FakeArtifactEntry = {
  source: fakeArtifactSource,
  standIns: {
    savedAsFor: fakeSavedAsFor,
    onAttachmentSaved: onFakeAttachmentSaved,
    annotationLost: fakeAnnotationLost,
    rememberAttachment: rememberFakeAttachment,
  },
};
