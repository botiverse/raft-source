import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup } from "@testing-library/react";

import { DateDivider } from "../src/components/message/DateDivider";
import { renderWithIntl } from "./helpers/intl";

afterEach(() => cleanup());

test("message date divider follows the active app locale for full date labels", () => {
  renderWithIntl(
    <DateDivider createdAt="2026-01-05T12:00:00.000Z" testId="divider" />,
    { locale: "zh-cn" },
  );

  const text = document.querySelector("[data-testid='divider']")?.textContent ?? "";
  assert.match(text, /1月|星期/, "full date divider should render with zh date words");
  assert.doesNotMatch(text, /January|Monday/i, "full date divider must not leak browser-locale English");
});
