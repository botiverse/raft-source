import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { normalizeTranslationLanguageCode, visitOutsideMarkdownCode, type ServerId, type TraceAttributes } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channels, messages, messageTranslations, servers } from "../db/schema";
import * as channelService from "./channelService";
import { getServerHistoryWindowForRead, isBehindHistoryWindow } from "./historyWindow";
import { addTraceEvent, errorClassOf } from "../tracing/semanticTrace";
import {
  AzureTranslationProvider,
  bracePlaceholderPolicy,
  GoogleTranslationProvider,
  parseGoogleServiceAccountJson,
  TranslationPlaceholderValidationError,
  TranslationProviderError,
  type TranslationBatchItem,
  type TranslationProvider,
  type TranslationProviderVersion,
  VolcengineTranslationProvider,
} from "./translation/index";

export type TranslationMode = "auto" | "manual";
export type TranslationStatus = "translated" | "skipped" | "pending" | "failed" | "not_found";
export type TranslationSkipReason =
  // Legacy persisted rows can still contain the old switch/quota reasons.
  | "server_disabled"
  | "same_language"
  | "own_message"
  | "system_message"
  | "code_or_link_only"
  | "low_confidence"
  | "quota_exceeded"
  | "provider_unavailable"
  | "content_invalid"
  | "placeholder_mismatch";

export type MessageTranslationBatchResult =
  | {
      messageId: string;
      status: "not_found";
      targetLanguage: string;
    }
  | {
      messageId: string;
      status: Exclude<TranslationStatus, "not_found">;
      contentHash: string;
      sourceLanguage: string;
      sourceConfidence: number;
      targetLanguage: string;
      translatedContent?: string;
      skipReason?: TranslationSkipReason;
      provider: string;
      providerVersion: string;
      placeholderPolicyVersion: string;
    };

type VisibleMessage = typeof messages.$inferSelect & {
  serverId: string;
};

export type Detection = {
  sourceLanguage: string;
  sourceConfidence: number;
};

export type LedgerProviderInfo = {
  providerName: string;
  providerVersion: string;
  placeholderPolicyVersion: string;
};

export type ResolvedTranslationProvider = {
  provider: TranslationProvider;
  placeholderPolicyVersion: string;
};

type MessageTranslationServiceDeps = {
  resolveProvider(): ResolvedTranslationProvider | Promise<ResolvedTranslationProvider>;
};

type ProviderQueueItem = {
  resultIndex: number;
  message: VisibleMessage;
  contentHash: string;
  detection: Detection;
  requestedChars: number;
};

type TranslationTraceCounters = Record<string, number>;

const PLACEHOLDER_POLICY_VERSION = "placeholder-v0";
const NO_PLACEHOLDER_POLICY_VERSION = "placeholder-none-v0";
const LOW_CONFIDENCE_THRESHOLD = 50;
const PROVIDER_BATCH_MAX_ITEMS = 16;
const PROVIDER_BATCH_MAX_CHARS = 5_000;
const FAKE_PROVIDER_VERSION: TranslationProviderVersion = {
  provider: "fake",
  apiVersion: "v0",
  policyVersion: "fake-v0",
};

export function hashMessageContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeLanguage(language: string): string {
  return normalizeTranslationLanguageCode(language) ?? language.trim().toLowerCase();
}

export function detectMessageTranslationLanguage(content: string): Detection {
  const text = content.trim();
  if (!text) return { sourceLanguage: "und", sourceConfidence: 0 };
  if (/[\u4e00-\u9fff]/.test(text)) return { sourceLanguage: "zh", sourceConfidence: 95 };
  if (/[a-zA-Z]/.test(text)) return { sourceLanguage: "en", sourceConfidence: 90 };
  return { sourceLanguage: "und", sourceConfidence: 20 };
}

export function isMessageTranslationCodeOrLinkOnly(content: string): boolean {
  // Code is decided by the markdown parser (task #762), not by fence regexes.
  let prose = "";
  visitOutsideMarkdownCode(content, (chunk) => { prose += ` ${chunk}`; });
  const stripped = prose
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<a\s+data-(?:mention|channel|task)=[\s\S]*?<\/a>/g, " ")
    .replace(/@[A-Za-z0-9_-]+/g, " ")
    .replace(/#[A-Za-z0-9_-]+/g, " ")
    .replace(/task\s+#\d+/gi, " ")
    .trim();
  return stripped.length === 0;
}

class FakeTranslationProvider implements TranslationProvider {
  readonly providerVersion = FAKE_PROVIDER_VERSION;

  async translateBatch(
    items: readonly TranslationBatchItem[],
    targetLanguage: string,
  ) {
    return {
      providerVersion: this.providerVersion,
      items: items.map((item) => ({
        key: item.key,
        sourceText: item.sourceText,
        translatedText: `[${targetLanguage}] ${item.sourceText}`,
        targetLanguage,
        ...(item.sourceLanguage ? { sourceLanguage: item.sourceLanguage } : {}),
      })),
    };
  }
}

export function formatProviderVersion(version: TranslationProviderVersion): string {
  return `${version.provider}@${version.apiVersion}+${version.policyVersion}`;
}

export function providerInfoFromResolved(input: ResolvedTranslationProvider): LedgerProviderInfo {
  return {
    providerName: input.provider.providerVersion.provider,
    providerVersion: formatProviderVersion(input.provider.providerVersion),
    placeholderPolicyVersion: input.placeholderPolicyVersion,
  };
}

export function resolveProviderFromEnv(): ResolvedTranslationProvider {
  if (process.env.TRANSLATION_SSM_ENVIRONMENT?.trim()) {
    throw new Error("Translation SSM configuration is no longer supported");
  }
  const configuredProvider = process.env.TRANSLATION_PROVIDER?.trim().toLowerCase();
  if (configuredProvider === "fake") {
    return {
      provider: new FakeTranslationProvider(),
      placeholderPolicyVersion: PLACEHOLDER_POLICY_VERSION,
    };
  }

  if (configuredProvider === "volcengine") {
    const accessKeyId = process.env.TRANSLATION_VOLCENGINE_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.TRANSLATION_VOLCENGINE_SECRET_ACCESS_KEY?.trim();
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("Volcengine translation provider is not configured. Set TRANSLATION_VOLCENGINE_ACCESS_KEY_ID and TRANSLATION_VOLCENGINE_SECRET_ACCESS_KEY.");
    }
    return {
      provider: new VolcengineTranslationProvider({
        accessKeyId,
        secretAccessKey,
        endpoint: process.env.TRANSLATION_VOLCENGINE_ENDPOINT?.trim(),
        region: process.env.TRANSLATION_VOLCENGINE_REGION?.trim(),
        placeholderPolicy: bracePlaceholderPolicy,
      }),
      placeholderPolicyVersion: bracePlaceholderPolicy.name,
    };
  }

  if (configuredProvider === "google") {
    const projectId = process.env.TRANSLATION_GOOGLE_PROJECT_ID?.trim();
    if (!projectId) {
      throw new Error("Google Cloud Translation provider is not configured. Set TRANSLATION_GOOGLE_PROJECT_ID.");
    }
    const accessToken = process.env.TRANSLATION_GOOGLE_ACCESS_TOKEN?.trim();
    const serviceAccountJson = process.env.TRANSLATION_GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
    const clientEmail = process.env.TRANSLATION_GOOGLE_CLIENT_EMAIL?.trim();
    const privateKey = process.env.TRANSLATION_GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
    const serviceAccount = serviceAccountJson
      ? parseGoogleServiceAccountJson(serviceAccountJson)
      : clientEmail && privateKey
        ? { clientEmail, privateKey }
        : undefined;
    if (!accessToken && !serviceAccount) {
      throw new Error("Google Cloud Translation provider is not configured. Set TRANSLATION_GOOGLE_ACCESS_TOKEN, TRANSLATION_GOOGLE_SERVICE_ACCOUNT_JSON, or TRANSLATION_GOOGLE_CLIENT_EMAIL and TRANSLATION_GOOGLE_PRIVATE_KEY.");
    }
    return {
      provider: new GoogleTranslationProvider({
        projectId,
        location: process.env.TRANSLATION_GOOGLE_LOCATION?.trim(),
        endpoint: process.env.TRANSLATION_GOOGLE_ENDPOINT?.trim(),
        accessToken,
        serviceAccount,
        quotaProjectId: process.env.TRANSLATION_GOOGLE_QUOTA_PROJECT_ID?.trim(),
        placeholderPolicy: bracePlaceholderPolicy,
      }),
      placeholderPolicyVersion: bracePlaceholderPolicy.name,
    };
  }

  if (configuredProvider && configuredProvider !== "azure") {
    throw new Error("Unsupported translation provider");
  }

  const endpoint = process.env.TRANSLATION_AZURE_ENDPOINT?.trim();
  const apiKey = process.env.TRANSLATION_AZURE_API_KEY?.trim();
  if (!endpoint || !apiKey) {
    throw new Error("Translation provider is not configured. Set TRANSLATION_PROVIDER=fake for tests or provide Azure credentials.");
  }

  return {
    provider: new AzureTranslationProvider({
      endpoint,
      apiKey,
      region: process.env.TRANSLATION_AZURE_REGION?.trim(),
      placeholderPolicy: bracePlaceholderPolicy,
    }),
    placeholderPolicyVersion: bracePlaceholderPolicy.name,
  };
}

export function isTranslationProviderConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TRANSLATION_SSM_ENVIRONMENT?.trim()) return false;
  const configuredProvider = env.TRANSLATION_PROVIDER?.trim().toLowerCase();
  if (configuredProvider === "fake") {
    return true;
  }
  if (configuredProvider === "volcengine") {
    return Boolean(env.TRANSLATION_VOLCENGINE_ACCESS_KEY_ID?.trim() && env.TRANSLATION_VOLCENGINE_SECRET_ACCESS_KEY?.trim());
  }
  if (configuredProvider === "google") {
    const hasServiceAccountJson = Boolean(env.TRANSLATION_GOOGLE_SERVICE_ACCOUNT_JSON?.trim());
    const hasServiceAccountFields = Boolean(
      env.TRANSLATION_GOOGLE_CLIENT_EMAIL?.trim()
        && env.TRANSLATION_GOOGLE_PRIVATE_KEY?.trim(),
    );
    return Boolean(env.TRANSLATION_GOOGLE_PROJECT_ID?.trim()
      && (env.TRANSLATION_GOOGLE_ACCESS_TOKEN?.trim() || hasServiceAccountJson || hasServiceAccountFields));
  }
  if (configuredProvider && configuredProvider !== "azure") return false;

  return Boolean(env.TRANSLATION_AZURE_ENDPOINT?.trim() && env.TRANSLATION_AZURE_API_KEY?.trim());
}

const defaultMessageTranslationServiceDeps: MessageTranslationServiceDeps = {
  resolveProvider: resolveProviderFromEnv,
};

let messageTranslationServiceDeps: MessageTranslationServiceDeps = defaultMessageTranslationServiceDeps;

export function __setMessageTranslationServiceDepsForTests(
  overrides: Partial<MessageTranslationServiceDeps>,
): void {
  messageTranslationServiceDeps = {
    ...defaultMessageTranslationServiceDeps,
    ...overrides,
  };
}

export function __resetMessageTranslationServiceDepsForTests(): void {
  messageTranslationServiceDeps = defaultMessageTranslationServiceDeps;
}

function providerFailureSkipReason(error: TranslationProviderError): TranslationSkipReason {
  if (error instanceof TranslationPlaceholderValidationError) return "placeholder_mismatch";
  if (error.disposition === "transient") return "provider_unavailable";
  return "content_invalid";
}

function providerTraceAttrs(providerInfo: LedgerProviderInfo): TraceAttributes {
  return {
    provider: providerInfo.providerName,
    provider_version: providerInfo.providerVersion,
    placeholder_policy_version: providerInfo.placeholderPolicyVersion,
  };
}

function summarizeTranslationResults(results: readonly MessageTranslationBatchResult[]): TraceAttributes {
  const attrs: TraceAttributes = {
    result_count: results.length,
    translated_count: 0,
    skipped_count: 0,
    failed_count: 0,
    not_found_count: 0,
    pending_count: 0,
  };
  for (const result of results) {
    attrs[`${result.status}_count`] = Number(attrs[`${result.status}_count`] ?? 0) + 1;
  }
  return attrs;
}

function incrementTraceCounter(counters: TranslationTraceCounters, name: string): void {
  counters[name] = (counters[name] ?? 0) + 1;
}

function traceCounterAttrs(counters: TranslationTraceCounters): TraceAttributes {
  return Object.fromEntries(
    Object.entries(counters).map(([name, count]) => [`${name}_count`, count]),
  );
}

function chunkProviderItems(items: ProviderQueueItem[]): ProviderQueueItem[][] {
  const chunks: ProviderQueueItem[][] = [];
  let current: ProviderQueueItem[] = [];
  let currentChars = 0;
  let currentSourceLanguage: string | null = null;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current);
    current = [];
    currentChars = 0;
    currentSourceLanguage = null;
  };

  for (const item of items) {
    const sourceLanguage = item.detection.sourceLanguage || null;
    const wouldExceedItems = current.length >= PROVIDER_BATCH_MAX_ITEMS;
    const wouldExceedChars = current.length > 0 && currentChars + item.requestedChars > PROVIDER_BATCH_MAX_CHARS;
    const wouldMixSourceLanguage = current.length > 0 && currentSourceLanguage !== sourceLanguage;
    if (wouldExceedItems || wouldExceedChars || wouldMixSourceLanguage) flush();

    current.push(item);
    currentChars += item.requestedChars;
    currentSourceLanguage = sourceLanguage;
  }
  flush();

  return chunks;
}

function requestTimeSkipResult(input: {
  message: VisibleMessage;
  contentHash: string;
  detection: Detection;
  targetLanguage: string;
  skipReason: TranslationSkipReason;
  providerInfo: LedgerProviderInfo;
}): MessageTranslationBatchResult {
  return {
    messageId: input.message.id,
    status: "skipped",
    contentHash: input.contentHash,
    sourceLanguage: input.detection.sourceLanguage,
    sourceConfidence: input.detection.sourceConfidence,
    targetLanguage: input.targetLanguage,
    skipReason: input.skipReason,
    provider: input.providerInfo.providerName,
    providerVersion: input.providerInfo.providerVersion,
    placeholderPolicyVersion: input.providerInfo.placeholderPolicyVersion,
  };
}

function requestTimeFailedResult(input: {
  message: VisibleMessage;
  contentHash: string;
  detection: Detection;
  targetLanguage: string;
  skipReason: TranslationSkipReason;
  providerInfo: LedgerProviderInfo;
}): MessageTranslationBatchResult {
  return {
    messageId: input.message.id,
    status: "failed",
    contentHash: input.contentHash,
    sourceLanguage: input.detection.sourceLanguage,
    sourceConfidence: input.detection.sourceConfidence,
    targetLanguage: input.targetLanguage,
    skipReason: input.skipReason,
    provider: input.providerInfo.providerName,
    providerVersion: input.providerInfo.providerVersion,
    placeholderPolicyVersion: input.providerInfo.placeholderPolicyVersion,
  };
}

async function deletePendingRow(input: {
  message: VisibleMessage;
  contentHash: string;
  detection: Detection;
  targetLanguage: string;
  providerInfo: LedgerProviderInfo;
}): Promise<void> {
  const db = getDb();
  await db.delete(messageTranslations).where(and(
    eq(messageTranslations.messageId, input.message.id),
    eq(messageTranslations.contentHash, input.contentHash),
    eq(messageTranslations.sourceLang, input.detection.sourceLanguage),
    eq(messageTranslations.targetLang, input.targetLanguage),
    eq(messageTranslations.providerVersion, input.providerInfo.providerVersion),
    eq(messageTranslations.placeholderPolicyVersion, input.providerInfo.placeholderPolicyVersion),
    eq(messageTranslations.status, "pending"),
  ));
}

async function deleteFailedRow(input: {
  message: VisibleMessage;
  contentHash: string;
  detection: Detection;
  targetLanguage: string;
  providerInfo: LedgerProviderInfo;
}): Promise<void> {
  const db = getDb();
  await db.delete(messageTranslations).where(and(
    eq(messageTranslations.messageId, input.message.id),
    eq(messageTranslations.contentHash, input.contentHash),
    eq(messageTranslations.sourceLang, input.detection.sourceLanguage),
    eq(messageTranslations.targetLang, input.targetLanguage),
    eq(messageTranslations.providerVersion, input.providerInfo.providerVersion),
    eq(messageTranslations.placeholderPolicyVersion, input.providerInfo.placeholderPolicyVersion),
    eq(messageTranslations.status, "failed"),
  ));
}

async function writeLedgerRow(input: {
  message: VisibleMessage;
  contentHash: string;
  detection: Detection;
  targetLanguage: string;
  status: "translated" | "skipped" | "failed";
  translatedContent?: string;
  skipReason?: TranslationSkipReason;
  requestedChars: number;
  providerBilledChars: number;
  providerInfo: LedgerProviderInfo;
}) {
  const db = getDb();
  const [row] = await db.insert(messageTranslations).values({
    serverId: input.message.serverId,
    messageId: input.message.id,
    contentHash: input.contentHash,
    sourceLang: input.detection.sourceLanguage,
    sourceConfidence: input.detection.sourceConfidence,
    targetLang: input.targetLanguage,
    provider: input.providerInfo.providerName,
    providerVersion: input.providerInfo.providerVersion,
    placeholderPolicyVersion: input.providerInfo.placeholderPolicyVersion,
    status: input.status,
    translatedContent: input.translatedContent,
    skipReason: input.skipReason,
    requestedChars: input.requestedChars,
    providerBilledChars: input.providerBilledChars,
    lastAccessedAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [
      messageTranslations.messageId,
      messageTranslations.contentHash,
      messageTranslations.sourceLang,
      messageTranslations.targetLang,
      messageTranslations.providerVersion,
      messageTranslations.placeholderPolicyVersion,
    ],
    set: {
      status: input.status,
      translatedContent: input.translatedContent ?? null,
      skipReason: input.skipReason ?? null,
      requestedChars: input.requestedChars,
      providerBilledChars: input.providerBilledChars,
      lastAccessedAt: new Date(),
      updatedAt: new Date(),
    },
  }).returning();
  return row;
}

async function insertPendingRow(input: {
  message: VisibleMessage;
  contentHash: string;
  detection: Detection;
  targetLanguage: string;
  requestedChars: number;
  providerInfo: LedgerProviderInfo;
}): Promise<{ inserted: true; row: typeof messageTranslations.$inferSelect } | { inserted: false; row: typeof messageTranslations.$inferSelect | null }> {
  const db = getDb();
  const [inserted] = await db.insert(messageTranslations).values({
    serverId: input.message.serverId,
    messageId: input.message.id,
    contentHash: input.contentHash,
    sourceLang: input.detection.sourceLanguage,
    sourceConfidence: input.detection.sourceConfidence,
    targetLang: input.targetLanguage,
    provider: input.providerInfo.providerName,
    providerVersion: input.providerInfo.providerVersion,
    placeholderPolicyVersion: input.providerInfo.placeholderPolicyVersion,
    status: "pending",
    requestedChars: input.requestedChars,
    providerBilledChars: 0,
    lastAccessedAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing({
    target: [
      messageTranslations.messageId,
      messageTranslations.contentHash,
      messageTranslations.sourceLang,
      messageTranslations.targetLang,
      messageTranslations.providerVersion,
      messageTranslations.placeholderPolicyVersion,
    ],
  }).returning();
  if (inserted) return { inserted: true, row: inserted };

  const [row] = await db
    .update(messageTranslations)
    .set({ lastAccessedAt: new Date() })
    .where(and(
      eq(messageTranslations.messageId, input.message.id),
      eq(messageTranslations.contentHash, input.contentHash),
      eq(messageTranslations.sourceLang, input.detection.sourceLanguage),
      eq(messageTranslations.targetLang, input.targetLanguage),
      eq(messageTranslations.providerVersion, input.providerInfo.providerVersion),
      eq(messageTranslations.placeholderPolicyVersion, input.providerInfo.placeholderPolicyVersion),
    ))
    .returning();
  return { inserted: false, row: row ?? null };
}

function rowToResult(row: typeof messageTranslations.$inferSelect): MessageTranslationBatchResult {
  return {
    messageId: row.messageId,
    status: row.status,
    contentHash: row.contentHash,
    sourceLanguage: row.sourceLang,
    sourceConfidence: row.sourceConfidence,
    targetLanguage: row.targetLang,
    translatedContent: row.translatedContent ?? undefined,
    skipReason: row.skipReason ?? undefined,
    provider: row.provider,
    providerVersion: row.providerVersion,
    placeholderPolicyVersion: row.placeholderPolicyVersion,
  };
}

async function getLedgerRow(input: {
  messageId: string;
  contentHash: string;
  sourceLanguage: string;
  targetLanguage: string;
  providerInfo: LedgerProviderInfo;
  mode: TranslationMode;
}): Promise<MessageTranslationBatchResult | null> {
  const db = getDb();
  const [row] = await db
    .update(messageTranslations)
    .set({ lastAccessedAt: new Date() })
    .where(and(
      eq(messageTranslations.messageId, input.messageId),
      eq(messageTranslations.contentHash, input.contentHash),
      eq(messageTranslations.sourceLang, input.sourceLanguage),
      eq(messageTranslations.targetLang, input.targetLanguage),
      eq(messageTranslations.providerVersion, input.providerInfo.providerVersion),
      eq(messageTranslations.placeholderPolicyVersion, input.providerInfo.placeholderPolicyVersion),
    ))
    .returning();
  if (row?.status === "failed" && input.mode === "manual") return null;
  return row ? rowToResult(row) : null;
}

async function listVisibleMessages(input: {
  serverId: ServerId;
  userId: string;
  messageIds: string[];
}): Promise<Map<string, VisibleMessage>> {
  const db = getDb();
  const uniqueIds = [...new Set(input.messageIds)];
  if (uniqueIds.length === 0) return new Map();

  const rows = await db
    .select({
      message: messages,
      serverId: channels.serverId,
    })
    .from(messages)
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .where(inArray(messages.id, uniqueIds));

  const visible = new Map<string, VisibleMessage>();
  for (const row of rows) {
    const jointProjections = await channelService.getActiveJointChannelProjectionsByLocalChannel(
      row.message.channelId,
    );
    if (jointProjections.length > 0) {
      const localProjection = jointProjections.find((projection) => projection.serverId === input.serverId);
      if (!localProjection) continue;
      const canAccess = await channelService.canUserAccessChannel(
        localProjection.localChannelId,
        input.userId,
        input.serverId,
      );
      if (canAccess) {
        visible.set(row.message.id, { ...row.message, serverId: input.serverId });
      }
      continue;
    }

    if (row.serverId !== input.serverId) continue;
    const canAccess = await channelService.canUserAccessChannel(
      row.message.channelId,
      input.userId,
      input.serverId,
    );
    if (canAccess) visible.set(row.message.id, { ...row.message, serverId: row.serverId });
  }
  return visible;
}

export async function translateMessagesBatch(input: {
  serverId: ServerId;
  userId: string;
  targetLanguage: string;
  mode: TranslationMode;
  messageIds: string[];
}): Promise<MessageTranslationBatchResult[]> {
  const visible = await listVisibleMessages(input);
  // A message behind the plan's history window is not this reader's to see,
  // so not to translate either: it answers like a message that isn't there.
  const historyWindow = await getServerHistoryWindowForRead(input.serverId);
  for (const [messageId, message] of visible) {
    if (isBehindHistoryWindow(message.createdAt, historyWindow)) visible.delete(messageId);
  }
  return translateVisibleMessagesBatch(input, visible);
}

/**
 * Public translation deliberately has its own visibility resolver. Public
 * server pages are the one marked exception to the plan's history window
 * (cindyz, task #8: not considered for now). It never
 * calls the member/channel authorization helpers: every request rechecks the
 * public server toggle plus the ordinary-channel (or public parent-thread)
 * predicate in the same query that loads the requested messages.
 */
export async function translatePublicMessagesBatch(input: {
  serverSlug: string;
  targetLanguage: string;
  mode: TranslationMode;
  messageIds: string[];
}): Promise<MessageTranslationBatchResult[]> {
  const db = getDb();
  const uniqueIds = [...new Set(input.messageIds)];
  if (uniqueIds.length === 0) return [];
  const parentMessages = alias(messages, "public_translation_parent_messages");
  const parentChannels = alias(channels, "public_translation_parent_channels");
  const rows = await db
    .select({ message: messages, serverId: channels.serverId })
    .from(messages)
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .innerJoin(servers, and(
      eq(servers.id, channels.serverId),
      eq(servers.slug, input.serverSlug),
      eq(servers.publiclyVisible, true),
      eq(servers.translationEnabled, true),
      isNull(servers.deletedAt),
    ))
    .leftJoin(parentMessages, eq(parentMessages.id, channels.parentMessageId))
    .leftJoin(parentChannels, eq(parentChannels.id, parentMessages.channelId))
    .where(and(
      inArray(messages.id, uniqueIds),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
      or(
        and(eq(channels.type, "channel"), eq(channels.guestVisible, true)),
        and(
          eq(channels.type, "thread"),
          eq(parentChannels.serverId, channels.serverId),
          eq(parentChannels.type, "channel"),
          eq(parentChannels.guestVisible, true),
          isNull(parentChannels.deletedAt),
          isNull(parentChannels.archivedAt),
        ),
      ),
    ));
  const visible = new Map(rows.map((row) => [row.message.id, { ...row.message, serverId: row.serverId }]));
  const [server] = await db.select({ id: servers.id }).from(servers)
    .where(and(
      eq(servers.slug, input.serverSlug),
      eq(servers.publiclyVisible, true),
      eq(servers.translationEnabled, true),
      isNull(servers.deletedAt),
    )).limit(1);
  if (!server) return input.messageIds.map((messageId) => ({
    messageId,
    status: "not_found" as const,
    targetLanguage: normalizeLanguage(input.targetLanguage),
  }));
  return translateVisibleMessagesBatch({ ...input, serverId: server.id as ServerId }, visible);
}

async function translateVisibleMessagesBatch(input: {
  serverId: ServerId;
  userId?: string;
  targetLanguage: string;
  mode: TranslationMode;
  messageIds: string[];
}, visibleMessages: Map<string, VisibleMessage>): Promise<MessageTranslationBatchResult[]> {
  const targetLanguage = normalizeLanguage(input.targetLanguage);
  addTraceEvent("translation.batch.started", {
    target_language: targetLanguage,
    mode: input.mode,
    requested_count: input.messageIds.length,
  });

  let resolvedProvider: ResolvedTranslationProvider;
  try {
    resolvedProvider = await messageTranslationServiceDeps.resolveProvider();
  } catch (error) {
    addTraceEvent("translation.skipped", {
      reason: "missing_provider",
      target_language: targetLanguage,
      mode: input.mode,
      requested_count: input.messageIds.length,
      error_class: errorClassOf(error),
    });
    throw error;
  }
  const providerInfo = providerInfoFromResolved(resolvedProvider);
  addTraceEvent("translation.provider.resolved", providerTraceAttrs(providerInfo));
  const results: Array<MessageTranslationBatchResult | undefined> = [];
  const providerItems: ProviderQueueItem[] = [];
  const traceCounters: TranslationTraceCounters = {};

  for (const [resultIndex, messageId] of input.messageIds.entries()) {
    const message = visibleMessages.get(messageId);
    if (!message) {
      results[resultIndex] = { messageId, status: "not_found", targetLanguage };
      incrementTraceCounter(traceCounters, "skip_not_found");
      continue;
    }

    const contentHash = hashMessageContent(message.content);
    const requestedChars = message.content.length;
    const detection = detectMessageTranslationLanguage(message.content);

    if (
      input.mode === "auto"
      && message.senderType === "user"
      && !!input.userId
      && message.senderId === input.userId
    ) {
      results[resultIndex] = requestTimeSkipResult({
        message,
        contentHash,
        detection,
        targetLanguage,
        skipReason: "own_message",
        providerInfo,
      });
      incrementTraceCounter(traceCounters, "skip_own_message");
      continue;
    }

    if (message.messageType === "system") {
      const row = await writeLedgerRow({
        message,
        contentHash,
        detection,
        targetLanguage,
        status: "skipped",
        skipReason: "system_message",
        requestedChars,
        providerBilledChars: 0,
        providerInfo,
      });
      results[resultIndex] = rowToResult(row);
      incrementTraceCounter(traceCounters, "skip_system_message");
      continue;
    }

    if (isMessageTranslationCodeOrLinkOnly(message.content)) {
      const row = await writeLedgerRow({
        message,
        contentHash,
        detection,
        targetLanguage,
        status: "skipped",
        skipReason: "code_or_link_only",
        requestedChars,
        providerBilledChars: 0,
        providerInfo,
      });
      results[resultIndex] = rowToResult(row);
      incrementTraceCounter(traceCounters, "skip_code_or_link_only");
      continue;
    }

    const ledgerRow = await getLedgerRow({
      messageId: message.id,
      contentHash,
      sourceLanguage: detection.sourceLanguage,
      targetLanguage,
      providerInfo,
      mode: input.mode,
    });
    if (ledgerRow) {
      results[resultIndex] = ledgerRow;
      incrementTraceCounter(traceCounters, "skip_already_exists");
      continue;
    }

    if (detection.sourceConfidence < LOW_CONFIDENCE_THRESHOLD) {
      const row = await writeLedgerRow({
        message,
        contentHash,
        detection,
        targetLanguage,
        status: "skipped",
        skipReason: "low_confidence",
        requestedChars,
        providerBilledChars: 0,
        providerInfo,
      });
      results[resultIndex] = rowToResult(row);
      incrementTraceCounter(traceCounters, "skip_low_confidence");
      continue;
    }

    const normalizedSourceLanguage = normalizeTranslationLanguageCode(detection.sourceLanguage) ?? detection.sourceLanguage;
    if (normalizedSourceLanguage === targetLanguage) {
      const row = await writeLedgerRow({
        message,
        contentHash,
        detection,
        targetLanguage,
        status: "skipped",
        skipReason: "same_language",
        requestedChars,
        providerBilledChars: 0,
        providerInfo,
      });
      results[resultIndex] = rowToResult(row);
      incrementTraceCounter(traceCounters, "skip_target_is_source");
      continue;
    }

    if (input.mode === "manual") {
      await deleteFailedRow({
        message,
        contentHash,
        detection,
        targetLanguage,
        providerInfo,
      });
    }

    const pending = await insertPendingRow({
      message,
      contentHash,
      detection,
      targetLanguage,
      requestedChars,
      providerInfo,
    });
    if (!pending.inserted) {
      results[resultIndex] = pending.row
        ? rowToResult(pending.row)
        : { messageId, status: "not_found", targetLanguage };
      incrementTraceCounter(traceCounters, pending.row ? "skip_already_exists" : "skip_not_found");
      continue;
    }

    providerItems.push({
      resultIndex,
      message,
      contentHash,
      detection,
      requestedChars,
    });
  }

  if (providerItems.length === 0) {
    const completedResults = results.filter((result): result is MessageTranslationBatchResult => result !== undefined);
    addTraceEvent("translation.batch.finished", {
      target_language: targetLanguage,
      mode: input.mode,
      requested_count: input.messageIds.length,
      provider_call_count: 0,
      ...providerTraceAttrs(providerInfo),
      ...summarizeTranslationResults(completedResults),
      ...traceCounterAttrs(traceCounters),
    });
    return completedResults;
  }

  let providerCallCount = 0;
  for (const providerChunk of chunkProviderItems(providerItems)) {
    const providerCallStart = Date.now();
    const charCount = providerChunk.reduce((sum, item) => sum + item.requestedChars, 0);
    providerCallCount += 1;
    try {
      const providerResult = await resolvedProvider.provider.translateBatch(
        providerChunk.map((item) => ({
          key: item.message.id,
          sourceText: item.message.content,
          sourceLanguage: item.detection.sourceLanguage,
        })),
        targetLanguage,
      );
      const translatedByMessageId = new Map(providerResult.items.map((item) => [item.key, item]));

      for (const item of providerChunk) {
        if (!translatedByMessageId.has(item.message.id)) {
          throw new TranslationProviderError({
            providerVersion: resolvedProvider.provider.providerVersion,
            code: "missing_provider_result_item",
            message: `Provider result missing item for message ${item.message.id}`,
            disposition: "transient",
          });
        }
      }

      addTraceEvent("translation.provider.call", {
        ...providerTraceAttrs(providerInfo),
        target_language: targetLanguage,
        batch_size: providerChunk.length,
        char_count: charCount,
        latency_ms: Date.now() - providerCallStart,
        outcome: "success",
      });

      for (const item of providerChunk) {
        const translatedItem = translatedByMessageId.get(item.message.id)!;
        const row = await writeLedgerRow({
          message: item.message,
          contentHash: item.contentHash,
          detection: item.detection,
          targetLanguage,
          status: "translated",
          translatedContent: translatedItem.translatedText,
          requestedChars: item.requestedChars,
          providerBilledChars: item.requestedChars,
          providerInfo,
        });
        results[item.resultIndex] = rowToResult(row);
      }
    } catch (error) {
      addTraceEvent("translation.provider.call", {
        ...providerTraceAttrs(providerInfo),
        target_language: targetLanguage,
        batch_size: providerChunk.length,
        char_count: charCount,
        latency_ms: Date.now() - providerCallStart,
        outcome: "error",
        error_class: errorClassOf(error),
        ...(error instanceof TranslationProviderError ? {
          error_code: error.code,
          error_disposition: error.disposition,
        } : {}),
      });
      if (!(error instanceof TranslationProviderError)) throw error;
      const skipReason = providerFailureSkipReason(error);

      for (const item of providerChunk) {
        if (error.disposition === "transient") {
          await deletePendingRow({
            message: item.message,
            contentHash: item.contentHash,
            detection: item.detection,
            targetLanguage,
            providerInfo,
          });
          results[item.resultIndex] = requestTimeFailedResult({
            message: item.message,
            contentHash: item.contentHash,
            detection: item.detection,
            targetLanguage,
            skipReason,
            providerInfo,
          });
          incrementTraceCounter(traceCounters, `skip_${skipReason}`);
          continue;
        }

        const row = await writeLedgerRow({
          message: item.message,
          contentHash: item.contentHash,
          detection: item.detection,
          targetLanguage,
          status: "failed",
          skipReason,
          requestedChars: item.requestedChars,
          providerBilledChars: 0,
          providerInfo,
        });
        results[item.resultIndex] = rowToResult(row);
        incrementTraceCounter(traceCounters, `skip_${skipReason}`);
      }
    }
  }

  const completedResults = results.filter((result): result is MessageTranslationBatchResult => result !== undefined);
  addTraceEvent("translation.batch.finished", {
    target_language: targetLanguage,
    mode: input.mode,
    requested_count: input.messageIds.length,
    provider_call_count: providerCallCount,
    ...providerTraceAttrs(providerInfo),
    ...summarizeTranslationResults(completedResults),
    ...traceCounterAttrs(traceCounters),
  });
  return completedResults;
}
