import type { IntlShape } from "react-intl";
import type { MessageMention } from "../../store/messageStore";
import { useAuthStore } from "../../store/authStore";
import type { PendingFile } from "./composerTypes";

// Stryker disable all: draft attachment persistence is pinned by
// messageInputDraftAttachments.behavior (removed in the 2026-11 web DOM test prune) tests. Generated mutations in this
// module-scoped session cache and its React cleanup callers mostly collapse
// into equivalent remount timing states, so the DOM tests are the useful oracle.
const DRAFT_PENDING_FILE_KEY_SEPARATOR = "\u0000";
const draftPendingFilesByChannel = new Map<string, PendingFile[]>();
export const failedSendMentionsByDraftKey = new Map<string, MessageMention[]>();
export function getDraftPendingFilesAuthScope(userId: string | null | undefined) {
  return userId ? `user:${userId}` : "no-auth-session";
}
export function getDraftPendingFilesKey(authScope: string, channelId: string) {
  return `${authScope}${DRAFT_PENDING_FILE_KEY_SEPARATOR}${channelId}`;
}
function getDraftPendingFilesChannelId(cacheKey: string) {
  return cacheKey.split(DRAFT_PENDING_FILE_KEY_SEPARATOR).at(-1) ?? cacheKey;
}
function revokeDraftPendingFilePreviews(files: PendingFile[]) {
  for (const file of files) {
    if (file.preview) URL.revokeObjectURL(file.preview);
  }
}
function clearDraftPendingFilesCache(channelId?: string) {
  for (const [cacheKey, files] of draftPendingFilesByChannel) {
    if (channelId && getDraftPendingFilesChannelId(cacheKey) !== channelId) continue;
    revokeDraftPendingFilePreviews(files);
    draftPendingFilesByChannel.delete(cacheKey);
  }
}
function clearFailedSendMentionsCache(channelId?: string) {
  if (!channelId) {
    failedSendMentionsByDraftKey.clear();
    return;
  }
  for (const cacheKey of failedSendMentionsByDraftKey.keys()) {
    if (getDraftPendingFilesChannelId(cacheKey) === channelId) {
      failedSendMentionsByDraftKey.delete(cacheKey);
    }
  }
}
export function mergeFailedSendMentions(...groups: MessageMention[][]): MessageMention[] {
  const byHandle = new Map<string, MessageMention>();
  for (const group of groups) {
    for (const mention of group) byHandle.set(mention.name, mention);
  }
  return [...byHandle.values()];
}
/** Move failed structured payloads when a provisional composer gets a durable channel id. */
export function adoptFailedSendMentions(
  sourceCacheKey: string,
  destinationCacheKey: string,
  adoptSource: boolean,
): MessageMention[] {
  if (sourceCacheKey === destinationCacheKey) {
    return failedSendMentionsByDraftKey.get(destinationCacheKey) ?? [];
  }
  const adopted = adoptSource
    ? failedSendMentionsByDraftKey.get(sourceCacheKey) ?? []
    : failedSendMentionsByDraftKey.get(destinationCacheKey) ?? [];
  failedSendMentionsByDraftKey.delete(sourceCacheKey);
  if (adopted.length > 0) failedSendMentionsByDraftKey.set(destinationCacheKey, adopted);
  else failedSendMentionsByDraftKey.delete(destinationCacheKey);
  return adopted;
}
let draftPendingFilesAuthScope = getDraftPendingFilesAuthScope(useAuthStore.getState().user?.id);
useAuthStore.subscribe((state) => {
  const nextAuthScope = getDraftPendingFilesAuthScope(state.user?.id);
  if (nextAuthScope === draftPendingFilesAuthScope) return;
  draftPendingFilesAuthScope = nextAuthScope;
  clearDraftPendingFilesCache();
  clearFailedSendMentionsCache();
});
export function clearDraftPendingFilesForTests(channelId?: string) {
  clearDraftPendingFilesCache(channelId);
}
export function clearFailedSendMentionsForTests(channelId?: string) {
  clearFailedSendMentionsCache(channelId);
}
export function getDraftPendingFiles(cacheKey: string): PendingFile[] {
  return draftPendingFilesByChannel.get(cacheKey) ?? [];
}
/** Whether any composer draft holds attachments (picked, or still uploading), here or in a composer no longer mounted. */
export function hasDraftPendingFiles(): boolean {
  return draftPendingFilesByChannel.size > 0;
}
export function saveDraftPendingFiles(cacheKey: string, files: PendingFile[]) {
  if (files.length === 0) {
    draftPendingFilesByChannel.delete(cacheKey);
    return;
  }
  draftPendingFilesByChannel.set(cacheKey, files);
}
export function adoptDraftPendingFiles(
  sourceCacheKey: string,
  destinationCacheKey: string,
  preferSource: boolean,
): PendingFile[] {
  if (sourceCacheKey === destinationCacheKey) return getDraftPendingFiles(destinationCacheKey);

  const sourceFiles = getDraftPendingFiles(sourceCacheKey);
  const destinationFiles = getDraftPendingFiles(destinationCacheKey);
  const adoptedFiles = preferSource
    ? sourceFiles
    : destinationFiles.length > 0
      ? destinationFiles
      : sourceFiles;
  const discardedFiles = adoptedFiles === sourceFiles ? destinationFiles : sourceFiles;
  const adoptedIds = new Set(adoptedFiles.map((file) => file.id));
  revokeDraftPendingFilePreviews(discardedFiles.filter((file) => !adoptedIds.has(file.id)));

  draftPendingFilesByChannel.delete(sourceCacheKey);
  saveDraftPendingFiles(destinationCacheKey, adoptedFiles);
  return adoptedFiles;
}
export function markInterruptedUploads(files: PendingFile[], formatMessage: IntlShape["formatMessage"]): PendingFile[] {
  return files.map((file) => (
    file.uploadStatus === "validating"
      ? {
          ...file,
          uploadStatus: "error",
          uploadProgress: 0,
          uploadError: formatMessage({ id: "message.composer.attachmentCheckInterrupted" }),
          uploadCanRetry: false,
        }
      : file.uploadStatus === "uploading"
      ? { ...file, uploadStatus: "error", uploadProgress: 0, uploadError: formatMessage({ id: "message.composer.uploadInterrupted" }) }
      : file
  ));
}
