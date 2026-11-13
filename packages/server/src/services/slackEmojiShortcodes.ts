import emojiData from "emoji-datasource/emoji.json" with { type: "json" };

// emoji-datasource is pinned; use its Slack/iamcal aliases and exact skin
// variations instead of assembling ZWJ sequences or maintaining a partial list.
interface EmojiDefinition {
  unified: string;
  short_names: readonly string[];
  skin_variations?: Record<string, { unified: string }>;
}

function unicode(hex: string): string {
  return String.fromCodePoint(...hex.split("-").map((part) => Number.parseInt(part, 16)));
}

const shortcodes = new Map<string, string>();
for (const emoji of emojiData as readonly EmojiDefinition[]) {
  for (const name of emoji.short_names) {
    shortcodes.set(`:${name}:`, unicode(emoji.unified));
    for (const [tones, variation] of Object.entries(emoji.skin_variations ?? {})) {
      const suffix = tones.split("-").map((tone) => `:skin-tone-${Number.parseInt(tone, 16) - 0x1f3fb + 2}:`).join("");
      shortcodes.set(`:${name}:${suffix}`, unicode(variation.unified));
    }
  }
}

// Code, URLs and Slack angle-bracket tokens are literal contexts. Only the
// shortcode alternative captures; unknown/custom names retain their source.
// Scheme matching ignores case; map lookup keeps emoji names case-sensitive.
// Consume a complete tone chain so an unsupported/escaped chain stays literal.
const TOKENS = /```[\s\S]*?(?:```|$)|`[^`\r\n]*(?:`|(?=\r?\n)|$)|<[^>\r\n]*>|https?:\/\/[^\s<>`]+|\\:[a-zA-Z0-9_+\-]+:(?::skin-tone-\d+:)*|(:[a-zA-Z0-9_+\-]+:(?::skin-tone-\d+:)*)/giu;

export function renderSlackEmojiShortcodes(content: string): string {
  const rendered = content.replace(TOKENS, (token: string, shortcode: string | undefined) =>
    shortcode ? shortcodes.get(shortcode) ?? token : token);
  // Short aliases for flags can expand UTF-8 bytes. Keep the original body if
  // conversion would exceed the existing message bound, never lose a message.
  return Buffer.byteLength(rendered, "utf8") <= 40_000 ? rendered : content;
}
