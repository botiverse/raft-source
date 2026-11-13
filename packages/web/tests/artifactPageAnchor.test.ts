// A place a page names itself (P108): the panel shows the page's label (its
// name where it gave none) and its quote as the page's own excerpt, never as
// a passage the person selected (Tenny).
import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import type { ArtifactCommentAnchor } from "@botiverse/raft-shared";

import { anchorLabel, anchorQuote, quoteIsPagesOwn } from "../src/apps/artifacts/ArtifactActorParts";
import { en } from "../src/i18n/messages/en";

const intl = createIntl({ locale: "en", messages: en });

test("a page anchor: its label, else its name, as text; its quote the page's excerpt", () => {
  const page: ArtifactCommentAnchor = { type: "page", data: { name: "card-3", label: "Card 3: ship Friday?", quote: "Ship on Friday" } };
  const bare: ArtifactCommentAnchor = { type: "page", data: { name: "refs/a.md#L12" } };
  assert.equal(anchorLabel(page, intl), "Card 3: ship Friday?");
  assert.equal(anchorLabel(bare, intl), "refs/a.md#L12");
  assert.equal(anchorQuote(page), "Ship on Friday");
  assert.equal(anchorQuote(bare), null);
  assert.equal(quoteIsPagesOwn(page), true);
  assert.equal(
    intl.formatMessage({ id: "artifacts.comments.anchorWithPageExcerpt" }, { place: anchorLabel(page, intl), quote: anchorQuote(page) }),
    "Card 3: ship Friday?: the page's excerpt “Ship on Friday”",
  );
});

test("a selection's quote is the person's: not marked as the page's", () => {
  const lines: ArtifactCommentAnchor = { type: "lines", data: { start: 3, end: 3, quote: "x" } };
  const annotation: ArtifactCommentAnchor = { type: "annotation", data: { kind: "text", label: "Heading", selectors: [{ type: "TextQuoteSelector", exact: "x" }] } };
  assert.equal(quoteIsPagesOwn(lines), false);
  assert.equal(quoteIsPagesOwn(annotation), false);
});
