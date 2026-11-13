// List the en ids each translated catalog lacks: they render the English until
// backfilled (docs/frontend/i18n/README.md). zh-cn may never lack one (its
// type and tests/i18nMessages.test.ts say so), so it is not listed.
//
//   node --import @oxc-node/core/register scripts/i18n-missing.ts            # counts per locale
//   node --import @oxc-node/core/register scripts/i18n-missing.ts --ids      # plus the ids
//   node --import @oxc-node/core/register scripts/i18n-missing.ts --json     # { locale: [ids] }
import { DISPLAY_LOCALES } from "@botiverse/raft-shared/src/displayLocales";

const { en } = await import("../src/i18n/messages/en");
const result = {};
for (const locale of DISPLAY_LOCALES) {
  if (locale === "en" || locale === "zh-cn") continue;
  const [catalog] = Object.values(await import(`../src/i18n/messages/${locale}.ts`));
  result[locale] = Object.keys(en).filter((id) => !(id in catalog));
}
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 1));
} else {
  for (const [locale, ids] of Object.entries(result)) {
    console.log(`${locale}: ${ids.length} missing`);
    if (process.argv.includes("--ids")) for (const id of ids) console.log(`  ${id}`);
  }
}
