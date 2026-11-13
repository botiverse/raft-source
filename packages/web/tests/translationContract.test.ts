import "./helpers/domSetup";

import assert from "node:assert/strict";
import { createElement } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import api from "../src/api/client";
import { useTranslationBatch } from "../src/hooks/useTranslationBatch";
import { useAuthStore } from "../src/store/authStore";
import type { Message } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import {
  FOLLOW_DISPLAY_LANGUAGE_TARGET,
  formatTimezoneLabel,
  getTimezoneOptions,
  getTranslationLanguageOptions,
  isSilentTranslationEntry,
  normalizeTranslationLanguageCode,
  useTranslationStore,
} from "../src/store/translationStore";
import { getPublicPersonalSettingsTabIds, shouldHideTranslationIndicator } from "../src/utils/translationContract";

const originalGet = api.get;
const originalPost = api.post;
const originalPatch = api.patch;

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
  api.post = originalPost;
  api.patch = originalPatch;
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

test("public settings always expose Appearance and expose Languages only when translation is enabled", () => {
  assert.deepEqual(getPublicPersonalSettingsTabIds({ authenticated: false, translationEnabled: false }), ["appearance"]);
  assert.deepEqual(getPublicPersonalSettingsTabIds({ authenticated: true, translationEnabled: false }), ["account", "appearance"]);
  assert.deepEqual(getPublicPersonalSettingsTabIds({ authenticated: false, translationEnabled: true }), ["language-region", "appearance"]);
  assert.deepEqual(getPublicPersonalSettingsTabIds({ authenticated: true, translationEnabled: true }), ["account", "language-region", "appearance"]);
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

  const identityFormat = ((desc: { id: string }) => {
    if (desc.id === "settings.language.followDisplayLanguage") return "Same as display language";
    if (desc.id === "settings.language.selectTimezone") return "Select timezone";
    return desc.id;
  }) as never;

  // "Same as display language" first, then every language named in the UI
  // language and sorted the way that language sorts.
  const english = getTranslationLanguageOptions("en", identityFormat);
  assert.equal(english[0].value, FOLLOW_DISPLAY_LANGUAGE_TARGET);
  assert.deepEqual(english.map((option) => option.label), [
    "Same as display language",
    "Brazilian Portuguese",
    "English",
    "French",
    "German",
    "Italian",
    "Japanese",
    "Korean",
    "Russian",
    "Simplified Chinese",
    "Spanish",
    "Traditional Chinese",
  ]);
  const japanese = getTranslationLanguageOptions("ja", identityFormat);
  assert.equal(japanese.find((option) => option.value === "ko")?.label, "韓国語");
  assert.equal(japanese.find((option) => option.value === "zh-tw")?.label, "繁体中国語");
  assert.deepEqual(
    new Set(english.map((option) => option.value)),
    new Set(japanese.map((option) => option.value)),
    "the same languages in every UI language",
  );
  assert.match(formatTimezoneLabel("Asia/Shanghai"), /^UTC\+08:00 Shanghai$/);
  assert.match(formatTimezoneLabel("America/Argentina/Buenos_Aires"), /^UTC-03:00 Buenos Aires$/);
  assert.equal(getTimezoneOptions("Asia/Shanghai", identityFormat)[0].label, "UTC+08:00 Shanghai");
  assert.equal(getTimezoneOptions("America/Indiana/Indianapolis", identityFormat).some((option) => option.value === "America/Indiana/Indianapolis"), true);
  assert.equal(getTimezoneOptions("Asia/Shanghai", identityFormat).length < 50, true);
});

test("with no preference the translation target follows the display language", () => {
  useTranslationStore.setState((state) => ({
    settings: { ...state.settings, preferredLanguage: null, effectiveLanguage: "en" },
  }));
  useTranslationStore.getState().followDisplayLanguage("ja");
  assert.equal(useTranslationStore.getState().settings.effectiveLanguage, "ja");

  // An explicit choice is not overridden by a display-language change.
  useTranslationStore.setState((state) => ({
    settings: { ...state.settings, preferredLanguage: "ko", effectiveLanguage: "ko" },
  }));
  useTranslationStore.getState().followDisplayLanguage("zh-cn");
  assert.equal(useTranslationStore.getState().settings.effectiveLanguage, "ko");
  useTranslationStore.getState().followDisplayLanguage("en");
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

  useAuthStore.setState({ user: null } as never); // no signed-in user yet: the loader fetches it
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

test("settings reuse the signed-in user from the auth store instead of re-fetching /auth/me (task #17)", async () => {
  useTranslationStore.setState(useTranslationStore.getInitialState(), true);
  useAuthStore.setState({
    user: { id: "viewer-1", preferredLanguage: "ja", preferredTranslationMode: "auto", autoTranslationEnabled: true },
  } as never);
  const gets: string[] = [];
  api.get = (async (url: string) => {
    gets.push(url);
    if (url === "/servers/server-1/translation-settings") {
      return { data: { translationEnabled: true, translationAvailable: true } };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;

  await useTranslationStore.getState().loadSettings("server-1");
  assert.deepEqual(gets, ["/servers/server-1/translation-settings"], "no second /auth/me while the user is known");
  assert.equal(useTranslationStore.getState().settings.preferredTranslationMode, "auto");
  assert.equal(useTranslationStore.getState().settings.preferredLanguage, "ja");
});

test("settings fetch the user when the auth store has none and publish it there", async () => {
  useTranslationStore.setState(useTranslationStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
  api.get = (async (url: string) => {
    if (url === "/auth/me") return { data: { id: "viewer-2", preferredLanguage: "fr" } };
    if (url === "/servers/server-1/translation-settings") return { data: { translationEnabled: false } };
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;

  await useTranslationStore.getState().loadSettings("server-1");
  assert.equal(useTranslationStore.getState().settings.preferredLanguage, "fr");
  assert.equal(useAuthStore.getState().user?.id, "viewer-2");
});

test("anonymous public translation preferences stay browser-local and requests use the public endpoint", async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  useTranslationStore.setState(useTranslationStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
  const writes: string[] = [];
  api.get = (async (url: string) => { throw new Error(`Unexpected GET ${url}`); }) as typeof api.get;
  api.patch = (async (url: string) => { throw new Error(`Unexpected PATCH ${url}`); }) as typeof api.patch;
  api.post = (async (url: string) => {
    writes.push(url);
    return { data: { results: [{ messageId: "m-public", status: "not_found", targetLanguage: "en" }] } };
  }) as typeof api.post;

  await useTranslationStore.getState().loadSettings("server-public", {
    serverSlug: "public-slug",
    translationEnabled: true,
    translationAvailable: true,
    browserLocalPreferences: true,
  });
  await useTranslationStore.getState().updatePreferredTranslationMode("manual");
  await useTranslationStore.getState().updatePreferredLanguage("en");
  assert.match(storage.getItem("raft:public-translation-preferences:v1") ?? "", /"preferredTranslationMode":"manual"/);

  await useTranslationStore.getState().requestTranslations([{
    id: "m-public",
    channelId: "c-public",
    senderType: "agent",
    senderId: "public-agent",
    messageType: "chat",
    content: "你好",
    createdAt: new Date().toISOString(),
  } as Message], { targetLanguage: "en", force: true });
  assert.deepEqual(writes, ["/public/servers/public-slug/message-translations:batch"]);
});

test("leaving a public page for the same member server clears public translation routing and persistence", async () => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
  useTranslationStore.setState(useTranslationStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
  await useTranslationStore.getState().loadSettings("same-server", {
    serverSlug: "same-slug",
    translationEnabled: true,
    translationAvailable: true,
    browserLocalPreferences: true,
  });
  assert.equal(useTranslationStore.getState().publicTranslationSlug, "same-slug");
  assert.equal(useTranslationStore.getState().browserLocalPreferences, true);

  useAuthStore.setState({ user: { id: "member", preferredLanguage: "ja", preferredTranslationMode: "manual" } } as never);
  const gets: string[] = [];
  api.get = (async (url: string) => {
    gets.push(url);
    if (url === "/servers/same-server/translation-settings") {
      return { data: { translationEnabled: true, translationAvailable: true } };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;

  await useTranslationStore.getState().loadSettings("same-server");
  assert.deepEqual(gets, ["/servers/same-server/translation-settings"]);
  assert.equal(useTranslationStore.getState().publicTranslationSlug, null);
  assert.equal(useTranslationStore.getState().browserLocalPreferences, false);
  assert.equal(useTranslationStore.getState().settings.preferredLanguage, "ja");
});
