import "../../../../tests/helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

import api from "../../../api/client";
import { PublicVisibilitySection } from "../server/PublicVisibilitySection";
import { useServerStore } from "../../../store/serverStore";
import { renderWithIntl } from "../../../../tests/helpers/intl";
import { assertScrollAreaRailsOn } from "../../../../tests/helpers/scrollAreaRails";
import { PUBLIC_SERVER_FEATURE_FLAG_KEY, SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import {
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../../../store/serverFeatureFlags";

const originalGet = api.get;
const originalPatch = api.patch;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.patch = originalPatch;
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  useServerStore.setState(useServerStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
});

function seed(role: "owner" | "admin", publicServerEnabled = true) {
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Public Test",
      slug: "public-test",
      ownerId: "owner-1",
      role,
    },
    serverEpoch: 1,
  } as never);
  setServerFeatureFlagForTests("server-1", PUBLIC_SERVER_FEATURE_FLAG_KEY, publicServerEnabled);
  setServerFeatureFlagForTests("server-1", SERVER_GUEST_FEATURE_FLAG_KEY, true);
}

test("owner sees a structured exposed-channel list and must confirm the audience expansion", async () => {
  seed("owner");
  const clipboardWrites: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { clipboardWrites.push(value); } },
  });
  api.get = (async (url: string) => {
    assert.equal(url, "/servers/server-1/public-visibility");
    return {
      data: {
        publiclyVisible: false,
        publicGuestJoinEnabled: false,
        slug: "public-test",
        exposedChannels: [
          { id: "channel-1", name: "announcements", description: "Company news" },
          { id: "channel-2", name: "help", description: null },
          { id: "channel-3", name: "community", description: "A third row must scroll inside the list" },
        ],
      },
    };
  }) as typeof api.get;
  const writes: Array<{ url: string; publiclyVisible: boolean }> = [];
  api.patch = (async (url: string, body: { publiclyVisible: boolean }) => {
    writes.push({ url, publiclyVisible: body.publiclyVisible });
    return { data: { publiclyVisible: body.publiclyVisible, publicGuestJoinEnabled: false } };
  }) as typeof api.patch;

  renderWithIntl(<PublicVisibilitySection />);
  const list = await screen.findByTestId("public-visibility-channel-list");
  const frame = list.closest("[data-slot=scroll-area]");
  // Was `overflow-y-scroll`: the scrollbar always shows while there is more.
  assertScrollAreaRailsOn(frame, { ownContainer: false, trigger: "none" });
  assert.ok(frame.classList.contains("max-h-[7.5rem]"));
  assert.equal(within(list).getAllByRole("listitem").length, 3);
  assert.ok(within(list).getAllByRole("listitem").every((row) => row.classList.contains("h-[3.625rem]")));
  assert.match(list.textContent ?? "", /announcementsCompany news/);
  assert.match(list.textContent ?? "", /help/);

  fireEvent.click(screen.getByTestId("public-visibility-switch"));
  assert.deepEqual(writes, [], "opening the confirmation must not publish the server");

  const dialog = screen.getByRole("dialog");
  assert.match(dialog.textContent ?? "", /readable by anyone/);
  assert.match(dialog.textContent ?? "", /not only the Guests you invited/);
  const dialogList = within(dialog).getByTestId("public-visibility-channel-list");
  const dialogFrame = dialogList.closest("[data-slot=scroll-area]");
  assertScrollAreaRailsOn(dialogFrame, { ownContainer: false, trigger: "none" });
  assert.ok(dialogFrame.classList.contains("max-h-[7.5rem]"));
  assert.equal(within(dialogList).getAllByRole("listitem").length, 3);

  fireEvent.click(within(dialog).getByTestId("public-visibility-confirm-button"));
  await waitFor(() => assert.deepEqual(writes, [{
    url: "/servers/server-1/public-visibility",
    publiclyVisible: true,
  }]));
  await waitFor(() => assert.ok(screen.queryByRole("dialog") === null));
  const urlSection = screen.getByTestId("public-visibility-url");
  const urlInput = screen.getByLabelText("Public page") as HTMLInputElement;
  assert.equal(urlInput.readOnly, true);
  assert.match(urlInput.value, /\/s\/public-test$/);
  assert.ok(
    urlSection.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    "the public URL belongs above the exposed-channel list",
  );
  assert.ok(within(urlSection).queryByRole("link") === null, "the URL control must not add an Open action");
  const urlRow = urlInput.parentElement;
  assert.ok(urlRow?.classList.contains("flex"));
  assert.equal(urlRow?.classList.contains("flex-col"), false, "mobile keeps URL and Copy on one row");
  const copy = within(urlSection).getByTestId("public-visibility-copy-url");
  assert.ok(copy.classList.contains("shrink-0"));
  assert.equal(copy.classList.contains("w-full"), false, "mobile Copy must not occupy its own row");

  fireEvent.click(copy);
  await waitFor(() => assert.deepEqual(clipboardWrites, [urlInput.value]));
  await screen.findByText("Copied");
});

test("turning public access off is immediate and does not require confirmation", async () => {
  seed("owner");
  api.get = (async () => ({
    data: { publiclyVisible: true, publicGuestJoinEnabled: true, slug: "public-test", exposedChannels: [] },
  })) as typeof api.get;
  const writes: boolean[] = [];
  api.patch = (async (_url: string, body: { publiclyVisible: boolean }) => {
    writes.push(body.publiclyVisible);
    return { data: { publiclyVisible: body.publiclyVisible, publicGuestJoinEnabled: false } };
  }) as typeof api.patch;

  renderWithIntl(<PublicVisibilitySection />, { locale: "zh-cn" });
  const toggle = await screen.findByTestId("public-visibility-switch");
  assert.match(screen.getByTestId("public-visibility-section").textContent ?? "", /还没有对游客可见的频道/);
  fireEvent.click(toggle);

  await waitFor(() => assert.deepEqual(writes, [false]));
  assert.ok(screen.queryByRole("dialog") === null);
});

// #wg-rbac:#15 P1 c: a Guest is never made from the public page (the server's
// join-as-guest route is gone), so the Guest-join switch is not offered,
// whatever server_guest_v0 says. The public visibility setting itself stays.
for (const publiclyVisible of [true, false]) {
  test(`no Guest-join setting while public access is ${publiclyVisible ? "on" : "off"}`, async () => {
    seed("owner");
    api.get = (async () => ({
      data: { publiclyVisible, publicGuestJoinEnabled: true, slug: "public-test", exposedChannels: [] },
    })) as typeof api.get;
    const writes: string[] = [];
    api.patch = (async (url: string) => {
      writes.push(url);
      return { data: {} };
    }) as typeof api.patch;

    renderWithIntl(<PublicVisibilitySection />);
    // Control: the section loaded, so the absences below are not vacuous.
    await waitFor(() => assert.equal(screen.getByTestId("public-visibility-switch").hasAttribute("data-disabled"), false));
    assert.ok(screen.queryByTestId("public-guest-join-setting") === null, "the Guest-join row must be absent");
    assert.ok(screen.queryByTestId("public-guest-join-switch") === null, "the Guest-join switch must be absent");
    assert.doesNotMatch(screen.getByTestId("public-visibility-section").textContent ?? "", /join as Guest/);
    assert.deepEqual(writes, [], "nothing writes public-guest-join");
  });
}

test("admins never receive the owner-only public visibility surface or API read", () => {
  seed("admin");
  let reads = 0;
  api.get = (async () => {
    reads += 1;
    throw new Error("must not be called");
  }) as typeof api.get;

  renderWithIntl(<PublicVisibilitySection />);
  assert.ok(screen.queryByTestId("public-visibility-section") === null);
  assert.equal(reads, 0);
});

test("rollout flag off hides the owner surface and performs no API read", () => {
  seed("owner", false);
  let reads = 0;
  api.get = (async () => {
    reads += 1;
    throw new Error("must not be called");
  }) as typeof api.get;

  renderWithIntl(<PublicVisibilitySection />);
  assert.ok(screen.queryByTestId("public-visibility-section") === null);
  assert.equal(reads, 0);
});

test("search access sits under 'Make this server public'; the channel list is a first-level heading after a divider", async () => {
  // cindyz, #wg-rbac task #127: settings that only apply to a public server
  // are the public switch's second level; the channel list is about the whole
  // public server and sits beside the switch, after a divider.
  seed("owner");
  api.get = (async () => ({
    data: { publiclyVisible: true, publicGuestJoinEnabled: false, slug: "public-test", exposedChannels: [] },
  })) as typeof api.get;

  renderWithIntl(<PublicVisibilitySection />);
  const searchSetting = await screen.findByTestId("public-search-setting");
  const primary = screen.getByTestId("public-visibility-primary");
  const channels = screen.getByTestId("public-visibility-channels");
  assert.ok(primary.contains(screen.getByTestId("public-visibility-switch")), "the public switch heads the first group");
  assert.ok(primary.contains(searchSetting), "search access belongs to the public switch's group");
  assert.ok(!primary.contains(channels), "the channel list is not inside that group");
  assert.ok(primary.parentElement === channels.parentElement, "the channel list is a sibling of the group: same level");
  assert.ok(primary.compareDocumentPosition(channels) & Node.DOCUMENT_POSITION_FOLLOWING, "after it");
  const heading = channels.querySelector("h3");
  assert.ok(heading !== null && /Channels visible to anyone/i.test(heading.textContent ?? ""), "the channel list has a heading of the same rank as the public switch's");
  // stdrc / raft-design #703: each setting's switch centres on its whole row.
  const publicRow = screen.getByTestId("public-visibility-switch").parentElement;
  for (const row of [publicRow, searchSetting]) {
    assert.ok(row instanceof HTMLElement, "setting row exists");
    assert.match(row.className, /\bitems-center\b/);
    assert.doesNotMatch(row.className, /\bitems-start\b/);
  }
});

test("after the owner switches public access, the server list reloads so the public marks update at once", async () => {
  seed("owner");
  const gets: string[] = [];
  api.get = (async (url: string) => {
    gets.push(url);
    if (url === "/servers") return { data: [] };
    return { data: { publiclyVisible: true, publicGuestJoinEnabled: false, slug: "public-test", exposedChannels: [] } };
  }) as typeof api.get;
  api.patch = (async (_url: string, body: { publiclyVisible: boolean }) => ({
    data: { publiclyVisible: body.publiclyVisible, publicGuestJoinEnabled: false },
  })) as typeof api.patch;

  renderWithIntl(<PublicVisibilitySection />);
  const toggle = await screen.findByTestId("public-visibility-switch");
  assert.equal(gets.filter((url) => url === "/servers").length, 0);
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(gets.filter((url) => url === "/servers").length, 1, "one fresh server-list load"));
});

test("owner turns search engine access off under a public server; the switch is inert while private", async () => {
  seed("owner");
  let publiclyVisible = true;
  api.get = (async () => ({
    data: {
      publiclyVisible,
      publicGuestJoinEnabled: false,
      publicSearchEnabled: true,
      slug: "public-test",
      exposedChannels: [],
    },
  })) as typeof api.get;
  const writes: Array<{ url: string; body: unknown }> = [];
  api.patch = (async (url: string, body: { publicSearchEnabled: boolean }) => {
    writes.push({ url, body });
    return { data: { publicSearchEnabled: body.publicSearchEnabled } };
  }) as typeof api.patch;

  renderWithIntl(<PublicVisibilitySection />);
  const searchSwitch = await screen.findByTestId("public-search-switch");
  await waitFor(() => assert.equal(searchSwitch.getAttribute("aria-checked"), "true"));
  fireEvent.click(searchSwitch);
  await waitFor(() => assert.equal(searchSwitch.getAttribute("aria-checked"), "false"));
  assert.deepEqual(writes, [{ url: "/servers/server-1/public-search", body: { publicSearchEnabled: false } }]);

  cleanup();
  publiclyVisible = false;
  renderWithIntl(<PublicVisibilitySection />);
  const privateSwitch = await screen.findByTestId("public-search-switch");
  await waitFor(() => assert.ok(privateSwitch.hasAttribute("disabled") || privateSwitch.getAttribute("aria-disabled") === "true"));
  assert.equal(privateSwitch.getAttribute("aria-checked"), "false", "a private server is not shown as searchable");
});
