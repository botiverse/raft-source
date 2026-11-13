import assert from "node:assert/strict";

import { formatBillingAmount } from "../src/utils/formatBillingAmount";

// ICU versions differ in the space they put inside a currency (U+00A0 or
// U+202F), so compare with spaces normalized.
const spaced = (value: string) => value.replace(/[  ]/g, " ");

test("billing amounts follow the display language's currency format", () => {
  // The display locale's BCP 47 tag is what IntlProvider hands the plan section.
  assert.equal(formatBillingAmount(123450, "usd", "en"), "$1,234.50");
  assert.equal(spaced(formatBillingAmount(123450, "usd", "pt-BR")), "US$ 1.234,50");
  assert.equal(spaced(formatBillingAmount(123450, "usd", "zh-CN")), "US$1,234.50");
  assert.equal(formatBillingAmount(-500, "USD", "en"), "-$5.00");
});
