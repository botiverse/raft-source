import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { createIntl } from "react-intl";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import ImageLightbox from "../src/components/ImageLightbox";
import { useImageLightboxStore } from "../src/store/imageLightboxStore";
import api from "../src/api/client";
import { renderWithIntl } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const DATA_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const originalGet = api.get;

afterEach(() => {
  api.get = originalGet;
  cleanup();
  act(() => {
    useImageLightboxStore.getState().close();
  });
});

test("lightbox ids format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(zhIntl.formatMessage({ id: "common.lightbox.comments" }), zh["common.lightbox.comments"]);
  assert.doesNotMatch(zhIntl.formatMessage({ id: "common.lightbox.failedToLoad" }), /Failed to load/);
});

test("ImageLightbox renders localized chrome and failure copy under zh-cn", async () => {
  api.get = (async (url: string) => {
    if (url === "/attachments/localized-current/comments") {
      return {
        data: {
          comments: [],
          threadChannelId: null,
          viewer: { canComment: false, reason: "read_only" },
        },
      };
    }
    if (url === "/channels/channel-id/members") {
      return { data: { agents: [], humans: [] } };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  act(() => {
    useImageLightboxStore.getState().open(
      [
        {
          id: "localized-current",
          filename: "当前图片.png",
          mimeType: "image/svg+xml",
          sizeBytes: 1,
          commentCount: 3,
        },
        {
          id: "localized-next",
          filename: "下一张.png",
          mimeType: "image/png",
          sizeBytes: 1,
          directUrl: DATA_IMAGE,
        },
      ],
      0,
      {
        "localized-current": {
          parentMessage: {
            id: "parent-message",
            channelId: "channel-id",
            senderId: "sender-id",
            senderType: "human",
          },
        },
      },
    );
  });

  renderWithIntl(
    <MemoryRouter>
      <ImageLightbox />
    </MemoryRouter>,
    { locale: "zh-cn" },
  );

  const download = screen.getByRole("button", { name: zh["common.lightbox.download"] });
  const previous = screen.getByRole("button", { name: zh["common.lightbox.previousImage"] });
  const next = screen.getByRole("button", { name: zh["common.lightbox.nextImage"] });
  const comments = screen.getByTitle(zh["common.lightbox.comments"]);
  assert.ok(download);
  assert.ok(previous);
  assert.ok(next);
  assert.equal(comments.textContent, "", "comments control is icon-only");
  assert.equal(comments.getAttribute("aria-pressed"), "false");
  assert.equal(comments.getAttribute("data-comments-open"), "false");
  assert.ok(comments.querySelector("svg"), "comments control should render its Lucide icon");

  fireEvent.click(comments);
  await waitFor(() => {
    assert.equal(comments.getAttribute("title"), zh["common.lightbox.hideComments"]);
    assert.equal(comments.getAttribute("aria-pressed"), "true");
    assert.equal(comments.getAttribute("data-comments-open"), "true");
  });
  assert.ok(screen.getByText(zh["common.lightbox.failedToLoad"]));
  assert.equal(screen.queryByText(en["common.lightbox.failedToLoad"]), null);
});
