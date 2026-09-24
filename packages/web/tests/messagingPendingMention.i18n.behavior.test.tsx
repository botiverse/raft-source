import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, screen } from "@testing-library/react";

import { PendingMentionActionStrip } from "../src/components/message/PendingMentionActionStrip";
import type { PendingMentionAction } from "../src/store/messageStore";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { renderWithIntl } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

const action: PendingMentionAction = {
  resolutionId: "res-1",
  messageId: "msg-1",
  targetType: "agent",
  targetHandle: "helper",
  targetAvatarUrl: null,
  reason: "not in channel",
  availableActions: ["add", "notify"],
};

afterEach(() => {
  cleanup();
});

test("catalog pins pending-mention action MessageIds", () => {
  assert.equal(en["message.pendingMention.add"], "Add");
  assert.equal(en["message.pendingMention.addAll"], "Add all");
  assert.equal(en["message.pendingMention.added"], "Added");
  assert.equal(en["message.pendingMention.dismiss"], "Ignore");
  assert.equal(en["message.pendingMention.notify"], "Notify");
  assert.equal(en["message.pendingMention.queued"], "Queued");
  assert.match(zh["message.pendingMention.addAll"], /\p{Script=Han}/u);
  assert.match(zh["message.pendingMention.dismiss"], /\p{Script=Han}/u);
});

test("pending-mention strip renders zh-cn action labels", () => {
  renderWithIntl(
    <PendingMentionActionStrip
      actions={[action]}
      actionState={{}}
      actionRemoving={{}}
      actionExecuting={{}}
      channelName="general"
      onMarkAction={() => {}}
      onAddAllActions={() => {}}
      onDismissAction={() => {}}
    />,
    { locale: "zh-cn" },
  );
  assert.ok(screen.getByRole("button", { name: zh["message.pendingMention.add"] }));
  assert.ok(screen.getByRole("button", { name: zh["message.pendingMention.notify"] }));
  assert.ok(screen.getByRole("button", { name: zh["message.pendingMention.dismiss"] }));
  assert.equal(screen.queryByRole("button", { name: "Add" }), null);
});
