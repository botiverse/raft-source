import assert from "node:assert/strict";
import { resetAttachmentPreviewSummaryCache } from "../src/components/message/attachmentPreviewSummaryCache";
import { resetInlineAttachmentUrlCache } from "../src/components/message/inlineAttachmentUrlCache";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import ForwardedBundleCard from "../src/components/message/ForwardedBundleCard";
import type { ForwardedBundleMetadata } from "../src/components/message/ForwardedBundleCard";

const originalGet = api.get;

afterEach(() => {
  resetAttachmentPreviewSummaryCache();
  resetInlineAttachmentUrlCache();
  cleanup();
  api.get = originalGet;
});

function metadata(): ForwardedBundleMetadata {
  return {
    kind: "forwarded-bundle",
    version: 1,
    forwardedItems: [{
      sourceMessageId: "source-message",
      sourceAuthorSnapshot: { type: "user", name: "Developer" },
      sourceCreatedAt: "2026-07-30T12:00:00.000Z",
      sourceTargetSnapshot: {
        id: "source-channel",
        type: "channel",
        label: "#general",
        labelVisibility: "public",
      },
      contentSnapshot: "Four images and one file",
      attachmentPolicy: "projected",
      attachmentSnapshots: [
        { id: "image-1", filename: "one.jpg", mimeType: "image/jpeg", width: 1600, height: 900 },
        { id: "image-2", filename: "two.png", mimeType: "image/png", width: 900, height: 1400 },
        { id: "image-3", filename: "three.webp", mimeType: "image/webp", width: 1200, height: 1200 },
        { id: "image-4", filename: "four.gif", mimeType: "image/gif", width: 640, height: 480 },
        { id: "file-1", filename: "notes.txt", mimeType: "text/plain" },
      ],
    }],
  };
}

test("Forward image strip loads destination projection previews, scrolls after three columns, and updates occlusion shadow cues", async () => {
  // The strip resolves every tile in ONE batch request now: per-attachment GETs
  // scaled with images rather than messages and tripped the download limiter.
  const batched: string[][] = [];
  api.post = (async (url: string, body: { attachmentIds: string[] }) => {
    assert.equal(url, "/attachments/urls");
    batched.push([...body.attachmentIds]);
    return { data: { urls: body.attachmentIds.map((id) => ({ id, url: `https://preview.test/${id}.jpg`, expiresAt: null })) } };
  }) as unknown as typeof api.post;
  const opened: string[] = [];

  render(
    <TestIntlProvider>
      <ForwardedBundleCard
        metadata={metadata()}
        onOpenAttachment={(attachment) => opened.push(attachment.id ?? "")}
      />
    </TestIntlProvider>,
  );

  await waitFor(() => {
    assert.equal(document.querySelectorAll('[data-testid="forwarded-bundle-image"] img').length, 4);
  });
  // One request for four images, not four requests.
  assert.equal(batched.length, 1);
  assert.deepEqual([...batched[0]!].sort(), ["image-1", "image-2", "image-3", "image-4"]);
  assert.ok(screen.getByTestId("forwarded-bundle-file-chips").textContent?.includes("notes.txt"));

  const scroller = screen.getByTestId("forwarded-bundle-image-scroller");
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 300 });
  Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 400 });
  Object.defineProperty(scroller, "scrollLeft", { configurable: true, writable: true, value: 0 });
  fireEvent.scroll(scroller);
  assert.equal(screen.queryByTestId("forwarded-bundle-image-shadow-left"), null);
  const rightShadow = screen.getByTestId("forwarded-bundle-image-shadow-right");
  assert.match(rightShadow.className, /\bshadow-overflow-cue-right\b/);
  assert.doesNotMatch(rightShadow.className, /\bshadow-brutal/);
  assert.doesNotMatch(rightShadow.className, /gradient|from-white|to-transparent/);

  scroller.scrollLeft = 50;
  fireEvent.scroll(scroller);
  assert.match(screen.getByTestId("forwarded-bundle-image-shadow-left").className, /\bshadow-overflow-cue-left\b/);
  assert.ok(screen.getByTestId("forwarded-bundle-image-shadow-right"));

  scroller.scrollLeft = 100;
  fireEvent.scroll(scroller);
  assert.ok(screen.getByTestId("forwarded-bundle-image-shadow-left"));
  assert.equal(screen.queryByTestId("forwarded-bundle-image-shadow-right"), null);

  fireEvent.click(screen.getByRole("button", { name: "Open two.png" }));
  assert.deepEqual(opened, ["image-2"]);
});

test("Forward composer preview renders projected images without making them interactive", async () => {
  const batchedIds: string[] = [];
  api.post = (async (url: string, body: { attachmentIds: string[] }) => {
    assert.equal(url, "/attachments/urls");
    batchedIds.push(...body.attachmentIds);
    return { data: { urls: body.attachmentIds.map((id) => ({ id, url: `https://preview.test/${id}.jpg`, expiresAt: null })) } };
  }) as unknown as typeof api.post;

  render(
    <TestIntlProvider>
      <ForwardedBundleCard metadata={metadata()} />
    </TestIntlProvider>,
  );

  await waitFor(() => {
    assert.equal(document.querySelectorAll('[data-testid="forwarded-bundle-image"] img').length, 4);
  });
  assert.equal(batchedIds.length, 4, "composer preview must resolve every projected image preview");
  assert.equal(
    screen.queryByRole("button", { name: "Open one.jpg" }),
    null,
    "composer preview image is visual-only until the message has destination attachment authority",
  );
  assert.ok(screen.getByTestId("forwarded-bundle-file-chips").textContent?.includes("notes.txt"));
});

test("Forward bundle items stay divider-free", () => {
  const second = {
    ...metadata().forwardedItems![0]!,
    sourceMessageId: "source-message-2",
    sourceCreatedAt: "2026-07-30T12:01:00.000Z",
    contentSnapshot: "Second forwarded item",
    attachmentSnapshots: [],
  };

  render(
    <TestIntlProvider>
      <ForwardedBundleCard
        metadata={{ ...metadata(), forwardedItems: [metadata().forwardedItems![0]!, second] }}
      />
    </TestIntlProvider>,
  );

  const items = screen.getAllByTestId("forwarded-bundle-item");
  assert.equal(items.length, 2);
  assert.equal(items[0]?.nextElementSibling, items[1]);
  assert.doesNotMatch(items[0]?.parentElement?.className ?? "", /\bdivide-y\b/);
  assert.doesNotMatch(items[1]?.className ?? "", /\bborder-t\b/);
});

test("Forwarded bundle content wraps long unbroken text inside the card", () => {
  render(
    <TestIntlProvider>
      <ForwardedBundleCard
        metadata={{
          kind: "forwarded-bundle",
          version: 1,
          forwardedItems: [{
            sourceMessageId: "long-content",
            contentSnapshot: "ThreadForwardFlow/".repeat(40),
          }],
        }}
      />
    </TestIntlProvider>,
  );

  const content = screen.getByTestId("forwarded-bundle-content");
  assert.match(content.className, /\bmin-w-0\b/);
  assert.match(content.className, /\bmax-w-full\b/);
  assert.match(content.className, /\bbreak-words\b/);
  assert.doesNotMatch(content.className, /overflow-wrap/);
});

test("Forward composer can expand its preview card to the full pane width", () => {
  render(
    <TestIntlProvider>
      <ForwardedBundleCard metadata={metadata()} fullWidth />
    </TestIntlProvider>,
  );

  const card = screen.getByTestId("forwarded-bundle-card");
  assert.match(card.className, /\bw-full\b/);
  assert.match(card.className, /\bmax-w-none\b/);
  assert.doesNotMatch(card.className, /max-w-\[min\(34rem,100%\)\]/);
});

test("Forward overflow cues keep contrast against both light and dark images", () => {
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  for (const direction of ["left", "right"]) {
    const token = css.match(new RegExp(`--shadow-overflow-cue-${direction}:[\\s\\S]*?;`))?.[0] ?? "";
    assert.match(token, /rgb\(255 255 255 \/ 92%\)/, `${direction} cue needs a light edge for dark images`);
    assert.match(token, /rgb\(20 17 17 \/ 60%\)/, `${direction} cue needs a dark edge for light images`);
  }
});
