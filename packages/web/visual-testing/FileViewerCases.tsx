import { useState } from "react";
import api from "../src/api/client";
import ImageLightbox from "../src/components/ImageLightbox";
import { DocumentAttachmentPreviewModal } from "../src/components/message/attachmentPreviewSurfaces";
import type { PreviewCommentsContext } from "../src/components/message/attachmentPreviewSurfaces";
import type { DocumentAttachmentPreview } from "../src/components/message/attachmentPreview";
import type { AttachmentComment } from "../src/components/message/useAttachmentComments";
import { useImageLightboxStore } from "../src/store/imageLightboxStore";
import fixtureData from "../../visual-testing/shared/fixtureData.json";

// File viewer cases: each opens one attachment type in the shared viewer over a
// static conversation, so the header and the scrim are captured in context.

const SAMPLE_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7cc4f2"/><stop offset="1" stop-color="#f7e3b5"/></linearGradient>
<linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f7fb3"/><stop offset="1" stop-color="#173f63"/></linearGradient></defs>
<rect width="1600" height="1000" fill="url(#sky)"/><circle cx="1180" cy="300" r="110" fill="#ffd440"/>
<path d="M0 620 L260 380 L470 560 L700 300 L980 600 L1200 450 L1600 640 L1600 1000 L0 1000Z" fill="#5c7a5a"/>
<rect y="680" width="1600" height="320" fill="url(#sea)"/>
<path d="M620 760 h260 l-40 60 h-180z" fill="#3a2a1e"/><rect x="742" y="560" width="10" height="200" fill="#3a2a1e"/>
<path d="M752 570 L752 740 L880 740Z" fill="#fff8e6"/></svg>`)}`;

const IMAGES = ["harbor-sketch-01.png", "harbor-sketch-02.png", "harbor-sketch-03.png"].map((filename, index) => ({
  id: `visual-image-${index}`,
  filename,
  mimeType: "image/png",
  sizeBytes: 482_113,
  directUrl: SAMPLE_IMAGE,
  thumbnailUrl: SAMPLE_IMAGE,
}));

const TEXT_FILE = [
  "// raft-sync worker — reconnect loop (excerpt)",
  "import { backoff, jitter } from \"./timing\";",
  "import type { SyncCursor, SyncTransport } from \"./types\";",
  "",
  "const MAX_ATTEMPTS = 8;",
  "const BASE_DELAY_MS = 250;",
  "",
  "export async function reconnect(transport: SyncTransport, cursor: SyncCursor, signal: AbortSignal): Promise<SyncCursor> {",
  "  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {",
  "    if (signal.aborted) throw new DOMException(\"aborted\", \"AbortError\");",
  "    try {",
  "      const session = await transport.open({ cursor, resume: attempt > 0, reason: attempt > 0 ? \"retry-after-network-drop\" : \"initial-connect\" });",
  "      return await session.drainUntilCaughtUp();",
  "    } catch (error) {",
  "      const delay = jitter(backoff(BASE_DELAY_MS, attempt));",
  "      console.warn(`[sync] attempt ${attempt + 1}/${MAX_ATTEMPTS} failed; retrying in ${delay}ms`, { cursor: cursor.toString(), error });",
  "      await new Promise((resolve) => setTimeout(resolve, delay));",
  "    }",
  "  }",
  "  throw new Error(\"sync: gave up after max attempts\");",
  "}",
  "",
  "// 2026-10-19T09:41:07.112Z INFO  sync.worker  cursor=c_01JAX3 channel=#design messages=128 attachments=14 elapsed=1843ms queue_depth=0 backpressure=false",
  "// 2026-10-19T09:41:09.502Z WARN  sync.worker  transport closed code=1006 reason=\"\" retry_in=412ms attempt=1/8",
  "// 2026-10-19T09:41:10.020Z INFO  sync.worker  resumed cursor=c_01JAX3 delta=3",
  "",
  "export function describeCursor(cursor: SyncCursor): string {",
  "  return `${cursor.channelId}@${cursor.sequence}`;",
  "}",
  ...Array.from({ length: 18 }, (_, i) => `// trace ${i + 1}: cursor=c_01JAX3 delta=${i} ok`),
].join("\n");

const MARKDOWN_FILE = `# Harbor launch notes

Short version: the harbor sketches go to design review on Monday, and the sync excerpt ships with the next build.

## What changes

- The reconnect loop backs off with jitter instead of a fixed delay.
- Cursor descriptions include the channel, so logs are easier to read.

## Open questions

1. Should long log lines wrap in the text preview?
2. Do we keep eight attempts, or cap retries by total time?

| Attempt | Delay | Jitter |
| --- | --- | --- |
| 1 | 250ms | ±50ms |
| 2 | 500ms | ±100ms |
| 3 | 1s | ±200ms |
`;

function FakeConversation() {
  const rows = [
    ["Cindy", "Here are the harbor sketches and the launch notes — can you take a look before the review?"],
    ["Product UX", "Looking now. The second sketch reads best at full size; attaching the sync excerpt too."],
    ["Artin", "Notes look good. One question about wrapping long log lines in the text preview."],
    ["Cindy", "Let's decide in the review. I'll bring screenshots of every file type."],
    ["Product UX", "Sounds good, I'll bring the reconnect numbers."],
  ];
  return (
    <main className="min-h-screen bg-layer-canvas font-display text-foreground">
      <div className="flex h-14 items-center border-b border-line-seam px-5 text-headline font-bold"># design</div>
      <div className="mx-auto flex max-w-3xl flex-col gap-5 p-6">
        {[...rows, ...rows].map(([name, text], index) => (
          <div key={index} className="flex gap-3">
            <div className="size-9 shrink-0 rounded-control bg-fill-muted" />
            <div className="min-w-0">
              <div className="text-callout font-bold">{name}</div>
              <div className="text-body">{text}</div>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

function noop() {}

function ImageCase() {
  // Open the gallery before the first paint so the capture never sees the
  // conversation without its viewer.
  useState(() => {
    useImageLightboxStore.getState().open(IMAGES, 1);
    return null;
  });
  return (
    <>
      <FakeConversation />
      <ImageLightbox />
    </>
  );
}

const TEXT_PREVIEW = { kind: "text", text: TEXT_FILE } as const;
const MARKDOWN_PREVIEW = { kind: "markdown", markdown: MARKDOWN_FILE } as const;

function DocumentCase({ kind }: { kind: "text" | "markdown" }) {
  return (
    <>
      <FakeConversation />
      <DocumentAttachmentPreviewModal
        filename={kind === "text" ? "raft-sync-reconnect.ts" : "harbor-launch-notes.md"}
        preview={kind === "text" ? TEXT_PREVIEW : MARKDOWN_PREVIEW}
        truncated={false}
        url={null}
        onClose={noop}
        onDownload={noop}
      />
    </>
  );
}

// Comments beside the passage (task #118): the same viewer with the
// attachment's comments, served by a stub of the comments endpoint so the
// case needs no server. Selecting text, opening a card or a marker is the
// capture's job (the cards are plain DOM, nothing to prime).

const COMMENTED_MARKDOWN = `# Harbor launch notes

Short version: the harbor sketches go to design review on Monday, and the sync excerpt ships with the next build.

## What changes

- The reconnect loop backs off with jitter instead of a fixed delay.
- Cursor descriptions include the channel, so logs are easier to read.
- The worker drops its queue on sign-out instead of replaying it on the next session.

## Rollout plan

Ship to 10% of desktop clients first and watch the reconnect rate for two days. If the p95 time to caught-up stays under three seconds, go to everyone on Thursday.

Mobile follows a week later, once the background-fetch path has the same backoff.

## Open questions

1. Should long log lines wrap in the text preview?
2. Do we keep eight attempts, or cap retries by total time?
3. Who owns the dashboard after launch?

| Attempt | Delay | Jitter |
| --- | --- | --- |
| 1 | 250ms | ±50ms |
| 2 | 500ms | ±100ms |
| 3 | 1s | ±200ms |
| 4 | 2s | ±400ms |

## Review checklist

- Screenshots of every file type in light and dark.
- The reconnect numbers from last week's soak test.
- A note for support about the new log format.
`;

const CSV_PREVIEW: Extract<DocumentAttachmentPreview, { kind: "csv" }> = {
  kind: "csv",
  delimiter: ",",
  headers: ["week", "region", "reconnects", "p95_caught_up_ms", "owner"],
  rows: [
    ["2026-W38", "us-east", "1,204", "2,410", "Artin"],
    ["2026-W38", "eu-west", "988", "2,870", "Jiacheng"],
    ["2026-W39", "us-east", "1,131", "2,305", "Artin"],
    ["2026-W39", "eu-west", "1,402", "4,960", "Jiacheng"],
    ["2026-W40", "us-east", "1,090", "2,288", "Artin"],
    ["2026-W40", "eu-west", "1,377", "4,712", "Jiacheng"],
    ["2026-W41", "us-east", "1,066", "2,190", "Artin"],
    ["2026-W41", "eu-west", "1,019", "2,644", "Jiacheng"],
  ],
  rowCount: 8,
  columnCount: 5,
};

const { owner, designer, jiacheng } = fixtureData.humans;
const { productUx, builder } = fixtureData.agents;

type Author = Pick<AttachmentComment, "senderType" | "senderId" | "senderName" | "senderAvatarUrl">;
const ARTIN: Author = { senderType: "user", senderId: owner.id, senderName: owner.displayName, senderAvatarUrl: null };
const DESIGNER: Author = { senderType: "user", senderId: designer.id, senderName: designer.displayName, senderAvatarUrl: null };
const JIACHENG: Author = { senderType: "user", senderId: jiacheng.id, senderName: jiacheng.displayName, senderAvatarUrl: null };
const PRODUCT_UX: Author = { senderType: "agent", senderId: productUx.id, senderName: productUx.displayName, senderAvatarUrl: productUx.avatar };
const BUILDER: Author = { senderType: "agent", senderId: builder.id, senderName: builder.displayName, senderAvatarUrl: builder.avatar };

function visualComment(
  id: string,
  author: Author,
  minute: number,
  content: string,
  anchor: AttachmentComment["anchor"] = null,
): AttachmentComment {
  return {
    id,
    channelId: "visual-comment-thread",
    ...author,
    content,
    createdAt: new Date(Date.UTC(2026, 9, 20, 9, minute)).toISOString(),
    reactions: [],
    anchor,
  };
}

const ON_JITTER = { type: "md-section", data: { headingId: "what-changes", headingTitle: "What changes", quote: "backs off with jitter instead of a fixed delay" } };
const ON_ROLLOUT = { type: "md-section", data: { headingId: "rollout-plan", headingTitle: "Rollout plan", quote: "Ship to 10% of desktop clients first" } };
const ON_ATTEMPTS = { type: "md-section", data: { headingId: "open-questions", headingTitle: "Open questions", quote: "Do we keep eight attempts, or cap retries by total time?" } };
// The section this was on was deleted in a later revision of the file.
const ON_REMOVED = { type: "md-section", data: { headingId: "known-issues", headingTitle: "Known issues", quote: "Cursor resets can replay up to 200 messages" } };

const MARKDOWN_COMMENTS: AttachmentComment[] = [
  visualComment("vc-file", DESIGNER, 2, "Overall this is ready for Monday's review. Thanks for pulling the numbers together."),
  visualComment("vc-jitter", ARTIN, 4, "Do we have the soak-test numbers for jitter vs. the fixed delay? I'd like them in the deck.", ON_JITTER),
  visualComment("vc-jitter-r1", PRODUCT_UX, 9, "Yes: p95 time to caught-up went from 3.8s to 2.3s on the eu-west soak. I'll add the chart.", ON_JITTER),
  visualComment("vc-jitter-r2", JIACHENG, 15, "Let's also call out that the worst case stays under 4s.", ON_JITTER),
  visualComment("vc-rollout", JIACHENG, 6, "Two days feels short for eu-west, the weekend traffic is different. Can we hold until Monday?", ON_ROLLOUT),
  visualComment("vc-attempts", BUILDER, 8, "I'd cap by total time (30s) and keep the attempt count only as a safety net.", ON_ATTEMPTS),
  visualComment("vc-removed", ARTIN, 3, "Is this still true after the cursor fix? If so it should be in the release notes.", ON_REMOVED),
];

const TEXT_COMMENTS: AttachmentComment[] = [
  visualComment("vc-lines", ARTIN, 4, "The reason string doubles as a metric label, so let's keep it short and stable.", { type: "lines", data: { start: 12, end: 13, quote: "const session = await transport.open(" } }),
  visualComment("vc-lines-r1", BUILDER, 7, "Agreed. I'll move it to a constant in a follow-up.", { type: "lines", data: { start: 12, end: 13, quote: "const session = await transport.open(" } }),
  visualComment("vc-log", JIACHENG, 9, "This is the 1006 we saw in the soak test.", { type: "lines", data: { start: 24, end: 24, quote: "transport closed code=1006" } }),
];

const CSV_COMMENTS: AttachmentComment[] = [
  visualComment("vc-rows", JIACHENG, 4, "eu-west spiked in W39 and W40 — that was the load balancer change, not the client. Footnote it?", { type: "csv-rows", data: { start: 4, end: 6, quote: "2026-W39 eu-west" } }),
  visualComment("vc-rows-r1", PRODUCT_UX, 11, "Added a footnote in the deck.", { type: "csv-rows", data: { start: 4, end: 6, quote: "2026-W39 eu-west" } }),
];

const COMMENTS_BY_ATTACHMENT: Record<string, AttachmentComment[]> = {
  "visual-markdown-commented": MARKDOWN_COMMENTS,
  "visual-text-commented": TEXT_COMMENTS,
  "visual-csv-commented": CSV_COMMENTS,
  // The same notes before anyone commented: no margin until the first one.
  "visual-markdown-uncommented": [],
};

let commentsStubInstalled = false;
/** Serves the comments endpoint (and the mention lookup the reply box makes) from the fixtures above. */
function installCommentsStub() {
  if (commentsStubInstalled) return;
  commentsStubInstalled = true;
  const get = api.get.bind(api);
  const post = api.post.bind(api);
  api.get = (async (url: string, config?: unknown) => {
    const match = /^\/attachments\/([^/]+)\/comments$/.exec(url);
    if (match && COMMENTS_BY_ATTACHMENT[match[1]!]) {
      return { data: { comments: COMMENTS_BY_ATTACHMENT[match[1]!], threadChannelId: "visual-comment-thread", viewer: { canComment: true, reason: "ok" } } };
    }
    if (url.startsWith("/channels/")) return { data: { agents: [], humans: [] } };
    return get(url, config as never);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown, config?: unknown) => {
    if (/^\/attachments\/[^/]+\/comments$/.test(url)) return { data: { threadChannelId: "visual-comment-thread" } };
    return post(url, body, config as never);
  }) as typeof api.post;
}

const PARENT_MESSAGE = { id: "visual-message-1", channelId: "visual-channel-design", senderId: owner.id, senderType: "user" } as const;

function commentsContext(attachmentId: string, filename: string): PreviewCommentsContext {
  return { attachmentId, filename, commentCount: COMMENTS_BY_ATTACHMENT[attachmentId]!.length, parentMessage: PARENT_MESSAGE };
}

const COMMENTED_MARKDOWN_PREVIEW = { kind: "markdown", markdown: COMMENTED_MARKDOWN } as const;

function CommentedDocumentCase({ kind, uncommented = false }: { kind: "markdown" | "text" | "csv"; uncommented?: boolean }) {
  useState(() => {
    installCommentsStub();
    return null;
  });
  const filename = kind === "markdown" ? "harbor-launch-notes.md" : kind === "text" ? "raft-sync-reconnect.ts" : "reconnect-soak.csv";
  return (
    <>
      <FakeConversation />
      <DocumentAttachmentPreviewModal
        filename={filename}
        preview={kind === "markdown" ? COMMENTED_MARKDOWN_PREVIEW : kind === "text" ? TEXT_PREVIEW : CSV_PREVIEW}
        truncated={false}
        url={null}
        onClose={noop}
        onDownload={noop}
        comments={commentsContext(uncommented ? `visual-${kind}-uncommented` : `visual-${kind}-commented`, filename)}
      />
    </>
  );
}

export const FILE_VIEWER_CASE_IDS = [
  "components.file-viewer.image",
  "components.file-viewer.text",
  "components.file-viewer.markdown",
  "components.file-viewer.markdown.comments",
  "components.file-viewer.text.comments",
  "components.file-viewer.csv.comments",
  "components.file-viewer.markdown.no-comments",
] as const;

export function FileViewerCase({ caseId }: { caseId: string }) {
  if (caseId === "components.file-viewer.image") return <ImageCase />;
  if (caseId === "components.file-viewer.markdown.comments") return <CommentedDocumentCase kind="markdown" />;
  if (caseId === "components.file-viewer.text.comments") return <CommentedDocumentCase kind="text" />;
  if (caseId === "components.file-viewer.csv.comments") return <CommentedDocumentCase kind="csv" />;
  if (caseId === "components.file-viewer.markdown.no-comments") return <CommentedDocumentCase kind="markdown" uncommented />;
  if (caseId === "components.file-viewer.text") return <DocumentCase kind="text" />;
  return <DocumentCase kind="markdown" />;
}
