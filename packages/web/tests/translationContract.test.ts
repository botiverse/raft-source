import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import api from "../src/api/client";
import { useTranslationBatch } from "../src/hooks/useTranslationBatch";
import { useAuthStore } from "../src/store/authStore";
import type { Message } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import {
  TRANSLATION_LANGUAGE_OPTIONS,
  detectBrowserLanguage,
  formatTimezoneLabel,
  getTimezoneOptions,
  getTranslationLanguageOptions,
  isSilentTranslationEntry,
  normalizeTranslationLanguageCode,
  useTranslationStore,
} from "../src/store/translationStore";
import { shouldHideTranslationIndicator } from "../src/utils/translationContract.js";

const originalGet = api.get;

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, value);
  }

  removeItem(key: string) {
    this.map.delete(key);
  }
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useTranslationStore.setState(useTranslationStore.getInitialState(), true);
});

test("silent skip reasons do not render a translation indicator", () => {
  for (const reason of ["same_language", "own_message", "system_message", "code_or_link_only", "low_confidence"]) {
    assert.equal(shouldHideTranslationIndicator("skipped", reason), true);
    assert.equal(isSilentTranslationEntry({ messageId: "m", status: "skipped", reason }), true);
  }
  assert.equal(shouldHideTranslationIndicator("not_found", "not_found"), true);
});

test("quota and provider failures remain visible translation states", () => {
  assert.equal(shouldHideTranslationIndicator("skipped", "server_disabled"), false);
  assert.equal(shouldHideTranslationIndicator("skipped", "user_quota_exceeded"), false);
  assert.equal(shouldHideTranslationIndicator("failed", "provider"), false);
  assert.equal(shouldHideTranslationIndicator("failed", "provider_timeout"), false);
  assert.equal(shouldHideTranslationIndicator("failed", "placeholder"), false);
  assert.equal(shouldHideTranslationIndicator("translated", null), false);
});

test("translation language and timezone options execute the normalized API contract", () => {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
  });

  assert.equal(normalizeTranslationLanguageCode("zh-CN"), "zh-cn");
  assert.equal(normalizeTranslationLanguageCode("zh-TW"), "zh-tw");
  assert.equal(normalizeTranslationLanguageCode("zh-Hans"), "zh-cn");
  assert.equal(normalizeTranslationLanguageCode("zh-Hant"), "zh-tw");
  assert.equal(normalizeTranslationLanguageCode("pt-BR"), "pt-br");
  assert.equal(normalizeTranslationLanguageCode("it-IT"), "it");
  assert.equal(normalizeTranslationLanguageCode("en-US"), "en");

  const optionValues = new Set(TRANSLATION_LANGUAGE_OPTIONS.map((option) => option.value));
  assert.deepEqual(
    ["browser", "en", "zh-cn", "zh-tw", "pt-br", "it"].map((value) => optionValues.has(value)),
    [true, true, true, true, true, true],
  );

  const identityFormat = ((desc: { id: string }) => {
    if (desc.id === "settings.language.browserLanguage") return "Browser language";
    if (desc.id === "settings.language.selectTimezone") return "Select timezone";
    return desc.id;
  }) as never;

  assert.deepEqual(getTranslationLanguageOptions("en", identityFormat).map((option) => option.label), [
    "Browser language",
    "English",
    "Simplified Chinese",
    "Traditional Chinese",
    "Japanese",
    "Korean",
    "Spanish",
    "French",
    "German",
    "Portuguese (Brazil)",
    "Italian",
  ]);
  assert.match(formatTimezoneLabel("Asia/Shanghai"), /^UTC\+08:00 Asia\/Shanghai$/);
  assert.equal(getTimezoneOptions("Asia/Shanghai", identityFormat)[0].label, "UTC+08:00 Asia/Shanghai");
  assert.equal(getTimezoneOptions("America/Indiana/Indianapolis", identityFormat).some((option) => option.value === "America/Indiana/Indianapolis"), true);
  assert.equal(getTimezoneOptions("Asia/Shanghai", identityFormat).length < 50, true);
});

test("browser language resolves the first supported translation target", () => {
  Object.defineProperty(globalThis, "navigator", {
    value: { languages: ["zh-CN"], language: "zh-CN" },
    configurable: true,
  });
  assert.equal(detectBrowserLanguage(), "zh-cn");

  Object.defineProperty(globalThis, "navigator", {
    value: { languages: ["en-US"], language: "en-US" },
    configurable: true,
  });
  assert.equal(detectBrowserLanguage(), "en");
});

function TranslationBatchProbe({ messages }: { messages: Message[] }) {
  useTranslationBatch(messages);
  return null;
}

test("manual mode never auto-requests; switching to auto requests the live message batch", async () => {
  const initial = useTranslationStore.getInitialState();
  const loads: Array<string | null | undefined> = [];
  const requests: Array<{ messages: Message[]; options: unknown }> = [];
  const message = {
    id: "message-1",
    channelId: "channel-1",
    senderType: "user",
    senderId: "sender-1",
    senderName: "Sender",
    messageType: "chat",
    content: "Hola",
    createdAt: "2026-08-22T00:00:00.000Z",
  } as Message;

  useAuthStore.setState({ user: { id: "viewer-1" } } as never);
  useServerStore.setState({ current: { id: "server-1" } } as never);
  useTranslationStore.setState({
    ...initial,
    settings: {
      ...initial.settings,
      available: true,
      effectiveLanguage: "en",
      preferredTranslationMode: "manual",
    },
    loadSettings: async (serverId) => { loads.push(serverId); },
    requestTranslations: async (messages, options) => { requests.push({ messages, options }); },
  } as never, true);

  render(createElement(TranslationBatchProbe, { messages: [message] }));
  await waitFor(() => assert.deepEqual(loads, ["server-1"]));
  assert.equal(requests.length, 0, "manual mode leaves translation user-triggered");

  act(() => {
    useTranslationStore.setState((state) => ({
      settings: { ...state.settings, preferredTranslationMode: "auto" },
    }));
  });
  await waitFor(() => assert.equal(requests.length, 1));
  assert.deepEqual(requests[0].messages, [message]);
  assert.deepEqual(requests[0].options, { targetLanguage: "en", viewerUserId: "viewer-1" });
});

test("new users default off while the settings loader preserves the legacy auto fallback", async () => {
  assert.equal(useTranslationStore.getInitialState().settings.preferredTranslationMode, "off");
  assert.equal(useTranslationStore.getInitialState().settings.autoTranslationEnabled, false);

  api.get = (async (url: string) => {
    if (url === "/auth/me") {
      return { data: { id: "legacy-user", preferredTranslationMode: null, autoTranslationEnabled: true } };
    }
    if (url === "/servers/server-1/translation-settings") {
      return { data: { translationEnabled: true, translationAvailable: true } };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;

  await useTranslationStore.getState().loadSettings("server-1");
  assert.equal(useTranslationStore.getState().settings.preferredTranslationMode, "auto");
  assert.equal(useTranslationStore.getState().settings.autoTranslationEnabled, true);
});
