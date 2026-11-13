import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { en } from "../src/i18n/messages/en";
import { enFallback } from "../src/i18n/messages/enFallback";

// enFallback.ts copies the English words code outside React reads
// synchronously (en.ts is a lazy chunk). Each copy must equal en.ts, and the
// English formatters built on it must ask only for ids it has.

test("every enFallback string is the en catalog's, word for word", () => {
  for (const [id, text] of Object.entries(enFallback)) {
    assert.equal(text, (en as Record<string, string>)[id], id);
  }
});

test("the English formatters and fallbacks ask only for ids enFallback has", () => {
  const src = resolve(import.meta.dirname, "../src");
  const files = [
    "utils/activity.ts",
    "utils/computerUpgradeIndicator.ts",
    "components/errors/AppUpdateGate.tsx",
    "components/errors/RootErrorFallback.tsx",
  ];
  const missing: string[] = [];
  for (const file of files) {
    const code = readFileSync(resolve(src, file), "utf8");
    for (const [, id] of code.matchAll(/"((?:[a-z][A-Za-z0-9]*)(?:\.[A-Za-z0-9]+)+)"/g)) {
      if (id in en && !(id in enFallback)) missing.push(`${file}: ${id}`);
    }
  }
  for (const file of ["components/agent/PixelAvatar.tsx", "components/ui/ProgressBar.tsx", "components/ui/FormField.tsx",
    "components/message/CollapsibleMessageContent.tsx", "components/message/MentionLink.tsx", "store/agentStore.ts", "utils/liveAgentActivity.ts"]) {
    const code = readFileSync(resolve(src, file), "utf8");
    assert.doesNotMatch(code, /from "[^"]*messages\/en"/, `${file} imports the lazy en catalog`);
  }
  assert.deepEqual(missing, []);
});
