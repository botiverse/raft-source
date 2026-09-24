import { RUNTIME_PROVIDER_DISPLAY_NAMES } from "./generated/runtimeProviderDisplayNames.js";

export { RUNTIME_PROVIDER_DISPLAY_NAMES };
export type { RuntimeProviderId } from "./generated/runtimeProviderDisplayNames.js";

export function getRuntimeProviderDisplayName(providerId: string): string {
  return RUNTIME_PROVIDER_DISPLAY_NAMES[providerId as keyof typeof RUNTIME_PROVIDER_DISPLAY_NAMES]
    ?? humanizeRuntimeProviderSegment(providerId);
}

export function formatRuntimeProviderModelLabel(modelId: string): string {
  const separatorIndex = modelId.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === modelId.length - 1) return modelId;

  const providerId = modelId.slice(0, separatorIndex);
  const modelName = modelId.slice(separatorIndex + 1);
  const providerLabel = getRuntimeProviderDisplayName(providerId);
  const modelParts = modelName.split("/");
  const modelLabel = humanizeRuntimeProviderSegment(modelParts[modelParts.length - 1] || modelName);
  if (modelParts.length === 1) return `${modelLabel} · ${providerLabel}`;

  const upstreamLabel = modelParts
    .slice(0, -1)
    .map(getRuntimeProviderDisplayName)
    .join(" / ");
  return `${modelLabel} · ${upstreamLabel} via ${providerLabel}`;
}

export function humanizeRuntimeProviderSegment(value: string): string {
  return value
    .replace(/\[(\d+)m\]/gi, "-$1m")
    .split(/[-_/]/)
    .filter(Boolean)
    .map(formatRuntimeProviderLabelToken)
    .join(" ");
}

function formatRuntimeProviderLabelToken(token: string): string {
  const normalized = token.toLowerCase();
  const specialCases: Record<string, string> = {
    ai: "AI",
    api: "API",
    chatgpt: "ChatGPT",
    claude: "Claude",
    codestral: "Codestral",
    deepseek: "DeepSeek",
    flash: "Flash",
    free: "Free",
    gemini: "Gemini",
    glm: "GLM",
    gpt: "GPT",
    hy3: "HY3",
    kimi: "Kimi",
    minimax: "MiniMax",
    nano: "Nano",
    nemotron: "Nemotron",
    omni: "Omni",
    opus: "Opus",
    openai: "OpenAI",
    pro: "Pro",
    sonnet: "Sonnet",
    super: "Super",
  };
  if (specialCases[normalized]) return specialCases[normalized];
  if (normalized === "b" || normalized === "m") return normalized.toUpperCase();
  if (/^v\d+(\.\d+)?$/.test(normalized)) return normalized.toUpperCase();
  if (/^\d+m$/i.test(token)) return token.toUpperCase();
  if (/^\d+[bk]$/i.test(token)) return token.toUpperCase();
  if (/^m\d+(\.\d+)?$/i.test(token)) return token.toUpperCase();
  if (/^\d/.test(token)) return token;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
