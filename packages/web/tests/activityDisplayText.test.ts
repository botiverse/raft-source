import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";
import { mergedMessages } from "../src/i18n/messages/index.js";
import { getActivityErrorDisplayDetail, getActivityText, getActivityTextDescriptor, formatActivityTextDescriptor } from "../src/utils/activity.js";

test("agent activity errors display JSON payload messages instead of raw JSON", () => {
  const raw = JSON.stringify({
    type: "error",
    status: 400,
    error: {
      type: "invalid_request_error",
      message: "The gpt-5.5 model requires a newer version of Codex.",
    },
  });

  assert.equal(
    getActivityErrorDisplayDetail(raw),
    "The gpt-5.5 model requires a newer version of Codex.",
  );
  assert.equal(
    getActivityText("error", raw),
    "Error: The gpt-5.5 model requires a newer version of Codex.",
  );
});

test("agent activity errors keep plain text details unchanged", () => {
  assert.equal(getActivityText("error", "Runtime failed"), "Error: Runtime failed");
});

test("working+starting and compacting_context use catalog MessageIds", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(
    formatActivityTextDescriptor(
      zhIntl.formatMessage,
      getActivityTextDescriptor("working", "", "starting"),
    ),
    "启动中…",
  );
  assert.equal(
    formatActivityTextDescriptor(
      zhIntl.formatMessage,
      getActivityTextDescriptor("working", "", "compacting_context"),
    ),
    "正在压缩上下文…",
  );
});

test("agent activity descriptors format through the selected app locale", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });

  assert.equal(
    formatActivityTextDescriptor(zhIntl.formatMessage, getActivityTextDescriptor("thinking")),
    "思考中…",
  );
  assert.equal(
    formatActivityTextDescriptor(zhIntl.formatMessage, getActivityTextDescriptor("offline", "Stopped", "stopped")),
    "已停止——重启前不会接收消息",
  );
  assert.equal(
    formatActivityTextDescriptor(zhIntl.formatMessage, getActivityTextDescriptor("error", "Runtime failed")),
    "错误：Runtime failed",
  );
});
