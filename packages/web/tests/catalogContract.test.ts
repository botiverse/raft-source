import assert from "node:assert/strict";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";
import type { MessageFormatElement } from "@formatjs/icu-messageformat-parser";

import { DISPLAY_LOCALES, displayLocaleTag } from "@botiverse/raft-shared";
import type { DisplayLocale } from "@botiverse/raft-shared";
import { en as enMessages } from "../src/i18n/messages/en";

// Translated-catalog contract, run for every display locale in the shared
// registry (a new locale is covered the moment it is added). The conventions
// live in docs/frontend/i18n/; these are the ones a machine can check, so a value
// that breaks the rendered message or the house style goes red here instead of
// waiting for a reader of that language to notice.
//
// zh-cn is held to its own, older contracts (zhCatalogSpacingContract,
// zhEllipsisForm, catalogConsistencyRatchet, …) owned by its language owner.

const en = enMessages as Record<string, string>;
const LOCALES = DISPLAY_LOCALES.filter((locale) => locale !== "en" && locale !== "zh-cn");

async function catalog(locale: DisplayLocale): Promise<Partial<Record<string, string>>> {
  const module = await import(`../src/i18n/messages/${locale}.ts`) as Record<string, Partial<Record<string, string>>>;
  const [messages] = Object.values(module);
  return messages;
}

type Shape = { args: string[]; formats: string[]; selects: string[]; plurals: string[][]; literal: string[] };

function shape(message: string): Shape {
  const out: Shape = { args: [], formats: [], selects: [], plurals: [], literal: [] };
  const walk = (elements: MessageFormatElement[]) => {
    for (const element of elements) {
      if (element.type === TYPE.literal) out.literal.push(element.value);
      if (element.type === TYPE.argument || element.type === TYPE.plural) out.args.push(element.value);
      if (element.type === TYPE.number || element.type === TYPE.date || element.type === TYPE.time) {
        out.args.push(element.value);
        out.formats.push(`${element.value}:${element.type}:${JSON.stringify(element.style ?? null)}`);
      }
      if (element.type === TYPE.tag) {
        out.args.push(`<${element.value}>`);
        walk(element.children);
      }
      if (element.type === TYPE.select) {
        out.args.push(element.value);
        out.selects.push(`${element.value}:${Object.keys(element.options).sort().join(",")}`);
      }
      if (element.type === TYPE.plural) out.plurals.push(Object.keys(element.options));
      if (element.type === TYPE.select || element.type === TYPE.plural) {
        for (const option of Object.values(element.options)) walk(option.value);
      }
    }
  };
  walk(parse(message));
  return out;
}

const sorted = (values: string[]) => [...new Set(values)].sort();

type StyleRule = { name: string; offenders: (value: string, literal: string[]) => string | null };

/** CJK against an ASCII letter or digit in literal text: the zh-cn 盘古之白 rule. */
function cjkAsciiSpacing(script: RegExp): StyleRule["offenders"] {
  const ascii = /[A-Za-z0-9]/;
  return (_value, literal) => {
    for (const text of literal) {
      for (let i = 0; i < text.length - 1; i++) {
        const [a, b] = [text[i], text[i + 1]];
        if ((script.test(a) && ascii.test(b)) || (ascii.test(a) && script.test(b))) return JSON.stringify(a + b);
      }
    }
    return null;
  };
}

const CURLY_QUOTED_NAMES: StyleRule = {
  // `“{name}”`: a straight quote pair around a placeholder reads as code.
  name: "names in curly quotes, not straight ones",
  offenders: (value) => value.match(/"\{[^{}]+\}"/)?.[0] ?? null,
};

/** Per-language style rules; a locale without an entry gets the generic ones only. */
const STYLE: Partial<Record<DisplayLocale, StyleRule[]>> = {
  es: [
    {
      name: "a question opens with ¿",
      offenders: (_value, literal) =>
        literal.find((text) => /[\p{L}\d”)…]\?(\s|$)/u.test(text) && !literal.join("").includes("¿")) ?? null,
    },
    {
      // Neutral Spanish for every region: tú, never usted, voseo or vosotros.
      name: "tú, never usted, voseo or vosotros",
      offenders: (value) => value.match(/\b(usted(es)?|vos|querés|tenés|podés|vosotros|vuestr[oa]s?)\b/i)?.[0] ?? null,
    },
    CURLY_QUOTED_NAMES,
  ],
  "pt-br": [
    {
      name: "Brazilian, not European, Portuguese",
      offenders: (value) =>
        value.match(/\b(ficheiros?|ecrã|utilizador(es)?|telemóve(l|is)|registar|partilhar)\b/i)?.[0] ?? null,
    },
    {
      name: "você, never tu",
      offenders: (value) => value.match(/\b(tu|teu|tua|contigo)\b/i)?.[0] ?? null,
    },
    CURLY_QUOTED_NAMES,
  ],
  ru: [
    {
      // Whole numbers pick one (1, 21…), few (2–4, 22…) or many (0, 5–20…): a
      // plural missing any of them prints the wrong noun form for some count.
      name: "plurals have one, few and many arms",
      offenders: (value) =>
        shape(value).plurals.find((arms) => !["one", "few", "many"].every((arm) => arms.includes(arm)))?.join(",") ?? null,
    },
    {
      // docs/frontend/i18n/ru.md: lowercase вы mid-sentence, never ты.
      name: "lowercase вы, never ты",
      offenders: (_value, literal) => {
        for (const text of literal) {
          const found =
            text.match(/[^.!?…]\s(Вы|Вас|Вам|Вами|Ваш\p{L}*)(?!\p{L})/u)?.[1] ??
            text.match(/(?<!\p{L})(ты|тебя|тебе|тобой|твой|твоя|твоё|твои|твоих|твоим)(?!\p{L})/iu)?.[1];
          if (found) return found;
        }
        return null;
      },
    },
    {
      name: "names in «» quotes",
      offenders: (value) => value.match(/"\{[^{}]+\}"|“\{[^{}]+\}”/)?.[0] ?? null,
    },
  ],
  "zh-tw": [
    {
      name: "half-width space between Chinese and ASCII letters/digits",
      offenders: cjkAsciiSpacing(/[㐀-䶿一-鿿]/),
    },
    {
      // Characters that exist only in Simplified Chinese.
      name: "Traditional characters only",
      offenders: (value) =>
        value.match(/[们这个还让吗请该设删载务级项发门网络览过进选择动态关闭启说话时间么为对样经认证处统应显钮页确创开题档]/)?.[0] ?? null,
    },
    {
      // Taiwan usage (docs/frontend/i18n/zh-tw.md), not mainland terms in Traditional characters.
      name: "Taiwan terms",
      offenders: (value) =>
        value.match(
          /服務器|用戶(?!端)|賬號|賬戶|默認|設置|創建|鏈接|軟件|網絡|信息|質量|套餐|計算機|消息列|收件箱|文件夾|屏幕|菜單|加載|搜索|粘貼|緩存|內存|激活|歸檔|置頂|智能體|令牌|文檔|自定義|只讀|卸載|內置|反饋|字符|隊列|代碼|私信|所有者/,
        )?.[0] ?? null,
    },
  ],
  ja: [
    {
      // The zh-cn 盘古之白 rule, shared with the mobile ja catalog: `Raft のアカウント`,
      // `{count} 件`. Placeholder boundaries are excluded exactly as in zh-cn.
      name: "half-width space between Japanese and ASCII letters/digits",
      offenders: cjkAsciiSpacing(/[぀-ヿ㐀-䶿一-鿿]/),
    },
    {
      name: "settled terms (long-vowel katakana, ログイン)",
      offenders: (value) => value.match(/サインイン|サーバ(?!ー)|コンピュータ(?!ー)|ブラウザ(?!ー)|ユーザ(?!ー)|フォルダ(?!ー)/)?.[0] ?? null,
    },
  ],
  ko: [
    {
      name: "half-width punctuation and ‘ ’ quotes, never CJK fullwidth marks",
      offenders: (value) => value.match(/[。、，？！：；（）「」『』]/)?.[0] ?? null,
    },
    {
      name: "no 당신: Korean UI copy leaves the reader implicit",
      offenders: (value) => (value.includes("당신") ? "당신" : null),
    },
  ],
};

for (const locale of LOCALES) {
  const pluralCategories = new Intl.PluralRules(displayLocaleTag(locale)).resolvedOptions().pluralCategories as string[];

  test(`${locale}: every value parses and keeps en's placeholders, tags, number/date formats and select arms`, async () => {
    // A count may be a plain argument or a plural, exactly as zh-cn does;
    // anything else that renders must survive.
    const messages = await catalog(locale);
    const offenders: string[] = [];
    for (const [id, source] of Object.entries(en)) {
      // An id the catalog lacks renders the English (the catalogs here are Partial).
      if (messages[id] === undefined) continue;
      let ours: Shape;
      try {
        ours = shape(messages[id]);
      } catch (error) {
        offenders.push(`${id}: does not parse (${(error as Error).message})`);
        continue;
      }
      const theirs = shape(source);
      for (const key of ["args", "formats", "selects"] as const) {
        if (sorted(ours[key]).join("|") !== sorted(theirs[key]).join("|")) {
          offenders.push(`${id}: ${key} ${sorted(ours[key]).join(",")} ≠ en ${sorted(theirs[key]).join(",")}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  test(`${locale}: plural arms are the language's own categories (${pluralCategories.join(", ")})`, async () => {
    // Intl.PluralRules says which arms the language can select: ja/ko have only
    // `other`; es/pt have `one` and `many` too, and must keep `one` where en has it.
    const messages = await catalog(locale);
    const offenders: string[] = [];
    for (const [id, value] of Object.entries(messages)) {
      const enArms = new Set(shape(en[id]).plurals.flat());
      for (const arms of shape(value).plurals) {
        const unknown = arms.filter((arm) => arm !== "other" && !/^=\d+$/.test(arm) && !pluralCategories.includes(arm));
        if (unknown.length || !arms.includes("other")) offenders.push(`${id}: ${arms.join(",")}`);
        if (pluralCategories.includes("one") && enArms.has("one") && !arms.includes("one")) offenders.push(`${id}: missing one`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test(`${locale}: no ASCII apostrophe (the ICU escape character) and a single … ellipsis`, async () => {
    // `Bearer ...` is a sample header value, not prose (same exemption as zh-cn).
    const SAMPLE_DOTS = new Set(["agent.mcp.bearerPlaceholder"]);
    const messages = await catalog(locale);
    const offenders = Object.entries(messages)
      .filter(([id, value]) => value.includes("'") || value.includes("……") || (value.includes("...") && !SAMPLE_DOTS.has(id)))
      .map(([id, value]) => `${id}: ${value}`);
    assert.deepEqual(offenders, []);
  });

  for (const rule of STYLE[locale] ?? []) {
    test(`${locale}: ${rule.name}`, async () => {
      const messages = await catalog(locale);
      const offenders = Object.entries(messages).flatMap(([id, value]) => {
        const found = rule.offenders(value, shape(value).literal);
        return found ? [`${id}: ${found} in ${JSON.stringify(value)}`] : [];
      });
      assert.deepEqual(offenders, []);
    });
  }
}

test("the contract covers every translated display locale", () => {
  assert.ok(LOCALES.length > 0);
  for (const locale of LOCALES) assert.ok(STYLE[locale], `${locale} has no style rules; add its conventions here`);
});
