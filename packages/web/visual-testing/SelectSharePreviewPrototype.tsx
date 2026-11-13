import { useEffect, useRef, useState } from "react";
import fixtureData from "../../visual-testing/shared/fixtureData.json";
import MessageItem from "../src/components/message/MessageItem";
import SelectShareLightbox from "../src/components/message/SelectShareLightbox";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import type { ServerMember } from "../src/store/serverStore";
import { captureSelectedMessageImage } from "../src/utils/selectScreenshot";
import { planScreenshotPages } from "../src/utils/selectScreenshotPagination";
import type { ValidatedScreenshot } from "../src/utils/screenshotBudget";

const fxProductUx = fixtureData.agents.productUx;
const fxChannel = fixtureData.channels.design;
const fxHumanCindy: ServerMember = {
  userId: "visual-human-cindy",
  email: "cindy@raft.build",
  name: "cindyz",
  displayName: "Cindy",
  description: null,
  avatarUrl: null,
  role: "owner",
  joinedAt: "2026-01-01T00:00:00.000Z",
};

// These are real Message DTOs rendered through MessageItem. A reaction is
// deliberately present on the first live row so the visual proves that the
// share-artifact sanitizer removes it rather than the fixture merely omitting
// it. Quotes and attachments likewise use the product's real renderers.
const PREVIEW_MESSAGES: Message[] = [
  {
    id: "preview-share-1",
    channelId: fxChannel.id,
    senderType: "user",
    senderId: fxHumanCindy.userId,
    senderName: fxHumanCindy.displayName ?? fxHumanCindy.name,
    content: "把这些讨论整理成可分享的图片。头像、正文和引用要保留。\n\n> 跨页点要落在消息之间，不要把正常消息拦腰切开。",
    createdAt: "2026-10-19T09:26:00.000Z",
    reactions: [{ emoji: "👍", count: 4, reactorIds: [fixtureData.humans.owner.id], reactorNames: [fixtureData.humans.owner.name] }],
  },
  {
    id: "preview-share-2",
    channelId: fxChannel.id,
    senderType: "agent",
    senderId: fxProductUx.id,
    senderName: fxProductUx.displayName,
    content: "短消息会尽量和前后消息留在同一页，只有下一条放不下时才换页。",
    createdAt: "2026-10-19T09:27:00.000Z",
    attachments: [{
      id: "preview-share-attachment-1",
      filename: "research-notes.zip",
      mimeType: "application/zip",
      sizeBytes: 188_416,
      commentCount: 0,
    }],
  },
  {
    id: "preview-share-3",
    channelId: fxChannel.id,
    senderType: "user",
    senderId: fxHumanCindy.userId,
    senderName: fxHumanCindy.displayName ?? fxHumanCindy.name,
    content: "分页后所有图片仍保持原始选择顺序；每一页都会重复 Raft 标题栏并标明页码。",
    createdAt: "2026-10-19T09:28:00.000Z",
  },
  {
    id: "preview-share-4",
    channelId: fxChannel.id,
    senderType: "agent",
    senderId: fxProductUx.id,
    senderName: fxProductUx.displayName,
    content: "只有单条消息自己就比一整页更高时，才会切成连续片段，并显示接上页或续下页。",
    createdAt: "2026-10-19T09:29:00.000Z",
  },
  {
    id: "preview-share-5",
    channelId: fxChannel.id,
    senderType: "user",
    senderId: fxHumanCindy.userId,
    senderName: fxHumanCindy.displayName ?? fxHumanCindy.name,
    content: "每页生成后都要通过非空、PNG 解码、尺寸和像素预算校验，全部通过后才进入预览。",
    createdAt: "2026-10-19T09:30:00.000Z",
  },
  {
    id: "preview-share-6",
    channelId: fxChannel.id,
    senderType: "agent",
    senderId: fxProductUx.id,
    senderName: fxProductUx.displayName,
    content: "桌面端可以逐页下载或下载有序 ZIP；移动端优先分享整组 PNG。",
    createdAt: "2026-10-19T09:31:00.000Z",
  },
];

function noop() {}

export default function SelectSharePreviewPrototype({ mobile }: { mobile: boolean }) {
  const captureScopeRef = useRef<HTMLDivElement>(null);
  const [images, setImages] = useState<ValidatedScreenshot[] | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const channels = useChannelStore.getState().channels;
  const agents = useAgentStore.getState().agents;

  useEffect(() => {
    let cancelled = false;
    const scope = captureScopeRef.current;
    if (!scope) return;

    const width = mobile ? 360 : 640;
    const measures = PREVIEW_MESSAGES.map(({ id }) => {
      const row = scope.querySelector<HTMLElement>(`#message-${id}`);
      return {
        id,
        cssHeight: Math.max(1, row?.getBoundingClientRect().height ?? 1),
      };
    });
    const measuredHeights = measures.map((measure) => measure.cssHeight);
    const pairContentMax = Math.max(...measuredHeights.slice(0, -1).map((height, index) => (
      height + measuredHeights[index + 1]
    )));
    // Use the production planner with a visual-fixture-only budget large
    // enough for every adjacent pair. This makes the real MessageItem fixture
    // demonstrate multiple complete messages on a page without pretending
    // that six ordinary rows would paginate under the production 16M budget.
    const fixturePageContentHeight = pairContentMax + 4;
    const pages = planScreenshotPages(measures, {
      cssWidth: width,
      pageChromeCssHeight: 80,
      continuationChromeCssHeight: 24,
      preferredPixelRatio: 2,
      maxOutputPixels: width * 4 * (80 + fixturePageContentHeight),
    });

    void Promise.all(pages.map((page) => (
      captureSelectedMessageImage(page.segments.map((segment) => segment.messageId), {
        scope,
        maxWidth: width,
        pixelRatio: page.pixelRatio,
        pageSegments: page.segments,
        pageNumber: page.pageNumber,
        pageCount: page.pageCount,
      })
    ))).then((captured) => {
      if (!cancelled) setImages(captured);
    }).catch((error: unknown) => {
      if (!cancelled) setCaptureError(error instanceof Error ? error.message : String(error));
    });

    return () => {
      cancelled = true;
    };
  }, [mobile]);

  return (
    <div
      data-visual-case={mobile ? "components.thread.message-share.preview.mobile" : "components.thread.message-share.preview.desktop"}
    >
      <div
        ref={captureScopeRef}
        className="absolute left-[-99999px] top-0 bg-layer-canvas text-foreground"
        style={{ width: mobile ? 360 : 640 }}
        aria-hidden="true"
      >
        {PREVIEW_MESSAGES.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            mentionMap={new Map()}
            channels={channels}
            previewSenderAgent={agents.find((agent) => agent.id === message.senderId)}
            previewSenderMember={message.senderId === fxHumanCindy.userId ? fxHumanCindy : undefined}
            hideThreadActions
          />
        ))}
      </div>

      {captureError ? (
        <p role="alert" className="p-6 text-danger-strong">{captureError}</p>
      ) : images ? (
        <SelectShareLightbox
          images={images}
          filename="raft-selected-messages.png"
          onClose={noop}
          onSaved={noop}
        />
      ) : (
        <p className="p-6 text-foreground-muted">Rendering real capture pipeline…</p>
      )}
    </div>
  );
}
