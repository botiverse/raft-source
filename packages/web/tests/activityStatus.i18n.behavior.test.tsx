import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import {
  formatActivityText,
  getActivityText,
  getActivityTextDescriptor,
} from "../src/utils/activity";
import { resolveAgentDisplayState } from "../src/store/agentStore";
import { agentFallbackLabel } from "../src/utils/liveAgentActivity";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";

// activity-status batch (Task 8): MessageId producers for status prose + Agent/Stopped fallbacks.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

test("catalog pins activity-status MessageIds used by producers", () => {
  assert.equal(en["activity.status.online"], "Online");
  assert.equal(en["activity.status.thinkingEllipsis"], "Thinking…");
  assert.equal(en["activity.status.workingEllipsis"], "Working…");
  assert.equal(en["activity.status.startingEllipsis"], "Starting…");
  assert.equal(en["activity.status.compactingContextEllipsis"], "Compacting context…");
  assert.equal(en["activity.status.error"], "Error");
  assert.equal(en["activity.status.offline"], "Offline");
  assert.equal(
    en["activity.status.stoppedUnavailable"],
    "Stopped — won't receive messages until restarted",
  );
  assert.equal(en["activity.log.status.stopped"], "Stopped");
  assert.equal(en["activity.live.agentFallback"], "Agent");
  for (const id of [
    "activity.status.online",
    "activity.status.thinkingEllipsis",
    "activity.status.workingEllipsis",
    "activity.status.startingEllipsis",
    "activity.status.compactingContextEllipsis",
    "activity.status.error",
    "activity.status.offline",
    "activity.status.stoppedUnavailable",
    "activity.log.status.stopped",
  ] as const) {
    assert.match(zh[id], /\p{Script=Han}/u, `${id} missing Chinese`);
  }
});

test("getActivityText falls back to English catalog without return-prose literals", () => {
  assert.equal(getActivityText("online"), en["activity.status.online"]);
  assert.equal(getActivityText("thinking"), en["activity.status.thinkingEllipsis"]);
  assert.equal(getActivityText("working"), en["activity.status.workingEllipsis"]);
  assert.equal(getActivityText("error"), en["activity.status.error"]);
  assert.equal(getActivityText("offline"), en["activity.status.offline"]);
  assert.equal(
    getActivityText("offline", "Stopped", "stopped"),
    en["activity.status.stoppedUnavailable"],
  );
});

test("formatActivityText renders zh-cn status copy", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(formatActivityText(zhIntl.formatMessage, "thinking"), zh["activity.status.thinkingEllipsis"]);
  assert.equal(formatActivityText(zhIntl.formatMessage, "working"), zh["activity.status.workingEllipsis"]);
  assert.equal(
    formatActivityText(zhIntl.formatMessage, "offline", "Stopped", "stopped"),
    zh["activity.status.stoppedUnavailable"],
  );
  assert.deepEqual(getActivityTextDescriptor("online"), {
    primary: { id: "activity.status.online" },
  });
});

test("agent fallback and stopped display state execute catalog-backed behavior", () => {
  assert.equal(agentFallbackLabel(), en["activity.live.agentFallback"]);
  assert.deepEqual(resolveAgentDisplayState({ status: "stopped" }, null), {
    activity: "offline",
    activityDetail: en["activity.log.status.stopped"],
    activityDetailKind: "stopped",
    activityText: en["activity.status.stoppedUnavailable"],
    isOnline: false,
  });
});
