import assert from "node:assert/strict";
import { createChannelRefRegex, createChannelThreadRefRegex } from "../src/utils/messageReferencePatterns";

test("channel refs support CJK channel names", () => {
  const matches = Array.from("go to #对话流专修 and #android-artifacts".matchAll(createChannelRefRegex()));

  assert.deepEqual(matches.map((match) => match[1]), ["对话流专修", "android-artifacts"]);
});

test("channel thread refs support CJK channel names", () => {
  const matches = Array.from("see #对话流专修:abc123 and #product:deadbee".matchAll(createChannelThreadRefRegex()));

  assert.deepEqual(matches.map((match) => [match[1], match[2]]), [
    ["对话流专修", "abc123"],
    ["product", "deadbee"],
  ]);
});
