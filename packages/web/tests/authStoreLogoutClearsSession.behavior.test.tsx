import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/domSetup";
import { useAuthStore } from "../src/store/authStore";
import { useAnnouncementStore } from "../src/store/announcementStore";
import { useServerStore } from "../src/store/serverStore";
import { hasSlockdevManualLogout } from "../src/utils/devMode";

function tokenFor(subject: string): string {
  return `e30.${Buffer.from(JSON.stringify({ sub: subject, type: "access" })).toString("base64url")}.signature`;
}

/**
 * Logging out has to leave nothing of the previous person behind.
 *
 * It used to leave their server list in the store, so the next account inherited it: the
 * app tried to restore a server they could not see ("server not found"), and someone with
 * no servers at all got an empty "Choose server" screen instead of the create-your-first-
 * server step they had stopped on. And in dev, the auto-login promptly signed them back
 * in as the seeded user — which is the one thing logging out must prevent.
 */
test("logout clears the previous account's servers, announcement frontier, and dev auto-login", () => {
  useServerStore.setState({
    servers: [{ id: "s1", slug: "old", name: "Old" }] as never,
    current: { id: "s1", slug: "old", name: "Old" } as never,
    loading: false,
  } as never);
  useAuthStore.setState({
    user: { id: "u1", email: "a@b.com" } as never,
    accessToken: "at",
    refreshToken: null,
  } as never);
  useAnnouncementStore.setState({
    pending: [{ id: "announcement-a" }] as never,
    loaded: true,
    markedReadIds: ["announcement-read-a"],
    writeFailedIds: ["announcement-failed-a"],
  });

  useAuthStore.getState().logout();

  const servers = useServerStore.getState();
  assert.deepEqual(servers.servers, [], "the next person must not inherit these servers");
  assert.equal(servers.current, null);
  assert.equal(servers.loading, true, "loading, not 'known to be empty': the list is unknown again");
  assert.equal(useAuthStore.getState().user, null);
  assert.equal(useAuthStore.getState().accessToken, null);
  assert.deepEqual(
    {
      pending: useAnnouncementStore.getState().pending,
      loaded: useAnnouncementStore.getState().loaded,
      markedReadIds: useAnnouncementStore.getState().markedReadIds,
      writeFailedIds: useAnnouncementStore.getState().writeFailedIds,
    },
    { pending: [], loaded: false, markedReadIds: [], writeFailedIds: [] },
    "user B must never inherit user A's request-only failed-write frontier",
  );
  assert.equal(hasSlockdevManualLogout(), true, "an explicit logout outranks the dev auto-login");
});

test("an external token principal switch clears the prior account's announcement frontier", () => {
  useAuthStore.setState({
    user: { id: "user-a", email: "a@example.com" } as never,
    accessToken: tokenFor("user-a"),
    refreshToken: "refresh-a",
  } as never);
  useAnnouncementStore.setState({
    pending: [],
    loaded: true,
    markedReadIds: [],
    writeFailedIds: ["announcement-failed-a"],
  });

  useAuthStore.getState().setTokens(tokenFor("user-b"), "refresh-b");

  assert.deepEqual(useAnnouncementStore.getState().writeFailedIds, []);
  assert.equal(useAnnouncementStore.getState().loaded, false);
});
