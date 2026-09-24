export interface CreateAgentLastConfig {
  machineId: string;
  runtime: string;
  model: string;
  customModelMode: boolean;
}

const STORAGE_KEY_PREFIX = "raft:create-agent:last-config:v1:";
const MAX_PREFERENCE_VALUE_LENGTH = 512;

function storageKey(serverId: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(serverId)}`;
}

function isPreferenceValue(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string"
    && value.length <= MAX_PREFERENCE_VALUE_LENGTH
    && (allowEmpty || value.length > 0);
}

function parseCreateAgentLastConfig(value: unknown): CreateAgentLastConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !isPreferenceValue(candidate.machineId)
    || !isPreferenceValue(candidate.runtime)
    || !isPreferenceValue(candidate.model, true)
    || typeof candidate.customModelMode !== "boolean"
  ) {
    return null;
  }
  return {
    machineId: candidate.machineId,
    runtime: candidate.runtime,
    model: candidate.model,
    customModelMode: candidate.customModelMode,
  };
}

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readCreateAgentLastConfig(
  serverId: string,
  storage: Storage | null = browserStorage(),
): CreateAgentLastConfig | null {
  if (!serverId || !storage) return null;
  try {
    const raw = storage.getItem(storageKey(serverId));
    return raw ? parseCreateAgentLastConfig(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeCreateAgentLastConfig(
  serverId: string,
  config: CreateAgentLastConfig,
  storage: Storage | null = browserStorage(),
): void {
  if (!serverId || !storage) return;
  const parsed = parseCreateAgentLastConfig(config);
  if (!parsed) return;
  try {
    storage.setItem(storageKey(serverId), JSON.stringify(parsed));
  } catch {
    // Preferences are best-effort and must never make agent creation fail.
  }
}
