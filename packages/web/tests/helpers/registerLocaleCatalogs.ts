// Production loads every catalog, en included, on demand (see
// src/i18n/messages/index.ts). Tests render any locale synchronously, so every
// test file starts with all catalogs of the shared locale registry registered.
import { DISPLAY_LOCALES } from "@botiverse/raft-shared";
import { registerLocaleMessages } from "../../src/i18n/messages";
import type { MessageId } from "../../src/i18n/messages";

for (const locale of DISPLAY_LOCALES) {
  const module = await import(`../../src/i18n/messages/${locale}.ts`) as Record<string, Partial<Record<MessageId, string>>>;
  const [catalog] = Object.values(module);
  registerLocaleMessages(locale, catalog);
}
