export const MIN_KNOWLEDGE_CONTEXT_LENGTH = 12;
export const MAX_KNOWLEDGE_CONTEXT_LENGTH = 500;
export const RAFT_CLIENT_CAPABILITIES_HEADER = "X-Raft-Client-Capabilities";
export const MANUAL_CONTEXT_CAPABILITY = "manual-context-v1";
export const MANUAL_INDEX_COMMAND = "raft manual get index --intent \"Learn available Raft workflows\" --reason \"Browse the topic catalog after a missing topic\"";

export type KnowledgeContextField = "intent" | "reason";

export function hasManualContextCapability(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  return raw
    .split(",")
    .some((value) => value.trim().toLowerCase() === MANUAL_CONTEXT_CAPABILITY);
}

export type KnowledgeContextValidationResult =
  | { ok: true; value: string }
  | { ok: false; value: null; error: string };

export function validateKnowledgeContext(
  raw: unknown,
  field: KnowledgeContextField,
): KnowledgeContextValidationResult {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, value: null, error: `${field} is required` };
  }
  if (typeof raw !== "string") {
    return { ok: false, value: null, error: `${field} must be a string` };
  }

  const value = raw.trim();
  if (value.length < MIN_KNOWLEDGE_CONTEXT_LENGTH) {
    return {
      ok: false,
      value: null,
      error: `${field} must be at least ${MIN_KNOWLEDGE_CONTEXT_LENGTH} characters`,
    };
  }
  if (value.length > MAX_KNOWLEDGE_CONTEXT_LENGTH) {
    return {
      ok: false,
      value: null,
      error: `${field} must be at most ${MAX_KNOWLEDGE_CONTEXT_LENGTH} characters`,
    };
  }

  const unsafeError = classifyUnsafeKnowledgeContext(value, field);
  if (unsafeError) return { ok: false, value: null, error: unsafeError };
  return { ok: true, value };
}

function classifyUnsafeKnowledgeContext(value: string, field: KnowledgeContextField): string | null {
  if (/\[target=.*\bmsg=/.test(value)) return `${field} must not contain raw Slock message headers`;
  if (/```[\s\S]*```/.test(value)) return `${field} must not contain raw prompts or code blocks`;
  if (/https?:\/\//i.test(value)) return `${field} must not contain URLs`;
  if (/\bsk_(?:agent|machine|computer)_[a-z0-9_-]+\b/i.test(value)) {
    return `${field} must not contain credentials`;
  }
  if (/\bBearer\s+\S+/i.test(value) || /\b(?:api[_ -]?key|token|password|secret)\s*[:=]\s*\S+/i.test(value)) {
    return `${field} must not contain credentials`;
  }
  if (value.split(/\r?\n/).length > 4) return `${field} must be a concise natural-language summary`;
  return null;
}
