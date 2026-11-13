import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { loadLocaleMessages, mergedMessages } from "../src/i18n/messages/index";
import { formatActivityTextDescriptor, formatSpawnFailureDetail, getActivityTextDescriptor } from "../src/utils/activity";
import { useAgentStore } from "../src/store/agentStore";

// task #1123 — the web must carry the daemon's typed spawn-failure reason and
// must not collapse a failed start into a bare "Offline".

test("offline + runtime_unavailable keeps the daemon's detail in the activity text", () => {
  const descriptor = getActivityTextDescriptor("offline", "Runtime start failed: model not found", "runtime_unavailable");
  assert.deepEqual(descriptor.primary, { raw: "Runtime start failed: model not found" });
  // A plain stop still uses the catalog copy.
  const stopped = getActivityTextDescriptor("offline", "", "stopped");
  assert.equal((stopped.primary as { id: string }).id, "activity.status.stoppedUnavailable");
});

test("model_not_found has dedicated copy in both catalogs that names the model", () => {
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    const text = formatActivityTextDescriptor(intl.formatMessage, {
      primary: { id: "activity.status.modelNotFound", values: { model: "claude-opus-5" } },
    });
    assert.ok(text.includes("claude-opus-5"), `${locale}: ${text}`);
    assert.ok(!text.includes("activity.status."), `${locale} copy must resolve`);
  }
});

test("the store keeps the spawnFailure carrier next to the activity state and clears it on the next plain activity", () => {
  const store = useAgentStore.getState();
  store.updateActivity(
    "agent-sf",
    "offline",
    "Runtime start failed",
    10,
    500,
    { launchId: "launch-1", clientSeq: 1 },
    "offline",
    "runtime_unavailable",
    { clientEventId: "evt-sf-1" },
    false,
    false,
    undefined,
    undefined,
    { reason: "model_not_found", model: "claude-opus-5" },
  );
  const state = useAgentStore.getState().agentActivities["agent-sf"];
  assert.equal(state?.detailKind, "runtime_unavailable");
  assert.deepEqual(state?.spawnFailure, { reason: "model_not_found", model: "claude-opus-5" });

  useAgentStore.getState().updateActivity("agent-sf", "working", "Running command", 11, 600, { launchId: "launch-2", clientSeq: 1 }, "working", "running_command");
  assert.equal(useAgentStore.getState().agentActivities["agent-sf"]?.spawnFailure, undefined, "a later plain activity drops the carrier");
});

test("a paused agent's failed start says restarts are paused and how to lift it, in both catalogs", () => {
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    const modelPaused = formatSpawnFailureDetail(intl.formatMessage, { reason: "model_not_found", model: "deepseek/deepseek-v4-flash", autoRestartPaused: true }, "daemon text");
    assert.ok(modelPaused?.includes("deepseek/deepseek-v4-flash"), `${locale}: ${modelPaused}`);
    assert.ok(modelPaused?.includes(locale === "en" ? "automatic restarts are paused" : "已暂停自动重启"), `${locale}: ${modelPaused}`);
    const genericPaused = formatSpawnFailureDetail(intl.formatMessage, { reason: "runtime_spawn_failed", autoRestartPaused: true }, "Runtime failed to start.");
    assert.ok(genericPaused?.startsWith("Runtime failed to start."), "other reasons keep the daemon's message, plus the pause");
    assert.ok(!modelPaused?.includes("activity.status.") && !genericPaused?.includes("activity.status."), `${locale} copy must resolve`);
  }
  const intl = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") });
  assert.equal(formatSpawnFailureDetail(intl.formatMessage, { reason: "runtime_spawn_failed" }, "x"), null, "not paused, no own copy: keep the daemon detail");
  assert.equal(formatSpawnFailureDetail(intl.formatMessage, undefined, "x"), null);
});

test("a start paused because the computer lacks the runtime points to the runtime, never to the model or a restart", () => {
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    const text = formatSpawnFailureDetail(intl.formatMessage, { reason: "runtime_not_found", autoRestartPaused: true }, "Runtime executable not found.");
    assert.ok(text?.startsWith("Runtime executable not found."), `${locale}: ${text}`);
    assert.ok(text.includes(locale === "en" ? "automatic wakes are paused until the runtime is available" : "已暂停自动唤醒"), `${locale}: ${text}`);
    assert.ok(!text.includes(locale === "en" ? "API key" : "API 密钥") && !text.includes("activity.status."), `${locale}: ${text}`);
  }
  const intl = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") });
  assert.equal(formatSpawnFailureDetail(intl.formatMessage, { reason: "runtime_not_found" }, "x"), null, "not paused: keep the daemon detail");
});

test("a start-timeout pause says Raft tries again by itself and how to resume now, in every catalog", async () => {
  const expected = {
    en: "automatic wakes are paused; Raft tries again by itself later",
    "zh-cn": "Raft 稍后会自动重试",
    "zh-tw": "Raft 稍後會自動重試",
    ja: "Raft が後で自動的に再試行します",
    ko: "Raft가 잠시 후 자동으로 다시 시도해요",
    es: "Raft volverá a intentarlo por sí solo más tarde",
    "pt-br": "o Raft tenta de novo sozinho mais tarde",
  } as const;
  const daemonText = "OpenCode did not finish starting within 2 minutes.";
  for (const [locale, phrase] of Object.entries(expected) as Array<[keyof typeof expected, string]>) {
    await loadLocaleMessages(locale);
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    const text = formatSpawnFailureDetail(intl.formatMessage, { reason: "runtime_start_timeout", model: "opencode/x-free", autoRestartPaused: true }, daemonText);
    assert.ok(text?.startsWith(daemonText), `${locale}: ${text}`);
    assert.ok(text.includes(phrase), `${locale}: ${text}`);
  }
  const intl = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") });
  assert.equal(formatSpawnFailureDetail(intl.formatMessage, { reason: "runtime_start_timeout" }, daemonText), null, "not paused: keep the daemon detail");
});

test("task #10 / C8: session_needs_reset has its own copy, true whether compaction or a new session failed, never 'restart the agent'", () => {
  const expected = {
    en: "The context is too large and shrinking it automatically didn't fix it. Reset the session and restart; if one message is itself very large, switch to a model with a larger context or split the content.",
    "zh-cn": "上下文太大，自动缩减没能解决。可以重置会话后重启；如果某条消息本身很大，换一个上下文更大的模型，或把内容拆小。",
  } as const;
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    for (const autoRestartPaused of [true, false]) {
      assert.equal(formatSpawnFailureDetail(intl.formatMessage, { reason: "session_needs_reset", autoRestartPaused }, "daemon text"), expected[locale], `${locale}, paused=${autoRestartPaused}`);
    }
  }
});

// task #1307: a malformed provider API key gets its own copy, chosen by reason
// in the viewer's locale, whether or not automatic restarts are paused. It
// never shows the daemon's raw text.
test("provider_api_key_invalid shows Cat's copy in en, zh-cn and zh-tw, paused or not", () => {
  const expected = {
    en: "Couldn't start: there's a problem with the API key. Copy the full key again from your provider's dashboard, save, and retry.",
    "zh-cn": "无法启动：API 密钥有问题。请从提供方控制台重新完整复制密钥，保存后重试。",
    "zh-tw": "無法啟動：API 金鑰有問題。請從提供方控制台重新完整複製金鑰，儲存後再試一次。",
  } as const;
  for (const locale of ["en", "zh-cn", "zh-tw"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    for (const autoRestartPaused of [false, true]) {
      const text = formatSpawnFailureDetail(
        intl.formatMessage,
        { reason: "provider_api_key_invalid", ...(autoRestartPaused ? { autoRestartPaused } : {}) },
        "raw daemon detail",
      );
      assert.equal(text, expected[locale], `${locale}, paused=${autoRestartPaused}`);
    }
  }
  // The other locales show their catalog's copy (the English until it is translated), never the raw detail.
  for (const locale of ["ja", "ko", "es", "pt-br"] as const) {
    const messages = mergedMessages(locale);
    const intl = createIntl({ locale, defaultLocale: "en", messages });
    const text = formatSpawnFailureDetail(intl.formatMessage, { reason: "provider_api_key_invalid" }, "raw daemon detail");
    assert.equal(text, messages["activity.status.providerApiKeyInvalid"], locale);
    assert.ok(!text.includes("raw daemon detail"), locale);
  }
});

// Reconciler step 12: the runtime started and cannot use the agent's model.
// A person has to act, so the copy names the model and the way out, says
// nothing about retrying, and never shows the daemon's text.
test("model_unsupported has its own copy in en and zh-cn that names the model, paused or not", () => {
  const expected = {
    en: {
      model: "This runtime's account or plan doesn't include \"gpt-x\". Change the model, or sign in with an account that includes it",
      none: "This runtime's account or plan doesn't include this agent's model. Change the model, or sign in with an account that includes it",
    },
    "zh-cn": {
      model: "这个运行时的账号或套餐不包含模型「gpt-x」。请更换模型，或登录包含该模型的账号",
      none: "这个运行时的账号或套餐不包含这个 Agent 的模型。请更换模型，或登录包含该模型的账号",
    },
  } as const;
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    for (const autoRestartPaused of [false, true]) {
      assert.equal(formatSpawnFailureDetail(intl.formatMessage, { reason: "model_unsupported", model: "gpt-x", autoRestartPaused }, "raw daemon detail"), expected[locale].model, `${locale}, paused=${autoRestartPaused}`);
      assert.equal(formatSpawnFailureDetail(intl.formatMessage, { reason: "model_unsupported", autoRestartPaused }, "raw daemon detail"), expected[locale].none, `${locale}, paused=${autoRestartPaused}`);
    }
  }
});

// Reconciler step 12: the runtime kept failing the same way after it started;
// the server pauses and tries again by itself, telling no one, so the status
// says so and how to try now.
test("runtime_repeated_failure says automatic wakes are paused, Raft tries again by itself, and how to try now", () => {
  const expected = {
    en: "Kept failing the same way after starting — automatic wakes are paused; Raft tries again by itself later. Restart the agent to try now",
    "zh-cn": "启动后多次以同样的方式失败——已暂停自动唤醒，Raft 稍后会自动重试；重启 Agent 可立即重试",
  } as const;
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    for (const autoRestartPaused of [false, true]) {
      assert.equal(formatSpawnFailureDetail(intl.formatMessage, { reason: "runtime_repeated_failure", autoRestartPaused }, "raw daemon detail"), expected[locale], `${locale}, paused=${autoRestartPaused}`);
    }
  }
});

// The server sends when a self-retrying pause tries next (`pauseRetryAtMs`):
// the copy says that time instead of "later", the clock alone today and the
// date and clock on another day, in the viewer's time zone and 12h/24h choice.
describe("a self-retrying pause says when Raft tries next once the server sends the time", () => {
  const now = new Date("2026-11-07T10:00:00.000Z");
  const today = Date.parse("2026-11-07T10:30:00.000Z");
  const tomorrow = Date.parse("2026-11-08T03:30:00.000Z");
  const timeOptions = (locale: string) => ({ locale, timeZone: "UTC", timeFormat: "24h" as const, now });

  test("runtime_repeated_failure, en and zh-cn: the time today, the date and time on another day, the current copy without one", () => {
    const expected = {
      en: {
        today: "Kept failing the same way after starting — automatic wakes are paused; Raft tries again by itself at 10:30. Restart the agent to try now",
        tomorrow: "Kept failing the same way after starting — automatic wakes are paused; Raft tries again by itself at Nov 8, 03:30. Restart the agent to try now",
        none: "Kept failing the same way after starting — automatic wakes are paused; Raft tries again by itself later. Restart the agent to try now",
      },
      "zh-cn": {
        today: "启动后多次以同样的方式失败——已暂停自动唤醒，Raft 会在 10:30 自动重试；重启 Agent 可立即重试",
        tomorrow: "启动后多次以同样的方式失败——已暂停自动唤醒，Raft 会在 11月8日 03:30 自动重试；重启 Agent 可立即重试",
        none: "启动后多次以同样的方式失败——已暂停自动唤醒，Raft 稍后会自动重试；重启 Agent 可立即重试",
      },
    } as const;
    for (const locale of ["en", "zh-cn"] as const) {
      const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
      const format = (pauseRetryAtMs?: number) => formatSpawnFailureDetail(intl.formatMessage, { reason: "runtime_repeated_failure", autoRestartPaused: true, ...(pauseRetryAtMs === undefined ? {} : { pauseRetryAtMs }) }, "raw", timeOptions(locale));
      assert.equal(format(today), expected[locale].today, locale);
      assert.equal(format(tomorrow), expected[locale].tomorrow, locale);
      assert.equal(format(undefined), expected[locale].none, locale);
      assert.equal(format(now.getTime() - 1), expected[locale].none, `${locale}: a time already passed reads "later"`);
    }
  });

  test("runtime_start_timeout, en and zh-cn: the same, after the daemon's detail", () => {
    const daemonText = "OpenCode did not finish starting within 2 minutes.";
    const expected = {
      en: {
        today: `${daemonText} — automatic wakes are paused; Raft tries again by itself at 10:30. Restart the agent or switch its model to resume now`,
        none: `${daemonText} — automatic wakes are paused; Raft tries again by itself later. Restart the agent or switch its model to resume now`,
      },
      "zh-cn": {
        today: `${daemonText}——已暂停自动唤醒，Raft 会在 10:30 自动重试；重启 Agent 或换一个模型可立即恢复`,
        none: `${daemonText}——已暂停自动唤醒，Raft 稍后会自动重试；重启 Agent 或换一个模型可立即恢复`,
      },
    } as const;
    for (const locale of ["en", "zh-cn"] as const) {
      const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
      const format = (pauseRetryAtMs?: number) => formatSpawnFailureDetail(intl.formatMessage, { reason: "runtime_start_timeout", autoRestartPaused: true, ...(pauseRetryAtMs === undefined ? {} : { pauseRetryAtMs }) }, daemonText, timeOptions(locale));
      assert.equal(format(today), expected[locale].today, locale);
      assert.equal(format(undefined), expected[locale].none, locale);
    }
  });
});
