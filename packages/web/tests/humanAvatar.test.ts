import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import GravatarAvatar from "../src/components/member/GravatarAvatar.js";
import { isRaftUploadedHumanAvatarUrl } from "../src/utils/humanAvatar.js";

const providerDefaultAvatarUrl = "https://lh3.googleusercontent.com/a/default-user-initial";
const gravatarHash = "d1fa5de787a6e71313104ac9d57577cd2c0dc91e23c896051833cfd7b75ec513";

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

test("human avatar renderer ignores provider default avatar URLs and renders Gravatar", () => {
  const html = renderToStaticMarkup(
    createElement(GravatarAvatar, {
      avatarUrl: providerDefaultAvatarUrl,
      gravatarHash,
      size: 52,
      iconSize: 24,
    }),
  );

  assert.match(html, new RegExp(`https://www\\.gravatar\\.com/avatar/${gravatarHash}\\?s=52&amp;d=404`));
  assert.doesNotMatch(html, /lh3\.googleusercontent\.com/);
});
