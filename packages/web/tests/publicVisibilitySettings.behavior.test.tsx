import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

import api from "../src/api/client";
import { PublicVisibilitySection } from "../src/components/settings/SettingsPanel";
import { useServerStore } from "../src/store/serverStore";
import { renderWithIntl } from "./helpers/intl";
import { PUBLIC_SERVER_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import {
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";

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
    return { data: { publiclyVisible: body.publiclyVisible } };
  }) as typeof api.patch;

  renderWithIntl(<PublicVisibilitySection />);
  const list = await screen.findByTestId("public-visibility-channel-list");
  assert.ok(list.classList.contains("max-h-[7.5rem]"));
  assert.ok(list.classList.contains("overflow-y-scroll"));
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
  assert.ok(dialogList.classList.contains("max-h-[7.5rem]"));
  assert.ok(dialogList.classList.contains("overflow-y-scroll"));
  assert.equal(within(dialogList).getAllByRole("listitem").length, 3);

  fireEvent.click(within(dialog).getByTestId("public-visibility-confirm-button"));
  await waitFor(() => assert.deepEqual(writes, [{
    url: "/servers/server-1/public-visibility",
    publiclyVisible: true,
  }]));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  const urlSection = screen.getByTestId("public-visibility-url");
  const urlInput = screen.getByLabelText("Public page") as HTMLInputElement;
  assert.equal(urlInput.readOnly, true);
  assert.match(urlInput.value, /\/s\/public-test$/);
  assert.ok(
    urlSection.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    "the public URL belongs above the exposed-channel list",
  );
  assert.equal(within(urlSection).queryByRole("link"), null, "the URL control must not add an Open action");
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
    data: { publiclyVisible: true, slug: "public-test", exposedChannels: [] },
  })) as typeof api.get;
  const writes: boolean[] = [];
  api.patch = (async (_url: string, body: { publiclyVisible: boolean }) => {
    writes.push(body.publiclyVisible);
    return { data: { publiclyVisible: body.publiclyVisible } };
  }) as typeof api.patch;

  renderWithIntl(<PublicVisibilitySection />, { locale: "zh-cn" });
  const toggle = await screen.findByTestId("public-visibility-switch");
  assert.match(screen.getByTestId("public-visibility-section").textContent ?? "", /目前没有标记为「访客可见」的频道/);
  fireEvent.click(toggle);

  await waitFor(() => assert.deepEqual(writes, [false]));
  assert.equal(screen.queryByRole("dialog"), null);
});

test("admins never receive the owner-only public visibility surface or API read", () => {
  seed("admin");
  let reads = 0;
  api.get = (async () => {
    reads += 1;
    throw new Error("must not be called");
  }) as typeof api.get;

  renderWithIntl(<PublicVisibilitySection />);
  assert.equal(screen.queryByTestId("public-visibility-section"), null);
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
  assert.equal(screen.queryByTestId("public-visibility-section"), null);
  assert.equal(reads, 0);
});
