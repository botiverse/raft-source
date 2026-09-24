import { useEffect, useMemo } from "react";
import type { Message } from "../store/messageStore";
import { useAuthStore } from "../store/authStore";
import { useServerStore } from "../store/serverStore";
import { useTranslationStore } from "../store/translationStore";

export function useTranslationBatch(messages: Message[]) {
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const viewerUserId = useAuthStore((s) => s.user?.id ?? null);
  const settings = useTranslationStore((s) => s.settings);
  const loadSettings = useTranslationStore((s) => s.loadSettings);
  const requestTranslations = useTranslationStore((s) => s.requestTranslations);

  useEffect(() => {
    void loadSettings(serverId);
  }, [loadSettings, serverId]);

  const messageBatchKey = useMemo(
    () => messages.map((message) => `${message.id}:${message.content}`).join("|"),
    [messages],
  );

  useEffect(() => {
    if (!settings.available || settings.preferredTranslationMode !== "auto" || !settings.effectiveLanguage) return;
    if (messages.length === 0) return;
    void requestTranslations(messages, {
      targetLanguage: settings.effectiveLanguage,
      viewerUserId,
    });
    // The key intentionally tracks message id + content instead of the
    // array identity, so edits naturally trigger a fresh read-side cache
    // lookup without refetching on unrelated parent renders.
  }, [
    messageBatchKey,
    messages,
    requestTranslations,
    settings.available,
    settings.preferredTranslationMode,
    settings.effectiveLanguage,
    viewerUserId,
  ]);
}
