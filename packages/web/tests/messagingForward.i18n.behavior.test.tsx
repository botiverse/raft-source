import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { createIntl } from "react-intl";

import ForwardedBundleCard from "../src/components/message/ForwardedBundleCard";
import {
  formatCopyLinksToast,
  formatForwardSentToast,
  getForwardDisabledReason,
} from "../src/components/message/forwardSelectionUtils";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

afterEach(cleanup);

test("catalog pins messaging-forward MessageIds", () => {
  assert.equal(en["message.forward.badge"], "Forwarded");
  assert.match(en["message.forward.bundleCount"], /\{count, plural,/);
  assert.equal(en["message.forward.openSource"], "Open source message");
  assert.equal(
    en["message.forward.unsupportedSource"],
    "Forwarding from this source is not supported",
  );
  assert.match(en["message.forward.linkCopied"], /\{count, plural,/);
  assert.match(en["message.forward.sentToast"], /\{destination\}/);
  assert.match(zh["message.forward.badge"], /\p{Script=Han}/u);
  assert.match(zh["message.forward.sentToast"], /\{destination\}/);
});

test("forwardSelectionUtils formatters accept formatMessage and localize zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  const fm = zhIntl.formatMessage;
  assert.match(formatCopyLinksToast(1, fm), /\p{Script=Han}/u);
  assert.doesNotMatch(formatCopyLinksToast(1, fm), /Link copied/);
  assert.match(formatForwardSentToast({ type: "dm", name: "alice" }, fm), /\p{Script=Han}/u);
  assert.match(formatForwardSentToast({ type: "dm", name: "alice" }, fm), /私信/);
  assert.equal(
    getForwardDisabledReason(null, fm),
    zh["message.forward.unsupportedSource"],
  );
});

test("ForwardedBundleCard renders its badge and source action from zh-cn", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <ForwardedBundleCard
        metadata={{
          kind: "forwarded-bundle",
          forwardedItems: [{
            sourceMessageId: "source-message-1",
            sourceTargetId: "source-channel-1",
            sourceAuthorSnapshot: { type: "user", name: "Sender" },
            sourceCreatedAt: "2026-08-19T12:00:00.000Z",
            sourceTargetSnapshot: {
              id: "source-channel-1",
              type: "channel",
              label: "产品讨论",
              labelVisibility: "public",
            },
            contentSnapshot: "转发内容",
            attachmentSnapshots: [],
            provenanceState: "available",
          }],
        }}
        onOpenSource={() => {}}
      />
    </TestIntlProvider>,
  );

  assert.ok(screen.getByText(zh["message.forward.badge"]));
  assert.ok(screen.getByRole("button", { name: zh["message.forward.openSource"] }));
  assert.doesNotMatch(document.body.textContent ?? "", /Forwarded|Open source message/);
});
