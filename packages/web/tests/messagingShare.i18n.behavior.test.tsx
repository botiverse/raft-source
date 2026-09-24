import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createIntl } from "react-intl";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import SelectShareLightbox from "../src/components/message/SelectShareLightbox";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const DATA_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Av5NAAAAAElFTkSuQmCC";

afterEach(() => cleanup());

test("catalog pins select-share MessageIds with Chinese", () => {
  assert.equal(en["message.selectShare.title"], "Share preview");
  assert.equal(en["message.selectShare.alt"], "Selected messages screenshot preview");
  assert.equal(en["message.selectShare.copyImage"], "Copy image");
  assert.equal(en["message.selectShare.copying"], "Copying…");
  assert.equal(en["message.selectShare.copied"], "Copied");
  assert.equal(en["message.selectShare.saveImage"], "Save Image");
  assert.equal(en["message.selectShare.saving"], "Saving…");
  assert.equal(en["message.selectShare.shareToX"], "Share to X");
  assert.equal(en["message.selectShare.sharing"], "Sharing…");
  assert.equal(en["message.selectShare.nativeShareTitle"], "Raft share image");
  assert.match(zh["message.selectShare.title"], /\p{Script=Han}/u);
  assert.match(zh["message.selectShare.copyImage"], /\p{Script=Han}/u);
  assert.notEqual(zh["message.selectShare.title"], en["message.selectShare.title"]);
});

test("select-share ids format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(zhIntl.formatMessage({ id: "message.selectShare.title" }), zh["message.selectShare.title"]);
  assert.doesNotMatch(zhIntl.formatMessage({ id: "message.selectShare.copyImage" }), /Copy image/);
});

test("SelectShareLightbox renders its real preview actions in zh-cn", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <SelectShareLightbox
        dataUrl={DATA_IMAGE}
        onClose={() => undefined}
        onShareToX={async () => undefined}
      />
    </TestIntlProvider>,
  );

  assert.equal(screen.getByRole("heading").textContent, zh["message.selectShare.title"]);
  assert.equal(
    screen.getByRole("img").getAttribute("alt"),
    zh["message.selectShare.alt"],
  );
  assert.equal(
    screen.getByTestId("select-share-lightbox-download").textContent?.trim(),
    zh["common.lightbox.download"],
  );
  assert.equal(
    screen.getByTestId("select-share-lightbox-share-x").textContent?.trim(),
    zh["message.selectShare.shareToX"],
  );
});
