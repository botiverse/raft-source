import assert from "node:assert/strict";

import { SUPPORTED_LOCALES } from "../src/i18n/locale";
import { loadLocaleMessages, mergedMessages } from "../src/i18n/messages";

// RFC-067 default on: signing up accepts privacy version 2026-10-14, and the
// line under the sign-up Continue button is the only notice a new user gets that
// usage data is collected and where to turn it off. Every display locale must
// say so; a locale without it would sign people up to sharing they were never
// told about. Locales added after the notice was first written (es, ja, ko,
// pt-br, zh-tw) once shipped without it, which is what this guards. The check
// is that the notice names that locale's own word for Settings.
test("every locale's sign-up notice says usage data is collected and can be turned off in Settings", async () => {
  for (const locale of SUPPORTED_LOCALES) {
    await loadLocaleMessages(locale);
    const messages = mergedMessages(locale) as Record<string, string>;
    const agreement = messages["auth.legalAcceptance.agreement"];
    const notice = messages["auth.legalAcceptance.usageDataNotice"];
    const settings = messages["layout.leftRail.tabSettings"];
    assert.ok(settings, `${locale}: no Settings label`);
    assert.ok(agreement.includes("<terms>") && agreement.includes("<privacy>"), `${locale}: the agreement keeps both links`);
    assert.ok(notice.includes(settings), `${locale}: the notice must say it can be turned off in ${settings}: ${notice}`);
    assert.ok(notice.includes("Raft"), `${locale}: the notice names Raft: ${notice}`);
  }
});
