import { legacyStatePath, privateStatePath, readPrivateStateWithLegacyImport, writePrivateState } from "./_privateStateFile.js";
import { agentApiStructuredMentionSchema, type AgentApiStructuredMention } from "@botiverse/raft-shared";

export interface SavedDraft {
  content: string;
  attachmentIds: string[];
  mentions?: AgentApiStructuredMention[];
  savedAt: number;
  reholdCount: number;
  seenUpToSeq?: number;
}

interface DraftStateFile {
  targets?: Record<string, string | SavedDraft>;
}

const DEFAULT_LOCAL_DRAFT_TTL_MS = 10 * 60 * 1000;

const DRAFT_STATE_NAMESPACE = "slock-cli-attested-send";
const DRAFT_STATE_FILENAME = "continue-state.json";

function stateFilePath(agentId: string): string {
  return privateStatePath(process.env.SLOCK_CLI_DRAFT_STATE_DIR, DRAFT_STATE_NAMESPACE, agentId, DRAFT_STATE_FILENAME);
}

function readState(agentId: string): DraftStateFile {
  try {
    const raw = readPrivateStateWithLegacyImport(
      stateFilePath(agentId),
      legacyStatePath(process.env.SLOCK_CLI_DRAFT_STATE_DIR, DRAFT_STATE_NAMESPACE, agentId, DRAFT_STATE_FILENAME),
    );
    const parsed = JSON.parse(raw) as DraftStateFile;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(agentId: string, state: DraftStateFile): void {
  const filePath = stateFilePath(agentId);
  writePrivateState(filePath, JSON.stringify(state));
}

export function getSavedDraft(agentId: string, target: string): SavedDraft | null {
  const state = readState(agentId);
  const draft = state.targets?.[target];
  if (!draft || typeof draft === "string") return null;
  if (typeof draft.content !== "string") return null;
  const attachmentIds = Array.isArray(draft.attachmentIds)
    ? draft.attachmentIds.filter((item): item is string => typeof item === "string")
    : [];
  const mentions: AgentApiStructuredMention[] | undefined = Array.isArray(draft.mentions)
    ? draft.mentions.flatMap((item) => {
      const parsed = agentApiStructuredMentionSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    })
    : undefined;
  const savedAt = Number.isFinite(draft.savedAt) ? draft.savedAt : Date.now();
  const reholdCount = Number.isFinite(draft.reholdCount) ? draft.reholdCount : 0;
  const seenUpToSeq = Number.isFinite(draft.seenUpToSeq) ? draft.seenUpToSeq : undefined;
  if (Date.now() - savedAt > DEFAULT_LOCAL_DRAFT_TTL_MS) {
    clearSavedDraft(agentId, target);
    return null;
  }
  return {
    content: draft.content,
    attachmentIds,
    ...(mentions && mentions.length > 0 ? { mentions } : {}),
    savedAt,
    reholdCount,
    seenUpToSeq,
  };
}

export function setSavedDraft(agentId: string, target: string, draft: SavedDraft): void {
  const state = readState(agentId);
  const targets = state.targets ?? {};
  targets[target] = {
    content: draft.content,
    attachmentIds: draft.attachmentIds,
    ...(draft.mentions && draft.mentions.length > 0 ? { mentions: draft.mentions } : {}),
    savedAt: draft.savedAt,
    reholdCount: draft.reholdCount,
    ...(draft.seenUpToSeq !== undefined ? { seenUpToSeq: draft.seenUpToSeq } : {}),
  };
  writeState(agentId, { targets });
}

export function clearSavedDraft(agentId: string, target: string): void {
  const state = readState(agentId);
  if (!state.targets || !(target in state.targets)) return;
  delete state.targets[target];
  writeState(agentId, state);
}
