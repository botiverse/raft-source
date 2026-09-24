import type { Request, Response } from "express";
import { normalizeTranslationLanguageCode } from "@botiverse/raft-shared";
import { translateMessagesBatch, TranslationFeatureUnavailableError, type TranslationMode } from "../services/messageTranslationService.js";
import { getServerTranslationSettings } from "../services/serverService.js";
import { addTraceEvent } from "../tracing/semanticTrace.js";

const MAX_BATCH_SIZE = 200;

function parseMode(value: unknown): TranslationMode | null {
  return value === "auto" || value === "manual" ? value : null;
}

export async function messageTranslationBatchHandler(req: Request, res: Response): Promise<void> {
  try {
    const targetLanguage = typeof req.body?.targetLanguage === "string"
      ? normalizeTranslationLanguageCode(req.body.targetLanguage)
      : null;
    const mode = parseMode(req.body?.mode);
    const messageIds = Array.isArray(req.body?.messageIds)
      ? req.body.messageIds.filter((id: unknown): id is string => typeof id === "string")
      : null;

    if (!targetLanguage) {
      addTraceEvent("translation.skipped", {
        reason: "unsupported_language",
        mode: mode ?? "unknown",
        requested_count: messageIds?.length ?? 0,
      });
      res.status(400).json({ error: "targetLanguage must be a supported language tag" });
      return;
    }
    if (!mode) {
      res.status(400).json({ error: "mode must be auto or manual" });
      return;
    }
    if (!messageIds) {
      res.status(400).json({ error: "messageIds must be an array" });
      return;
    }
    if (messageIds.length > MAX_BATCH_SIZE) {
      res.status(400).json({ error: `messageIds exceeds maximum batch size of ${MAX_BATCH_SIZE}` });
      return;
    }

    const settings = await getServerTranslationSettings(req.serverId!);
    if (!settings?.translationEnabled) {
      addTraceEvent("translation.skipped", {
        reason: "server_disabled",
        target_language: targetLanguage,
        mode,
        requested_count: messageIds.length,
      });
      res.status(403).json({ error: "Translation is disabled for this server" });
      return;
    }

    const results = await translateMessagesBatch({
      serverId: req.serverId!,
      userId: req.userId!,
      targetLanguage,
      mode,
      messageIds,
    });
    res.json({ results });
  } catch (err) {
    if (err instanceof TranslationFeatureUnavailableError) {
      res.status(403).json({ error: err.message });
      return;
    }
    console.error("Message translation batch error:", err);
    res.status(500).json({ error: "Failed to translate messages" });
  }
}
