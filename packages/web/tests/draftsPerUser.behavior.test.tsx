import assert from "node:assert/strict";
import "./helpers/domSetup";
import { useAuthStore } from "../src/store/authStore";
import { useMessageStore } from "../src/store/messageStore";
import { followSignedInUser } from "../src/store/signedInUser";

/**
 * Composer drafts are one person's. Someone who signs in after another
 * on the same browser must not find the previous person's unsent text in a
 * shared channel or their DM pre-filled in the composer.
 *
 * Keys are spelled out (not imported) so this test runs against the code from
 * before the fix too, and fails there.
 */

const CHANNEL = "channel-shared";
const SECRET = "unsent text from A";

function tokenFor(subject: string): string {
  return `e30.${Buffer.from(JSON.stringify({ sub: subject, type: "access" })).toString("base64url")}.signature`;
}

/** Signs a person in the way the app sees it: tokens in storage, then the auth store's user. */
function signIn(userId: string) {
  localStorage.setItem("slock_access_token", tokenFor(userId));
  localStorage.setItem("slock_refresh_token", `refresh-${userId}`);
  useAuthStore.setState({
    user: { id: userId, email: `${userId}@example.com` } as never,
    accessToken: tokenFor(userId),
    refreshToken: `refresh-${userId}`,
  } as never);
}

/** Stand-in for the page going away: the persistence layer's lifecycle flush. */
function flushDraftsToStorage() {
  window.dispatchEvent(new window.Event("pagehide"));
}

function storedDraftTexts(): string[] {
  const texts: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith("slock_drafts")) texts.push(localStorage.getItem(key) ?? "");
  }
  return texts;
}

let stopFollowing: () => void = () => {};

beforeEach(() => {
  flushDraftsToStorage();
  localStorage.clear();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null } as never);
  useMessageStore.setState({ currentUserId: null, drafts: {} });
  stopFollowing = followSignedInUser();
});

afterEach(() => {
  stopFollowing();
  flushDraftsToStorage();
  localStorage.clear();
});

test("after A logs out and B logs in, B's composer has nothing of A's draft; A's draft is gone for good", () => {
  signIn("user-a");
  useMessageStore.getState().setDraft(CHANNEL, SECRET);
  flushDraftsToStorage();
  assert.equal(localStorage.getItem("slock_drafts:user-a"), JSON.stringify({ [CHANNEL]: SECRET }));

  useAuthStore.getState().logout();

  assert.deepEqual(useMessageStore.getState().drafts, {}, "logout drops the drafts from memory");
  assert.equal(localStorage.getItem("slock_drafts:user-a"), null, "logout removes A's stored drafts");
  flushDraftsToStorage();
  assert.deepEqual(storedDraftTexts(), [], "nothing written back after logout");

  signIn("user-b");
  assert.equal(useMessageStore.getState().drafts[CHANNEL], undefined, "B's composer for the channel is empty");
  assert.deepEqual(useMessageStore.getState().drafts, {});

  useAuthStore.getState().logout();
  signIn("user-a");
  assert.equal(useMessageStore.getState().drafts[CHANNEL], undefined, "logging out discarded A's draft, as designed");
});

test("switching from A to B without a logout keeps A's draft out of B's view and in A's own entry", () => {
  signIn("user-a");
  useMessageStore.getState().setDraft(CHANNEL, SECRET);
  flushDraftsToStorage();
  // An edit still pending when B's tokens land is not written: storage now
  // holds B's session, and A's entry is only written under A's.
  useMessageStore.getState().setDraft(CHANNEL, `${SECRET}, unsaved`);

  signIn("user-b");
  assert.equal(useMessageStore.getState().drafts[CHANNEL], undefined, "B does not see A's draft");
  useMessageStore.getState().setDraft("channel-b", "B's own");
  flushDraftsToStorage();
  assert.equal(localStorage.getItem("slock_drafts:user-b"), JSON.stringify({ "channel-b": "B's own" }));
  assert.equal(localStorage.getItem("slock_drafts:user-a"), JSON.stringify({ [CHANNEL]: SECRET }));

  signIn("user-a");
  assert.deepEqual(useMessageStore.getState().drafts, { [CHANNEL]: SECRET }, "A gets their own draft back");
});

test("the old shared entry is deleted unread, not handed to whoever signs in", () => {
  localStorage.setItem("slock_drafts", JSON.stringify({ [CHANNEL]: SECRET }));
  signIn("user-b");
  assert.equal(useMessageStore.getState().drafts[CHANNEL], undefined);
  assert.equal(localStorage.getItem("slock_drafts"), null);
});

test("with no one signed in, drafts are not written", () => {
  useMessageStore.getState().setDraft(CHANNEL, "typed while signed out");
  flushDraftsToStorage();
  assert.deepEqual(storedDraftTexts(), []);
});

test("a tab whose session another tab ended does not write the drafts back", () => {
  signIn("user-a");
  useMessageStore.getState().setDraft(CHANNEL, SECRET);
  // Another tab logs out: the tokens and A's entry leave shared storage; this
  // tab's memory still holds the session until it notices.
  localStorage.removeItem("slock_access_token");
  localStorage.removeItem("slock_refresh_token");
  localStorage.removeItem("slock_drafts:user-a");
  flushDraftsToStorage();
  assert.equal(localStorage.getItem("slock_drafts:user-a"), null);

  // Or another tab signed in as B over it.
  localStorage.setItem("slock_access_token", tokenFor("user-b"));
  useMessageStore.getState().setDraft(CHANNEL, `${SECRET} more`);
  flushDraftsToStorage();
  assert.deepEqual(storedDraftTexts(), []);
});
