import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import GravatarAvatar from "../src/components/member/GravatarAvatar";

// #proj-chat task #33: Gravatar is requested with `d=404`, so humans without
// a registered Gravatar used to render a broken-image box until onError fired.
// The fix gates the Gravatar <img> behind a successful onLoad.

afterEach(() => {
  cleanup();
});

test("GravatarAvatar shows the User placeholder until the Gravatar loads", () => {
  const { container } = render(
    <GravatarAvatar gravatarHash="hash-load-probe" iconSize={16} />,
  );

  assert.ok(container.querySelector("svg"), "User placeholder must render first");
  const img = container.querySelector("img");
  assert.ok(img, "Gravatar probe image must stay mounted");
  assert.match(img.className, /opacity-0/);
  assert.doesNotMatch(img.className, /(^|\s)hidden(\s|$)/);

  fireEvent.load(img);
  assert.doesNotMatch(img.className, /opacity-0/);
  assert.equal(container.querySelector("svg"), null, "placeholder must leave after load");
});

test("GravatarAvatar falls back to the User placeholder when Gravatar errors", () => {
  const { container } = render(
    <GravatarAvatar gravatarHash="hash-error-probe" iconSize={16} />,
  );

  const img = container.querySelector("img");
  assert.ok(img);
  fireEvent.error(img);
  assert.equal(container.querySelector("img"), null, "failed Gravatar must unmount");
  assert.ok(container.querySelector("svg"), "User placeholder must remain after error");
});

test("GravatarAvatar caches a successful load across remounts of the same hash", () => {
  const hash = "hash-cache-probe";
  const first = render(<GravatarAvatar gravatarHash={hash} iconSize={16} />);
  const firstImg = first.container.querySelector("img");
  assert.ok(firstImg);
  fireEvent.load(firstImg);
  first.unmount();

  const second = render(<GravatarAvatar gravatarHash={hash} iconSize={16} />);
  const secondImg = second.container.querySelector("img");
  assert.ok(secondImg);
  assert.doesNotMatch(secondImg.className, /opacity-0/);
  assert.equal(second.container.querySelector("svg"), null);
});
