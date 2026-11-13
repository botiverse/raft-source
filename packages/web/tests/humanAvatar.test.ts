import assert from "node:assert/strict";
import { humanAvatarSource, isHumanPixelAvatarUrl, isRaftUploadedHumanAvatarUrl } from "../src/utils/humanAvatar";

const providerDefaultAvatarUrl = "https://lh3.googleusercontent.com/a/default-user-initial";

test("human avatar fallback only treats Slock user uploads as custom avatars", () => {
  assert.equal(
    isRaftUploadedHumanAvatarUrl("/api/avatars/users/0123456789abcdef.webp"),
    true,
  );
  assert.equal(
    isRaftUploadedHumanAvatarUrl("https://cdn.slock.ai/avatars/users/0123456789abcdef.webp"),
    true,
  );
  assert.equal(
    isRaftUploadedHumanAvatarUrl(providerDefaultAvatarUrl),
    false,
  );
  assert.equal(
    isRaftUploadedHumanAvatarUrl("https://avatars.githubusercontent.com/u/123456"),
    false,
  );
  assert.equal(isRaftUploadedHumanAvatarUrl(null), false);
});

test("a built pixel avatar is its own source, never an uploaded image", () => {
  const built = "pixel-human:v1:yellow.2.short.ink.wink.cap.none";
  assert.equal(isHumanPixelAvatarUrl(built), true);
  assert.equal(isRaftUploadedHumanAvatarUrl(built), false);
  assert.equal(humanAvatarSource(built), "pixel");
  assert.equal(humanAvatarSource("/api/avatars/users/0123456789abcdef.webp"), "uploaded");
  for (const value of [null, "", providerDefaultAvatarUrl, "pixel:robot"]) {
    assert.equal(humanAvatarSource(value), "placeholder", String(value));
  }
});
