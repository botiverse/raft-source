export const EXTERNAL_REACTION_MAPPING_REVISION = 1;

const BASE_MAPPINGS = [
  { emoji: "👍", slack: "thumbsup", aliases: ["+1"] },
  { emoji: "👎", slack: "thumbsdown", aliases: ["-1"] },
  { emoji: "❤️", slack: "heart", aliases: [] },
  { emoji: "😂", slack: "joy", aliases: [] },
  { emoji: "🎉", slack: "tada", aliases: [] },
  { emoji: "😮", slack: "open_mouth", aliases: [] },
  { emoji: "😢", slack: "cry", aliases: [] },
  { emoji: "🙏", slack: "pray", aliases: [] },
  { emoji: "👀", slack: "eyes", aliases: [] },
  { emoji: "✅", slack: "white_check_mark", aliases: [] },
  { emoji: "🔥", slack: "fire", aliases: [] },
  { emoji: "🚀", slack: "rocket", aliases: [] },
  { emoji: "👋", slack: "wave", aliases: [] },
] as const;

const TONES = ["🏻", "🏼", "🏽", "🏾", "🏿"] as const;
const TONE_BASES = new Set(["👍", "👎", "🙏", "👋"]);
const byEmoji = new Map<string, (typeof BASE_MAPPINGS)[number]>(
  BASE_MAPPINGS.map((mapping) => [mapping.emoji, mapping]),
);
const bySlack = new Map<string, (typeof BASE_MAPPINGS)[number]>(BASE_MAPPINGS.flatMap((mapping) => [
  [mapping.slack, mapping] as const,
  ...mapping.aliases.map((alias) => [alias, mapping] as const),
]));

export type ExternalReactionMapping = Readonly<{
  canonicalEmoji: string;
  providerReactionKey: string;
  mappingRevision: typeof EXTERNAL_REACTION_MAPPING_REVISION;
}>;

export function externalReactionToSlack(canonicalEmoji: string): ExternalReactionMapping | null {
  const codepoints = [...canonicalEmoji];
  const toneIndex = TONES.indexOf(codepoints.at(-1) as typeof TONES[number]);
  const baseEmoji = toneIndex >= 0 ? codepoints.slice(0, -1).join("") : canonicalEmoji;
  const mapping = byEmoji.get(baseEmoji);
  if (!mapping || (toneIndex >= 0 && !TONE_BASES.has(baseEmoji))) return null;
  return {
    canonicalEmoji,
    providerReactionKey: toneIndex >= 0
      ? `${mapping.slack}::skin-tone-${toneIndex + 2}`
      : mapping.slack,
    mappingRevision: EXTERNAL_REACTION_MAPPING_REVISION,
  };
}

export function externalReactionFromSlack(providerReactionKey: string): ExternalReactionMapping | null {
  const match = /^([^:]{1,80})(?:::skin-tone-([2-6]))?$/u.exec(providerReactionKey);
  if (!match) return null;
  const mapping = bySlack.get(match[1]!);
  if (!mapping) return null;
  const tone = match[2] ? TONES[Number(match[2]) - 2] : null;
  if (tone && !TONE_BASES.has(mapping.emoji)) return null;
  return {
    canonicalEmoji: `${mapping.emoji}${tone ?? ""}`,
    providerReactionKey: tone ? `${mapping.slack}::skin-tone-${match[2]}` : mapping.slack,
    mappingRevision: EXTERNAL_REACTION_MAPPING_REVISION,
  };
}
