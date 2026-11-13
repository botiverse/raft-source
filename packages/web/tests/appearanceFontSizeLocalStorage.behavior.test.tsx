import assert from "node:assert/strict";

localStorage.clear();
localStorage.setItem("slock_message_body_font_size", "lg");

const {
  MESSAGE_BODY_FONT_SIZE_STORAGE_KEY,
  getMessageBodyFontSizeStyle,
  getMessageMetaSizeClass,
  getMessageNameSizeClass,
  getMessageTimeSizeClass,
  seedMessageBodyFontSizeFromProfile,
  useAppearanceStore,
} = await import("../src/store/appearanceStore");

test("message font size preference reads from and persists to the local device", () => {
  assert.equal(useAppearanceStore.getState().messageBodyFontSize, "lg");

  useAppearanceStore.getState().setMessageBodyFontSize("sm");

  assert.equal(localStorage.getItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY), "sm");
  assert.equal(useAppearanceStore.getState().messageBodyFontSize, "sm");
});

test("message font size style is terminal against the RUI theme body recipe; medium is the DS body size on either scale (task #114)", () => {
  // Relative to `--text-body`: 12/14/16 on a desktop, 14/16/18 on a phone, so
  // one stored tier reads right on both and needs no migration.
  // The line moves with the size (4px a tier): 14/20, 16/24, 18/28 on a
  // phone, 12/18, 14/22, 16/26 on a desktop.
  assert.deepEqual(getMessageBodyFontSizeStyle("sm"), { fontSize: "calc(var(--text-body) - 2px)", lineHeight: "calc(var(--text-body--line-height) - 4px)" });
  assert.deepEqual(getMessageBodyFontSizeStyle("md"), { fontSize: "var(--text-body)", lineHeight: "var(--text-body--line-height)" });
  assert.deepEqual(getMessageBodyFontSizeStyle("lg"), { fontSize: "calc(var(--text-body) + 2px)", lineHeight: "calc(var(--text-body--line-height) + 4px)" });
});

test("invalid local message font size writes normalize back to medium", () => {
  localStorage.clear();

  useAppearanceStore.getState().setMessageBodyFontSize("invalid" as never);

  assert.equal(localStorage.getItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY), "md");
  assert.equal(useAppearanceStore.getState().messageBodyFontSize, "md");
});

test("legacy profile font size seeds an empty local device preference once", () => {
  localStorage.clear();
  useAppearanceStore.setState({ messageBodyFontSize: "md" });

  seedMessageBodyFontSizeFromProfile("lg");

  assert.equal(localStorage.getItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY), "lg");
  assert.equal(useAppearanceStore.getState().messageBodyFontSize, "lg");
});

test("legacy profile font size does not overwrite an existing local device preference", () => {
  localStorage.clear();
  useAppearanceStore.getState().setMessageBodyFontSize("sm");

  seedMessageBodyFontSizeFromProfile("lg");

  assert.equal(localStorage.getItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY), "sm");
  assert.equal(useAppearanceStore.getState().messageBodyFontSize, "sm");
});

test("the name line's tiers move size and line height together, from the tokens", () => {
  // Each tier keeps the style's own leading (line − size), so the header,
  // aligned on its baseline, is the name's line at every message size.
  assert.equal(getMessageNameSizeClass("sm"), "text-[length:calc(var(--text-subhead)_-_2px)] leading-[calc(var(--text-subhead--line-height)_-_2px)]");
  assert.equal(getMessageNameSizeClass("md"), "text-[length:var(--text-subhead)] leading-[var(--text-subhead--line-height)]");
  assert.equal(getMessageNameSizeClass("lg"), "text-[length:calc(var(--text-subhead)_+_2px)] leading-[calc(var(--text-subhead--line-height)_+_2px)]");
  for (const size of ["sm", "md", "lg"] as const) {
    assert.match(getMessageMetaSizeClass(size), /leading-\[(?:calc\()?var\(--text-caption--line-height\)/);
    assert.match(getMessageMetaSizeClass(size), /font-\[number:var\(--text-caption--font-weight\)\]/);
    assert.match(getMessageTimeSizeClass(size), /^text-\[length:(?:calc\()?var\(--text-mono-meta\).* leading-\[(?:calc\()?var\(--text-mono-meta--line-height\)/);
  }
  assert.equal(getMessageTimeSizeClass("lg"), "text-[length:calc(var(--text-mono-meta)_+_1px)] leading-[calc(var(--text-mono-meta--line-height)_+_1px)]");
});
