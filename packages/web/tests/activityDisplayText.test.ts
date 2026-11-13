import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { mergedMessages } from "../src/i18n/messages/index";
import { getActivityErrorDisplayDetail, getActivityText, getActivityTextDescriptor, formatActivityTextDescriptor } from "../src/utils/activity";

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

test("RFC 071 §9: a terminal-failure pause shows the server's detail (until when, why), not a bare Offline", () => {
  const enIntl = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") });
  const detail = "Automatic wake paused until 2026-10-02T13:00:00.000Z after repeated runtime failures (compaction_failed). The next message, reminder or manual start after that retries; a manual start lifts it now.";
  assert.equal(
    formatActivityTextDescriptor(enIntl.formatMessage, getActivityTextDescriptor("offline", detail, "terminal_failure_paused")),
    detail,
  );
  // Without a detail, the catalog copy (never a bare "Offline").
  const zhIntl = createIntl({ locale: "zh-cn", defaultLocale: "en", messages: mergedMessages("zh-cn") });
  assert.equal(
    formatActivityTextDescriptor(zhIntl.formatMessage, getActivityTextDescriptor("offline", "", "terminal_failure_paused")),
    "运行时连续失败，自动唤醒已暂停——手动启动可解除",
  );
});

test("Claude root crash guidance is localized instead of collapsed to Offline", () => {
  const detail = "Display wording changed without changing the diagnostic code";
  const descriptor = getActivityTextDescriptor("offline", detail, "claude_root_privileges");
  const intl = createIntl({ locale: "zh-CN", messages: mergedMessages("zh-cn") });
  assert.match(formatActivityTextDescriptor(intl.formatMessage, descriptor), /非 root 用户/);
});
