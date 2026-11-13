import assert from "node:assert/strict";
import { computerPlatformName } from "../src/utils/computerDevice";

test("the platform as people name it, with its architecture; anything else as reported", () => {
  assert.equal(computerPlatformName("darwin"), "macOS");
  assert.equal(computerPlatformName("darwin arm64"), "macOS arm64");
  assert.equal(computerPlatformName("win32 x64"), "Windows x64");
  assert.equal(computerPlatformName("linux x64"), "Linux x64");
  assert.equal(computerPlatformName("freebsd"), "freebsd");
  assert.equal(computerPlatformName(""), null);
  assert.equal(computerPlatformName(null), null);
});
