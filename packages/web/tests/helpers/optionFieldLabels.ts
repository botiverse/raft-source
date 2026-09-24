import assert from "node:assert/strict";

/**
 * The boolean option fields render two levels of text: the Field's own group
 * label (uppercase, e.g. "IMAGE INPUT") and the option name on the CardTitle
 * inside it (e.g. "Supports image input").
 *
 * Both levels are load-bearing and they must not say the same thing. That is
 * not a style preference — it is the regression this guards:
 *
 *   29acf6fa removed the Card and hoisted the option name up into the group
 *   label, which was correct while the field carried the only label. 1926886
 *   brought the option cards back but left the hoisted label behind, so both
 *   image-input fields rendered the option name twice — "SUPPORTS IMAGE INPUT"
 *   above a card titled "Supports image input".
 *
 * The whole suite (2046 tests) stayed green through that, and reading the diff
 * did not show it either: the break was a one-token change of message id, and
 * every existing assertion looked at the CardTitle / accessible name, which
 * both stayed correct. Only rendering the branch exposed it.
 *
 * Call this with the REAL control from the REAL dialog. A hand-built copy of
 * this shape has already been observed to stay green through this bug once.
 */
export function assertOptionFieldLabels(
  control: Element,
  expected: { groupLabel: string; optionName: string },
) {
  const field = control.closest('[data-slot="field"]');
  assert.ok(field, "the option must sit inside a Field that owns the group label");

  const groupLabel = (field.querySelector('[data-slot="field-label"]')?.textContent ?? "").trim();
  assert.ok(groupLabel, "the Field must still carry a group label");

  const optionTitle = (field.querySelector('[data-slot="card-title"]')?.textContent ?? "").trim();
  assert.ok(optionTitle, "the option must carry its own title");

  assert.equal(
    groupLabel,
    expected.groupLabel,
    `the group label must stay the generic section name; it read "${groupLabel}"`,
  );
  assert.equal(
    optionTitle,
    expected.optionName,
    `the option title names the control; it read "${optionTitle}"`,
  );

  // Stated separately from the two equalities above, because THIS is the shape
  // that regressed: whatever the two strings are, one must not be the other.
  assert.notEqual(
    groupLabel.toLowerCase(),
    optionTitle.toLowerCase(),
    `the group label and the option name must not be the same words — ` +
      `both read "${groupLabel}", which is the double-label shape that was removed`,
  );
}
