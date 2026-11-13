import assert from "node:assert/strict";

import { en } from "../src/i18n/messages/en";
import { es } from "../src/i18n/messages/es";
import { ja } from "../src/i18n/messages/ja";
import { ko } from "../src/i18n/messages/ko";
import { ptBr } from "../src/i18n/messages/pt-br";
import { zhCn } from "../src/i18n/messages/zh-cn";
import { zhTw } from "../src/i18n/messages/zh-tw";
import type { Locale } from "../src/i18n/locale";

// The public Artifact page's AI prompt carries a bare URL. Punctuation right
// after it ("…/index.md,") is read as part of the address by many linkifiers
// and by the AI itself, which then fetches a URL that doesn't exist. So in
// every locale the URL ends the string or is followed by whitespace.
test("the Artifact AI prompt never glues punctuation to the URL", () => {
  // Typed by Locale, so a new locale fails typecheck here until it is listed.
  const catalogs: Record<Locale, object> = { en, es, ja, ko, "pt-br": ptBr, "zh-cn": zhCn, "zh-tw": zhTw };
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const prompt = (catalog as Record<string, string>)["artifacts.public.aiPrompt"];
    assert.ok(prompt?.includes("{url}"), `${locale} prompt carries {url}`);
    assert.match(prompt, /\{url\}(?:\s|$)/, `${locale}: ${prompt}`);
  }
});
