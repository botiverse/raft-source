import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";

import AccountIdentitySetupPage from "../src/components/auth/AccountIdentitySetupPage";
import ServerCreatePreview from "../src/components/auth/ServerCreatePreview";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import { AVATAR_TOO_LARGE_CODE } from "../src/utils/avatarUpload";
import { renderWithIntl } from "./helpers/intl";

// RENDER-LEVEL backstop for the last two auth-block files.
//
// Source greps and the hardcoded-English scanner both answer "is there English
// in this file?". Neither answers "what does a Chinese user actually see?", and
// the two come apart in both directions:
//
//   - a MessageId held in state and rendered bare prints "pages.foo.bar" on
//     screen while typecheck stays green and every scanner reports clean;
//   - English reached through a shared helper (validateName, the avatar size
//     util) renders with no English literal at the call site to find.
//
// So this mounts both components under zh-cn and reads the DOM.

afterEach(cleanup);

const user = (overrides: Partial<User> = {}): User => ({
  id: "u1",
  email: "alex@example.com",
  name: "",
  displayName: "",
  avatarUrl: null,
  gravatarHash: null,
  emailVerified: true,
  profileSetupProvider: null,
  profileSetupSuggestedHandle: null,
  ...overrides,
} as User);

/** Every catalog id looks like `a.b.c`; none should ever reach the screen. */
function assertNoRawIds(text: string) {
  const leaked = text.match(/\b(?:pages|onboarding|layout|avatar|validation|auth)\.[a-z][A-Za-z]*(?:\.[A-Za-z]+)+/g);
  assert.equal(leaked, null, `raw message id(s) rendered on screen: ${leaked?.join(", ")}`);
}

test("identity setup renders Chinese, not English and not raw ids", () => {
  useAuthStore.setState({ user: user(), loading: false });
  const { container } = renderWithIntl(<AccountIdentitySetupPage />, { locale: "zh-cn" });
  const text = container.textContent ?? "";

  assertNoRawIds(text);
  assert.match(text, /设置你的账号/);
  assert.match(text, /用于 @提及 和链接的唯一名称/);
  assert.match(text, /你在消息中显示的名字/);
  assert.match(text, /头像/);
  assert.match(text, /继续/);
  // The seeded preview sentence renders as ONE Chinese sentence with the mention
  // inline — not an English frame with a translated fragment dropped into it.
  assert.match(screen.getByTestId("identity-seeded-message-copy").textContent ?? "",
    /^早上好 —— @\S+ 能看一下 Q3 的草稿吗？$/);
  // Copy that must NOT survive.
  for (const english of ["Set up your account", "Display name", "Profile picture", "Continue", "take a look"]) {
    assert.ok(!text.includes(english), `English still on screen: ${english}`);
  }
});

test("identity setup shows Chinese validation, including text built by shared helpers", () => {
  // The failure this guards: `validateName` builds "Username is required" inside
  // @botiverse/raft-shared, so the English never appears in this component at all.
  useAuthStore.setState({ user: user(), loading: false });
  renderWithIntl(<AccountIdentitySetupPage />, { locale: "zh-cn" });

  const form = screen.getByRole("button", { name: "继续" }).closest("form");
  assert.ok(form);
  // fireEvent.submit, not form.requestSubmit(): jsdom's requestSubmit does not
  // drive React's onSubmit here, so the assertions below would read a form that
  // was never validated — passing or failing for reasons unrelated to language.
  act(() => {
    fireEvent.submit(form);
  });

  const text = form.textContent ?? "";
  assertNoRawIds(text);
  assert.match(text, /请填写用户名/);
  assert.match(text, /请填写显示名称/);
  assert.ok(!text.includes("is required"), "the shared English validation frame is on screen");
});

test("an oversized avatar from the STORE never renders the raw code", async () => {
  // @Wug's blocker on #5842. The store throws AVATAR_TOO_LARGE_CODE, and this
  // page's avatar-step catch runs avatarUploadApiErrorMessage, which returns
  // error.message — so without an explicit map the user sees the identifier
  // "AVATAR_TOO_LARGE" embedded in a Chinese sentence. Swapping English for an
  // identifier is a worse outcome than the bug the change set is fixing.
  //
  // Driven through completeOnboardingProfile rather than the file input,
  // because the input pre-validates and can never reach this branch — the
  // fixture has to enter where the guard alone decides.
  useAuthStore.setState({
    user: user(),
    loading: false,
    completeOnboardingProfile: async () => {
      throw Object.assign(new Error(AVATAR_TOO_LARGE_CODE), { onboardingStep: "avatar" });
    },
  } as never);
  renderWithIntl(<AccountIdentitySetupPage />, { locale: "zh-cn" });

  fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "alexchen" } });
  fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "Alex Chen" } });
  const form = screen.getByRole("button", { name: "继续" }).closest("form");
  assert.ok(form);
  await act(async () => {
    fireEvent.submit(form);
  });

  const alert = screen.getByRole("alert");
  const text = alert.textContent ?? "";
  assert.ok(!text.includes(AVATAR_TOO_LARGE_CODE), `raw code rendered: ${text}`);
  assert.equal(text, "头像图片不能超过 5 MB");
});

test("server create preview renders Chinese section labels and agent copy", () => {
  const { container } = renderWithIntl(
    <ServerCreatePreview serverName="测试工作区" serverSlug="test-workspace" />,
    { locale: "zh-cn" },
  );
  const text = container.textContent ?? "";

  assertNoRawIds(text);
  assert.match(text, /频道/);
  assert.match(text, /私信/);
  assert.match(text, /正在为你准备 测试工作区。/);
  assert.match(text, /发消息到 #onboarding-owner/);
  // Real channel names stay in ASCII — the preview must not promise a channel
  // name the user will never find.
  assert.match(text, /onboarding-owner/);
  assert.match(text, /test-workspace/);
  // The section toggle's accessible name is a whole translated string, not
  // "频道 section" left over from a template literal.
  const channelsToggle = screen.getByTestId("server-preview-section-channels");
  assert.equal(channelsToggle.getAttribute("aria-label"), "频道分区");
});

test("english still renders english", () => {
  // The zh assertions above would all pass if the zh catalog silently fell back
  // to en, so pin the other direction too.
  const { container } = renderWithIntl(
    <ServerCreatePreview serverName="" serverSlug="" />,
    { locale: "en" },
  );
  const text = container.textContent ?? "";
  assertNoRawIds(text);
  assert.match(text, /Channels/);
  assert.match(text, /Direct Messages/);
  assert.match(text, /Once the server is created/);
});
