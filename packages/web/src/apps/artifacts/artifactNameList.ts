import type { IntlShape } from "react-intl";

/** A Han character: the conjunction a Chinese list puts between its last two names (和, 與, 及). */
const HAN = /\p{Script=Han}/u;
/** A character that needs no space beside a Chinese word: Chinese, Japanese or Korean, their punctuation, a space. */
const NO_SPACE_BESIDE = /[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

/**
 * Names as one list in the reader's language, through the locale's list formatting
 * (Intl.ListFormat: "Ana, Pico and Martin", "Ana、Pico和Martin"). In Chinese a space then goes
 * between the conjunction and a name that starts or ends in Latin letters or digits, as Raft's own
 * Chinese strings set a name apart ("你、{first} 和 {second}"): CLDR's pattern runs it into the
 * name ("和Martin"). Other locales' lists are as Intl gives them.
 */
export function formatNameList(intl: Pick<IntlShape, "locale" | "formatList" | "formatListToParts">, names: readonly string[]): string {
  if (!/^zh\b/i.test(intl.locale)) return intl.formatList(names, { type: "conjunction" });
  const parts = intl.formatListToParts(names, { type: "conjunction" });
  return parts.map((part, index) => {
    const value = String(part.value);
    if (part.type !== "literal" || !HAN.test(value)) return value;
    const before = String(parts[index - 1]?.value ?? "").slice(-1);
    const after = String(parts[index + 1]?.value ?? "").slice(0, 1);
    return `${before === "" || NO_SPACE_BESIDE.test(before) ? "" : " "}${value}${after === "" || NO_SPACE_BESIDE.test(after) ? "" : " "}`;
  }).join("");
}
