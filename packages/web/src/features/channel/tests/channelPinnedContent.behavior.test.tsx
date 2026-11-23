/**
 * Channel details › Pinned content (the channel announcement, #proj-chat:#35, cindyz): a section heading
 * "Pinned content" / 「置顶内容」 over one box. Pinned: one row that opens the Artifact (its kind's icon, the title,
 * "Updated by X · time"), with ⋯ (Replace pin, Unpin) only for who may change it. Nothing pinned: the same heading
 * over a muted "Nothing pinned" and Pin an Artifact, for who may pin; nothing at all for anyone else.
 * Absence is asserted as `assert.ok(x === null)`, never with a DOM node inside node:assert.
 */
import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { asArtifactId } from "@botiverse/raft-shared";
import type { ArtifactKind, ChannelAnnouncementForPerson } from "@botiverse/raft-shared";

import { TestIntlProvider } from "../../../../tests/helpers/intl";
import { ChannelAnnouncementField } from "../../../components/channel/ChannelAnnouncementField";
import { en as enMessages } from "../../../i18n/messages/en";
import { zhCn as zhCnMessages } from "../../../i18n/messages/zh-cn";

const en = enMessages as Record<string, string>;
const zh = zhCnMessages as Record<string, string>;

const CHANNEL_ID = "channel-launch";
const ARTIFACT_ID = asArtifactId("pt_release-rules");

const state = vi.hoisted(() => ({
  announcement: undefined as unknown,
  kind: null as ArtifactKind | null,
  opened: [] as Array<{ id: string; channelId: string }>,
  set: [] as Array<{ channelId: string; artifactId: string | null }>,
}));

vi.mock("../../../store/channelAnnouncementStore", () => ({
  useChannelAnnouncement: () => state.announcement,
  setChannelAnnouncement: async (channelId: string, artifactId: string | null) => {
    state.set.push({ channelId, artifactId });
  },
}));
vi.mock("../../../apps/artifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../apps/artifacts")>();
  return {
    ...actual,
    useChannelAnnouncementKind: () => state.kind,
    openChannelAnnouncement: (id: string, _from: HTMLElement, channelId: string) => {
      state.opened.push({ id, channelId });
      return true;
    },
    useConversationArtifacts: () => ({ view: { status: "ready", cards: [], nextCursor: null, more: "idle" }, retry: () => {}, showMore: () => {} }),
  };
});

function pinned(overrides: Partial<ChannelAnnouncementForPerson> = {}): ChannelAnnouncementForPerson {
  return {
    artifactId: ARTIFACT_ID,
    title: "Release rules for 1.9",
    version: 4,
    updatedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    updatedBy: { type: "agent", id: "agent-builder", name: "Builder" },
    note: null,
    seen: true,
    excerpt: null,
    ...overrides,
  };
}

function renderField({ canEdit, locale = "en", onOpened }: { canEdit: boolean; locale?: "en" | "zh-cn"; onOpened?: () => void }) {
  return render(
    <TestIntlProvider locale={locale}>
      <ChannelAnnouncementField channelId={CHANNEL_ID} channelName="launch" channelType="channel" canEdit={canEdit} onOpened={onOpened} />
    </TestIntlProvider>,
  );
}

beforeEach(() => {
  state.announcement = undefined;
  state.kind = null;
  state.opened = [];
  state.set = [];
});
afterEach(() => cleanup());

test("the copy says Pinned content, never Announcement, in English and Chinese", () => {
  assert.equal(en["channel.announcement.label"], "Pinned content");
  assert.equal(zh["channel.announcement.label"], "置顶内容");
  assert.equal(en["channel.announcement.details.replace"], "Replace pin");
  assert.equal(en["channel.announcement.details.remove"], "Unpin");
  assert.equal(zh["channel.announcement.details.replace"], "更换置顶");
  assert.equal(zh["channel.announcement.details.remove"], "取消置顶");
  for (const [id, text] of Object.entries(en)) {
    if (id.startsWith("channel.announcement.")) assert.doesNotMatch(text, /announcement/i, id);
  }
  for (const [id, text] of Object.entries(zh)) {
    if (id.startsWith("channel.announcement.")) assert.doesNotMatch(text, /公告/, id);
  }
});

test("pinned: a section headed Pinned content with one row: kind icon, title, Updated by and time; the row opens it", () => {
  state.announcement = pinned();
  state.kind = "html";
  const opened = vi.fn();
  renderField({ canEdit: false, onOpened: opened });

  const section = screen.getByRole("region", { name: en["channel.announcement.label"] });
  const row = within(section).getByTestId("channel-settings-announcement-item");
  assert.equal(row.dataset.kind, "html", "the row draws the Artifact's kind (HTML here)");
  assert.equal(within(row).getByTestId("channel-settings-announcement-link").textContent, "Release rules for 1.9");
  assert.match(within(row).getByTestId("channel-settings-announcement-meta").textContent ?? "", /^Updated by Builder · .+/);
  // A long name gives way, the time doesn't: only the name truncates.
  assert.equal(within(row).getByTestId("channel-settings-announcement-meta-name").textContent, "Builder");
  assert.match(within(row).getByTestId("channel-settings-announcement-meta-name").className, /\btruncate\b/);
  assert.match(within(row).getByTestId("channel-settings-announcement-meta-time").className, /\bshrink-0\b/);

  fireEvent.click(within(row).getByTestId("channel-settings-announcement-link"));
  assert.deepEqual(state.opened, [{ id: ARTIFACT_ID, channelId: CHANNEL_ID }]);
  assert.equal(opened.mock.calls.length, 1, "the host hears it opened (a phone closes the details page)");
});

test("pinned, kind not read yet: the row shows a document icon", () => {
  state.announcement = pinned();
  renderField({ canEdit: false });
  assert.equal(screen.getByTestId("channel-settings-announcement-item").dataset.kind, "markdown");
});

test("a member sees the pinned row without ⋯", () => {
  state.announcement = pinned();
  renderField({ canEdit: false });
  assert.ok(screen.queryByTestId("channel-settings-announcement-actions") === null, "no ⋯ for who can't change it");
});

test("a manager's ⋯ offers Replace pin and Unpin; Unpin confirms, then unpins", async () => {
  state.announcement = pinned();
  renderField({ canEdit: true });

  fireEvent.click(screen.getByTestId("channel-settings-announcement-actions"));
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Replace pin", "Unpin"]);

  fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));
  const confirm = await screen.findByTestId("channel-settings-announcement-remove-confirm");
  assert.equal(confirm.textContent, "Unpin");
  fireEvent.click(confirm);
  await waitFor(() => assert.deepEqual(state.set, [{ channelId: CHANNEL_ID, artifactId: null }]));
});

test("a manager's Replace pin opens the picker titled Replace pin", async () => {
  state.announcement = pinned();
  renderField({ canEdit: true });
  fireEvent.click(screen.getByTestId("channel-settings-announcement-actions"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Replace pin" }));
  assert.ok(await screen.findByRole("dialog", { name: "Replace pin" }));
});

test("nothing pinned, a manager: the same heading over Nothing pinned and Pin an Artifact (the picker)", async () => {
  state.announcement = null;
  renderField({ canEdit: true });

  const section = screen.getByRole("region", { name: en["channel.announcement.label"] });
  const empty = within(section).getByTestId("channel-settings-announcement-empty");
  assert.match(empty.textContent ?? "", /Nothing pinned/);
  fireEvent.click(within(empty).getByRole("button", { name: "Pin an Artifact" }));
  assert.ok(await screen.findByRole("dialog", { name: "Pin an Artifact" }));
});

test("nothing pinned, in Chinese: 置顶内容 over 没有置顶内容 and 置顶一个 Artifact", () => {
  state.announcement = null;
  renderField({ canEdit: true, locale: "zh-cn" });
  const section = screen.getByRole("region", { name: "置顶内容" });
  assert.match(section.textContent ?? "", /没有置顶内容/);
  assert.ok(within(section).getByRole("button", { name: "置顶一个 Artifact" }));
});

test("nothing pinned, a member: no section at all", () => {
  state.announcement = null;
  const { container } = renderField({ canEdit: false });
  assert.ok(container.querySelector("[data-testid=channel-settings-announcement]") === null);
});
