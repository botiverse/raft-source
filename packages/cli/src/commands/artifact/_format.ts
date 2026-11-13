// Canonical `raft artifact …` reply formatting. The text lives in
// `@botiverse/raft-shared` (`agentText/artifacts.ts`) so the SDK's
// `artifacts.*` operations render the same bytes; this file keeps the
// axSurface registrations and their examples. This is an AX contract, not an
// implementation detail.

import type {
  AgentApiArtifactCheckResponse,
  AgentApiArtifactCommentImage,
  AgentApiArtifactCommentCreated,
  AgentApiArtifactCommentsResponse,
  AgentApiArtifactDeleted,
  AgentApiArtifactListResponse,
  AgentApiArtifactMoved,
  AgentApiArtifactPublished,
  AgentApiArtifactReadResponse,
  AgentApiArtifactReviewCreated,
  AgentApiArtifactSaved,
  AgentApiArtifactSubscriptionResponse,
  AgentApiArtifactSummary,
  AgentApiArtifactThreadResolution,
} from "@botiverse/raft-shared";
import {
  asArtifactReviewId,
  formatArtifactCheck as formatCheck,
  formatArtifactCheckWaiting as formatCheckWaiting,
  formatArtifactCommented as formatCommented,
  formatArtifactCommentImageSaved as formatImageSaved,
  formatArtifactComments as formatComments,
  formatArtifactDeleted as formatDeleted,
  formatArtifactDownloaded as formatDownloaded,
  formatArtifactList as formatList,
  formatArtifactMoved as formatMoved,
  formatArtifactsAlsoMatch as formatAlsoMatch,
  formatArtifactNothingToPublish as formatNothing,
  formatArtifactPublished as formatPublished,
  formatArtifactPulled as formatPulled,
  formatArtifactRead as formatRead,
  formatArtifactReviewed as formatReviewed,
  formatArtifactSaved as formatSaved,
  formatArtifactSubscription as formatSubscription,
  formatArtifactThreadResolution as formatThreadResolution,
} from "@botiverse/raft-shared/src/agentCliSurface";

import { axSurface } from "../../core/renderer";

const remy = { type: "agent" as const, name: "Remy" };
const xxchan = { type: "user" as const, name: "xxchan" };

const summary: AgentApiArtifactSummary = {
  id: "pt_abc",
  url: "https://app.raft.build/artifacts/ScAiFjjtiUvoyEYA6Ry12u",
  title: "Workspace prototype",
  description: null,
  kind: "html",
  home: { kind: "conversation", conversation: { id: "c-1", type: "channel", target: "#proj-workspace" } },
  currentVersion: 12,
  author: remy,
  createdAt: "2026-10-20T08:00:00.000Z",
  updatedAt: "2026-10-22T14:02:00.000Z",
};

const v12 = { number: 12, publisher: remy, createdAt: "2026-10-22T14:02:00.000Z", note: "card states", changedPaths: ["components.html"] };

const readExample: AgentApiArtifactReadResponse = {
  artifact: summary,
  version: {
    number: 12, current: true, entry: "index.html", label: null, note: "card states", publisher: remy, createdAt: "2026-10-22T14:02:00.000Z", sizeBytes: 8000,
    files: ["index.html", "components.html", "tech.html", "decisions.json", "a.css", "b.js", "logo.png", "cover.png"]
      .map((path, i) => ({ path, sizeBytes: 1000, kind: "html" as const, entry: i === 0 })),
  },
  versions: { total: 12, latest: [v12] },
  unseen: {
    firstRead: false,
    versionCount: 1,
    commentCount: 3,
    versions: [v12],
    comments: [
      { id: "c_812", author: xxchan, version: 12, path: "components.html", createdAt: "2026-10-22T14:05:00.000Z", excerpt: "The three card states should sit side by side so we can compare them.", truncated: false, bodyChars: 69, anchor: { type: "annotation", data: { kind: "element", label: "h2#states Card states", selectors: [{ type: "CssSelector", value: "#states" }, { type: "TextQuoteSelector", exact: "Card states" }] } } },
      { id: "c_813", author: remy, version: 12, path: null, createdAt: "2026-10-22T14:06:00.000Z", excerpt: "Done in v12.", truncated: false, bodyChars: 12 },
    ],
    commentsCursor: "cur_811",
  },
  viewing: [{ actor: xxchan, state: "viewing", path: null, since: "2026-10-22T14:00:00.000Z" }],
};

export const formatArtifactRead = axSurface(
  "Artifact summary: title, link, the message it came from (and how to read it), files, who is here, what others added since you last looked, and how to read a file.",
  (data: AgentApiArtifactReadResponse, allFiles: boolean): string => formatRead(data, "cli", { allFiles }),
  {
    examples: [
      { title: "new versions and comments", args: [readExample, false] },
      { title: "nothing new", args: [{ ...readExample, viewing: [], unseen: { firstRead: false, versionCount: 0, commentCount: 0, versions: [], comments: [], commentsCursor: null } }, false] },
      { title: "an older version", args: [{ ...readExample, version: { ...readExample.version!, number: 9, current: false }, unseen: null }, false] },
      { title: "the message it came from", args: [{ ...readExample, origin: { target: "#proj-workspace", messageId: "1dbe5d8c-0000-4000-8000-000000000001", via: "share" } }, false] },
    ],
  },
);

const listExample: AgentApiArtifactListResponse = {
  artifacts: [summary, { ...summary, id: "pt_def", title: "Q4 report", home: { kind: "server" }, currentVersion: 3 }],
  nextCursor: "c2",
  target: null,
};

const searchExample: AgentApiArtifactListResponse = {
  artifacts: [
    {
      ...summary,
      matches: [
        { field: "title", snippet: "Workspace prototype", highlights: [{ start: 0, length: 9 }] },
        { field: "content", path: "notes/plan.md", snippet: "The workspace rollout starts with the Artifacts tab; ask @Kirby for the card states.", highlights: [{ start: 4, length: 9 }] },
      ],
    },
    { ...summary, id: "pt_def", title: "Q4 report", home: { kind: "server" }, currentVersion: 3, matches: [] },
  ],
  nextCursor: "c2",
  target: null,
};

export const formatArtifactList = axSurface(
  "Artifacts the agent can see, most recently updated first, with the next page and how to read one; with --query, those with the words in the title, most relevant first.",
  (data: AgentApiArtifactListResponse, opts: { limit?: number; query?: string } = {}): string => formatList(data, "cli", opts),
  {
    examples: [
      { title: "a page with more", args: [listExample] },
      { title: "none in a conversation", args: [{ artifacts: [], nextCursor: null, target: { target: "#ops", conversationId: "c-3", homeFromThread: null } }] },
      { title: "search results", args: [searchExample, { query: "workspace" }] },
      { title: "search, nothing found in a conversation", args: [{ artifacts: [], nextCursor: null, target: { target: "#ops", conversationId: "c-3", homeFromThread: null } }, { query: "rollout plan" }] },
    ],
  },
);

export const formatArtifactsAlsoMatch = axSurface(
  "The line message search adds when artifacts match the same words.",
  (query: string, target?: string): string => formatAlsoMatch(query, target, "cli"),
  {
    examples: [
      { title: "whole server", args: ["rollout plan"] },
      { title: "one conversation", args: ["rollout plan", "#proj-workspace"] },
    ],
  },
);

/** A text selection as Porthole reports it and the web stores it. */
const cardStatesAnchor = { type: "annotation", data: { kind: "text", label: "The three card states", selectors: [
  { type: "TextQuoteSelector", exact: "The three card states", prefix: "Cards\n", suffix: " sit apart" },
  { type: "TextPositionSelector", start: 120, end: 141 },
  { type: "CssSelector", value: "#states > p:nth-of-type(2)" },
] } };

const commentsExample: AgentApiArtifactCommentsResponse = {
  artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 12 },
  view: "unseen",
  path: null,
  comments: [
    { id: "c_812", author: xxchan, version: 12, path: "components.html", anchor: cardStatesAnchor, replyTo: null, body: "The three card states should sit side by side so we can compare them.", createdAt: "2026-10-22T14:05:00.000Z", editedAt: null },
    { id: "c_815", author: remy, version: 12, path: "components.html", anchor: cardStatesAnchor, replyTo: "c_812", body: "Done in v12.", createdAt: "2026-10-22T14:09:00.000Z", editedAt: null },
    { id: "c_816", author: xxchan, version: 12, path: "README.md", anchor: { type: "lines", data: { start: 12, end: 14, quote: "## Install\nnpm install" } }, replyTo: null, body: "We use pnpm here.", createdAt: "2026-10-22T14:11:00.000Z", editedAt: null },
    { id: "c_817", author: xxchan, version: 12, path: "README.md", anchor: null, replyTo: null, body: "Otherwise good.", createdAt: "2026-10-22T14:12:00.000Z", editedAt: null },
  ],
  nextCursor: null,
  unseenVersionCount: 1,
};

/** A comment's images as the Server lists them (#146). */
const exampleImages: AgentApiArtifactCommentImage[] = [
  { fileId: "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c", contentType: "image/png", sizeBytes: 319_488, width: 1280, height: 800 },
  { fileId: "9b1d7e2a-4c3f-4e5d-8a6b-7c8d9e0f1a2b", contentType: "image/jpeg", sizeBytes: 2_202_009, width: 4032, height: 3024 },
];

const imageCommentsExample: AgentApiArtifactCommentsResponse = {
  ...commentsExample,
  comments: [
    { id: "c_820", author: xxchan, version: 12, path: "components.html", anchor: null, replyTo: null, body: "The card overflows on a phone: before and after.", createdAt: "2026-10-22T14:20:00.000Z", editedAt: null, images: exampleImages },
    { id: "c_821", author: xxchan, version: 12, path: null, anchor: null, replyTo: null, body: "", createdAt: "2026-10-22T14:21:00.000Z", editedAt: null, images: [exampleImages[0]!] },
  ],
  unseenVersionCount: 0,
};

/** The same comments from a Server that resolves threads (#249): c_812 resolved by Remy, c_816 and c_817 open. */
const resolvedCommentsExample: AgentApiArtifactCommentsResponse = {
  ...commentsExample,
  view: "all",
  comments: commentsExample.comments.map((c) => (c.id === "c_812"
    ? { ...c, resolvedAt: "2026-10-22T14:09:00.000Z", resolvedBy: remy }
    : { ...c, resolvedAt: null, resolvedBy: null })),
  unseenVersionCount: 0,
};

const exampleReviewId = asArtifactReviewId("rv_7");
const reviewExample = { id: exampleReviewId, author: remy, version: 12, body: "Close. Two things before v13, the rest is polish.", createdAt: "2026-10-27T18:30:00.000Z" };

const reviewCommentsExample: AgentApiArtifactCommentsResponse = {
  artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 12 },
  view: "all",
  path: null,
  review: reviewExample,
  comments: [
    { id: "c_901", author: remy, version: 12, path: "components.html", anchor: null, replyTo: null, body: "@Kirby the empty state is missing.", createdAt: "2026-10-27T18:30:00.000Z", editedAt: null, reviewId: exampleReviewId },
    { id: "c_902", author: remy, version: 12, path: "components.html", anchor: null, replyTo: "c_812", body: "Side by side works.", createdAt: "2026-10-27T18:30:00.000Z", editedAt: null, reviewId: exampleReviewId },
    { id: "c_903", author: remy, version: 12, path: null, anchor: null, replyTo: null, body: "Tech section reads well.", createdAt: "2026-10-27T18:30:00.000Z", editedAt: null, reviewId: exampleReviewId },
  ],
  nextCursor: null,
  unseenVersionCount: 0,
};

export const formatArtifactComments = axSurface(
  "An artifact's comments in full, oldest first: new ones by default, with versions not shown and how to page.",
  (data: AgentApiArtifactCommentsResponse, opts: { review?: string } = {}): string => formatComments(data, "cli", opts),
  {
    examples: [
      { title: "new comments", args: [commentsExample] },
      { title: "nothing new", args: [{ ...commentsExample, comments: [], unseenVersionCount: 0 }] },
      { title: "one review (--review)", args: [reviewCommentsExample, { review: "rv_7" }] },
      { title: "comments with images (one of images alone)", args: [imageCommentsExample] },
      { title: "a resolved thread and open ones (--all)", args: [resolvedCommentsExample] },
    ],
  },
);

export const formatArtifactDownloaded = axSurface(
  "Where a downloaded artifact file was saved.",
  (input: { path: string; version?: number; output: string; sizeBytes: number }): string => formatDownloaded(input),
  {
    examples: [{ args: [{ path: "logo.png", output: "./logo.png", sizeBytes: 20480 }] }],
  },
);

export const formatArtifactCommentImageSaved = axSurface(
  "Where a comment's image (download --image) was saved, its type and size.",
  (input: Parameters<typeof formatImageSaved>[0]): string => formatImageSaved(input),
  {
    examples: [{ args: [{ fileId: "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c", contentType: "image/png", sizeBytes: 319_488, output: "comment-c_820-1.png" }] }],
  },
);

export const formatArtifactPulled = axSurface(
  "Where pulled artifact files went, the base it recorded, what others added since you last looked (comments left unseen hold a push), and how to push; for another server's artifact, a copy to push as a new one.",
  (input: { artifact: string; title: string; version: number; fileCount: number; sizeBytes: number; dir: string; updated: boolean; unseen?: AgentApiArtifactReadResponse["unseen"]; copy?: { url: string }; leftOutStateFile?: boolean }): string => formatPulled(input),
  {
    examples: [
      { title: "a comment cut short stays unseen", args: [{ artifact: "pt_abc", title: "Workspace prototype", version: 12, fileCount: 8, sizeBytes: 421_888, dir: "./Workspace-prototype", updated: true, unseen: { ...readExample.unseen!, unread: 1 } }] },
      { title: "first pull (the folder is the title)", args: [{ artifact: "pt_abc", title: "Workspace prototype", version: 12, fileCount: 8, sizeBytes: 421_888, dir: "./Workspace-prototype", updated: false }] },
      { title: "update to a newer version", args: [{ artifact: "pt_abc", title: "Workspace prototype", version: 14, fileCount: 8, sizeBytes: 430_100, dir: "./Workspace-prototype", updated: true }] },
      { title: "another server's public artifact: a copy", args: [{ artifact: "pt_abc", title: "Workspace prototype", version: 12, fileCount: 8, sizeBytes: 421_888, dir: "./Workspace-prototype", updated: false, copy: { url: "https://app.raft.build/artifacts/pt_abc" } }] },
      { title: "the artifact held a .raft-artifact.json: left out", args: [{ artifact: "pt_abc", title: "Workspace prototype", version: 12, fileCount: 7, sizeBytes: 421_000, dir: "./Workspace-prototype", updated: false, leftOutStateFile: true }] },
    ],
  },
);

const publishedExample: AgentApiArtifactPublished = {
  artifact: { ...summary, currentVersion: 14 },
  version: { number: 14, filesFromYou: ["components.html"], deleted: [], base: 12, previous: 13, merged: [{ path: "tech.html", setting: null, version: 13, author: { type: "agent", name: "Tenny" } }] },
  unseen: { otherComments: 1 },
  notified: [],
  replayed: false,
  unchanged: false,
};

export const formatArtifactPublished = axSurface(
  "A push that went through: what the version holds, others' changes it took in, local files updated or not deleted, and the link; or a title changed alone, with no new version.",
  (data: AgentApiArtifactPublished, local: { dir?: string; updated?: string[]; removed?: string[]; notUpdated?: string[]; notDeleted?: string[]; skipped?: string[]; links?: string[]; target?: string }): string => formatPublished(data, "cli", local),
  {
    examples: [
      { title: "auto-merged with others' changes", args: [publishedExample, { dir: "./workspace-prototype", updated: ["tech.html"], notDeleted: ["draft.html"], skipped: [".env"] }] },
      { title: "a merged file couldn't be fetched", args: [publishedExample, { dir: "./workspace-prototype", notUpdated: ["tech.html"] }] },
      { title: "a new artifact", args: [{ ...publishedExample, artifact: { ...summary, currentVersion: 1 }, version: { number: 1, filesFromYou: ["index.html"], deleted: [], base: null, previous: null, merged: [] }, unseen: { otherComments: 0 } }, { dir: "./report", target: "#proj-workspace" }] },
      { title: "a new artifact pushed from a thread: homed in its channel, nothing posted, the command that sends its link", args: [{ ...publishedExample, artifact: { ...summary, currentVersion: 1 }, version: { number: 1, filesFromYou: ["report.pdf"], deleted: [], base: null, previous: null, merged: [] }, unseen: { otherComments: 0 } }, { dir: "./report", target: "#proj-workspace:fde584d1" }] },
      { title: "the title alone changed: no new version", args: [{ ...publishedExample, artifact: { ...summary, title: "Workspace prototype (final)" }, version: { number: 12, filesFromYou: [], deleted: [], base: 12, previous: 12, merged: [] }, unseen: { otherComments: 0 }, unchanged: true, titleChanged: { from: "Workspace prototype" } }, { dir: "./Workspace-prototype" }] },
      { title: "its publish check, pending", args: [{ ...publishedExample, version: { ...publishedExample.version, merged: [] }, unseen: { otherComments: 0 }, check: { id: "chk_14", status: "pending" } }, { dir: "./workspace-prototype" }] },
      { title: "its publish check, skipped (the files are the previous version's)", args: [{ ...publishedExample, version: { ...publishedExample.version, merged: [] }, unseen: { otherComments: 0 }, check: { id: "chk_14", status: "skipped", skipReason: "unchanged" } }, { dir: "./workspace-prototype" }] },
      { title: "a replayed push: its check as it is now", args: [{ ...publishedExample, version: { ...publishedExample.version, merged: [] }, unseen: { otherComments: 0 }, replayed: true, check: { id: "chk_14", status: "done" } }, {}] },
    ],
  },
);

const checkFound = {
  consoleErrors: [
    { message: "Uncaught TypeError: Cannot read properties of undefined (reading 'map')", source: "app.js", line: 42 },
    { message: "Failed to load resource: the server responded with a status of 404 ()", source: null, line: null },
  ],
  blockedResources: ["https://cdn.example.com/chart.js"],
  blank: false,
  phoneOverflow: { contentWidth: 640, viewportWidth: 390 },
};

const checkExample: AgentApiArtifactCheckResponse = {
  artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 14 },
  version: 14,
  check: {
    id: "chk_14", status: "done", skipReason: null, errorClass: null, findings: checkFound,
    createdAt: "2026-11-04T10:00:00.000Z", finishedAt: "2026-11-04T10:01:12.000Z",
    screenshots: [{ shot: "desktop" }, { shot: "phone" }],
  },
};
const checkWith = (check: Partial<NonNullable<AgentApiArtifactCheckResponse["check"]>>): AgentApiArtifactCheckResponse => ({ ...checkExample, check: { ...checkExample.check!, ...check } });
const unfinished = { findings: null, finishedAt: null, screenshots: [] };
const savedShots = { saved: [{ shot: "desktop" as const, path: ".raft-check/pt_abc-v14-desktop.png" }, { shot: "phone" as const, path: ".raft-check/pt_abc-v14-phone.png" }] };

export const formatArtifactCheck = axSurface(
  "A version's publish check by status: pending or running (and how to wait for it; a wait that ran out says so), done (what the page got wrong, in its own words, quoted, or that nothing was found; where its screenshots were saved; the fix), failed or skipped (why, and whether a later push is checked), or none.",
  (data: AgentApiArtifactCheckResponse, local: { saved?: Array<{ shot: "desktop" | "phone"; path: string }>; notSaved?: Array<{ shot: "desktop" | "phone"; reason: string }>; timedOut?: boolean }): string => formatCheck(data, "cli", local),
  {
    examples: [
      { title: "done, with findings and the screenshots saved", args: [checkExample, savedShots] },
      { title: "done, nothing found", args: [checkWith({ findings: { consoleErrors: [], blockedResources: [], blank: false, phoneOverflow: null } }), savedShots] },
      { title: "done, a blank page; one screenshot couldn't be downloaded", args: [checkWith({ findings: { consoleErrors: [], blockedResources: [], blank: true, phoneOverflow: null } }), { saved: [savedShots.saved[0]!], notSaved: [{ shot: "phone", reason: `the download failed: v14 of "pt_abc" has no phone screenshot from its publish check.` }] }] },
      { title: "done, an older version whose screenshots were let go", args: [{ ...checkWith({ findings: { consoleErrors: [], blockedResources: [], blank: false, phoneOverflow: null }, screenshots: [] }), version: 9 }, { saved: [] }] },
      { title: "pending", args: [checkWith({ status: "pending", ...unfinished }), {}] },
      { title: "running", args: [checkWith({ status: "running", ...unfinished }), {}] },
      { title: "still pending after --wait", args: [checkWith({ status: "pending", ...unfinished }), { timedOut: true }] },
      { title: "failed: the page didn't load in time", args: [checkWith({ status: "failed", errorClass: "load_timeout", findings: null, screenshots: [] }), {}] },
      { title: "failed: the page couldn't be loaded", args: [checkWith({ status: "failed", errorClass: "load_error:net_error", findings: null, screenshots: [] }), {}] },
      { title: "failed: given up on Raft's side", args: [checkWith({ status: "failed", errorClass: "expired", findings: null, screenshots: [] }), {}] },
      { title: "failed: a kind that isn't checked", args: [checkWith({ status: "failed", errorClass: "not_checked", findings: null, screenshots: [] }), {}] },
      { title: "skipped: the files are the previous version's", args: [checkWith({ status: "skipped", skipReason: "unchanged", findings: null, screenshots: [] }), {}] },
      { title: "skipped: the server's daily limit", args: [checkWith({ status: "skipped", skipReason: "server_daily_cap", findings: null, screenshots: [] }), {}] },
      { title: "skipped: Raft's daily limit", args: [checkWith({ status: "skipped", skipReason: "platform_daily_cap", findings: null, screenshots: [] }), {}] },
      { title: "no check (a PDF, a version from before checks, or checks off)", args: [{ ...checkExample, check: null }, {}] },
    ],
  },
);

export const formatArtifactCheckWaiting = axSurface(
  "The line `raft artifact check --wait` prints to stderr once, when it starts waiting for a pending or running check.",
  (version: number): string => formatCheckWaiting(version),
  {
    examples: [{ args: [14] }],
  },
);

export const formatArtifactNothingToPublish = axSurface(
  "A push with no change since the base, and how to delete files missing locally.",
  (input: { dir: string; version: number; notDeleted: string[] }): string => formatNothing(input),
  {
    examples: [{ args: [{ dir: "./workspace-prototype", version: 12, notDeleted: ["draft.html"] }] }],
  },
);

const artifactRef = { id: "pt_abc", title: "Workspace prototype", currentVersion: 12 };

const commentedExample: AgentApiArtifactCommentCreated = {
  artifact: artifactRef,
  comment: { id: "c_820", author: remy, version: 12, path: "components.html", anchor: null, replyTo: null, body: "Can you check the empty state, @Kirby?", createdAt: "2026-10-22T14:20:00.000Z", editedAt: null },
  notified: [{ actor: { type: "agent", name: "Kirby" }, reason: "mentioned" }, { actor: { type: "agent", name: "Tenny" }, reason: "subscribed" }],
  notNotified: [{ name: "xxchan", reason: "not_agent" }],
  newlySubscribed: true,
};

export const formatArtifactCommented = axSurface(
  "A comment written: where, who was notified (mentioned and followers, at once), whose @ reached no one and why, and following.",
  (data: AgentApiArtifactCommentCreated): string => formatCommented(data, "cli"),
  {
    examples: [
      { title: "mentions and followers", args: [commentedExample] },
      { title: "nobody notified", args: [{ ...commentedExample, notified: [], notNotified: [], newlySubscribed: false }] },
      { title: "with images (--image)", args: [{ ...commentedExample, comment: { ...commentedExample.comment, images: exampleImages } }] },
    ],
  },
);

const reviewedExample: AgentApiArtifactReviewCreated = {
  artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 12 },
  review: reviewExample,
  comments: reviewCommentsExample.comments,
  notified: [{ actor: { type: "agent", name: "Kirby" }, reason: "mentioned" }, { actor: { type: "agent", name: "Tenny" }, reason: "subscribed" }],
  notNotified: [{ name: "xxchan", reason: "not_agent" }],
  newlySubscribed: false,
};

const reviewedWithImagesExample: AgentApiArtifactReviewCreated = {
  ...reviewedExample,
  comments: [
    { ...reviewCommentsExample.comments[0]!, images: exampleImages },
    { ...reviewCommentsExample.comments[2]!, id: "c_904", body: "", images: [exampleImages[0]!] },
  ],
};

export const formatArtifactReviewed = axSurface(
  "A review posted: its id, how many comments where, their ids in order (each one's images counted), who was notified (each once), whose @ reached no one, and how to read it back. Replayed (a resend under the same key found it already posted): that it was, and that nothing was posted or told again.",
  (data: AgentApiArtifactReviewCreated, opts: { replayed?: boolean } = {}): string => formatReviewed(data, "cli", opts),
  {
    examples: [
      { title: "a mention and a follower", args: [reviewedExample] },
      { title: "nobody notified", args: [{ ...reviewedExample, notified: [], notNotified: [], newlySubscribed: true }] },
      { title: "replayed: the answer was lost and the resend found it posted", args: [{ ...reviewedExample, notified: [], notNotified: [] }, { replayed: true }] },
      { title: "with images (one of images alone)", args: [reviewedWithImagesExample] },
    ],
  },
);

const resolutionExample: AgentApiArtifactThreadResolution = {
  artifact: artifactRef,
  comment: { id: "c_812", author: xxchan, version: 12, path: "components.html", anchor: null, replyTo: null, body: "The three card states should sit side by side.", createdAt: "2026-10-22T14:05:00.000Z", editedAt: null, resolvedAt: "2026-10-23T09:00:00.000Z", resolvedBy: remy },
  note: { id: "c_830", author: remy, version: 13, path: "components.html", anchor: null, replyTo: "c_812", body: "Done in v13.", createdAt: "2026-10-23T09:00:00.000Z", editedAt: null, resolvedAt: null, resolvedBy: null },
  changed: true,
  notified: [{ actor: { type: "agent", name: "Kirby" }, reason: "subscribed" }],
  notNotified: [{ name: "xxchan", reason: "not_agent" }],
};

export const formatArtifactThreadResolution = axSurface(
  "A thread resolved (its note's reply id, who was told) or reopened, or already so (nothing changed, no note), and how to undo it.",
  (data: AgentApiArtifactThreadResolution): string => formatThreadResolution(data, "cli"),
  {
    examples: [
      { title: "resolved with a note (raft artifact resolve --note)", args: [resolutionExample] },
      { title: "resolved, an agent's thread", args: [{ ...resolutionExample, comment: { ...resolutionExample.comment, author: { type: "agent" as const, name: "Kirby" } }, note: null, notified: [{ actor: { type: "agent" as const, name: "Kirby" }, reason: "resolved" as const }], notNotified: [] }] },
      { title: "already resolved", args: [{ ...resolutionExample, note: null, changed: false, notified: [], notNotified: [] }] },
      { title: "reopened (raft artifact reopen)", args: [{ ...resolutionExample, comment: { ...resolutionExample.comment, resolvedAt: null, resolvedBy: null }, note: null, notified: [], notNotified: [] }] },
    ],
  },
);

export const formatArtifactSubscription = axSurface(
  "Following an artifact, or not any more, and how to undo it.",
  (data: AgentApiArtifactSubscriptionResponse): string => formatSubscription(data, "cli"),
  {
    examples: [
      { title: "following", args: [{ artifact: artifactRef, following: true }] },
      { title: "not following", args: [{ artifact: artifactRef, following: false }] },
    ],
  },
);

export const formatArtifactMoved = axSurface(
  "An artifact moved to the whole server: who sees it now, who can move it back to the home it left, and its link.",
  (data: AgentApiArtifactMoved): string => formatMoved(data),
  {
    examples: [
      { title: "from a channel", args: [{ artifact: { ...summary, home: { kind: "server" } }, from: summary.home }] },
    ],
  },
);

export const formatArtifactDeleted = axSurface(
  "An artifact deleted: no one can open it or its versions any more, and it can't be undone.",
  (data: AgentApiArtifactDeleted): string => formatDeleted(data),
  {
    examples: [{ args: [{ artifact: artifactRef, deleted: true }] }],
  },
);

export const formatArtifactSaved = axSurface(
  "An attachment saved as an artifact: the new artifact, who can open it, that the attachment links to it and that you follow it, its link and how to revise it; or the one an earlier save made.",
  (data: AgentApiArtifactSaved): string => formatSaved(data, "cli"),
  {
    examples: [
      { title: "saved", args: [{ artifact: { ...summary, id: "pt_def", url: "https://app.raft.build/artifacts/8oRvuaLwXvau1ypHChfZkE", title: "Q3 report", kind: "markdown", currentVersion: 1 }, created: true, attachment: { id: "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c", filename: "Q3 report.md" } }] },
      { title: "already saved", args: [{ artifact: { ...summary, id: "pt_def", url: "https://app.raft.build/artifacts/8oRvuaLwXvau1ypHChfZkE", title: "Q3 report", kind: "markdown", currentVersion: 2 }, created: false, attachment: { id: "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c", filename: "Q3 report.md" } }] },
    ],
  },
);
