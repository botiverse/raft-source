import assert from "node:assert/strict";
import test from "node:test";

localStorage.clear();
localStorage.setItem("slock_message_body_font_size", "lg");

const {
  MESSAGE_BODY_FONT_SIZE_STORAGE_KEY,
  seedMessageBodyFontSizeFromProfile,
  useAppearanceStore,
} = await import("../src/store/appearanceStore");

test("message font size preference reads from and persists to the local device", () => {
  assert.equal(useAppearanceStore.getState().messageBodyFontSize, "lg");

  useAppearanceStore.getState().setMessageBodyFontSize("sm");

  assert.equal(localStorage.getItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY), "sm");
  assert.equal(useAppearanceStore.getState().messageBodyFontSize, "sm");
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
