import assert from "node:assert/strict";

import { DISPLAY_LOCALES, displayLocaleTag } from "@botiverse/raft-shared";
import feedbackConfig from "../vite.feedback.config";
import { FEEDBACK_HOST_LOCALES } from "../src/feedback/standalone/host";

// The standalone feedback page's copy is built at config time, keyed by the
// native host's session locale (each display locale's BCP 47 tag). A ja/ko
// catalog once landed under the `en` key and the English page rendered Korean
// (staging e2e: no "Retry submission").
test("the feedback page's copy is keyed by host locale, each from its own catalog", async () => {
  const define = (feedbackConfig as { define: Record<string, string> }).define;
  const copy = JSON.parse(define.__RAFT_FEEDBACK_COPY__) as Record<string, Record<string, string>>;
  assert.deepEqual(Object.keys(copy).sort(), [...FEEDBACK_HOST_LOCALES].sort());
  for (const locale of DISPLAY_LOCALES) {
    const module = await import(`../src/i18n/messages/${locale}.ts`) as Record<string, Record<string, string>>;
    const [messages] = Object.values(module);
    const entries = copy[displayLocaleTag(locale)];
    assert.ok(entries && Object.keys(entries).length > 0, locale);
    for (const [id, value] of Object.entries(entries)) assert.equal(value, messages[id], `${locale} ${id}`);
  }
  assert.equal(copy.en["feedback.native.diagnostics.retry"], "Retry submission");
});
