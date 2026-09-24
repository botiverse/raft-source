import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import EditChannelDialog from "../src/components/channel/EditChannelDialog";
import { formatNameValidationError } from "../src/i18n/nameValidation";
import { useChannelStore } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";
import { useAuthStore } from "../src/store/authStore";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import api from "../src/api/client";
import type { SidebarPinnedRef } from "../src/utils/sidebarPinnedRefs";
import { resetServerFeatureFlagsForTests, setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { TOPBAR_OVERFLOW_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

// EditChannelDialog — 68 ids under `channel.edit.*` (namespace from #5739).
//
// WHY THIS FILE LEANS SO HARD ON CLICKING THE CONFIRM DIALOGS:
// my first pass at this component migrated every ConfirmDialog `title`,
// `confirmLabel` and `loadingLabel` and left EVERY `message` prop in English —
// 11 full sentences, including the delete and leave warnings. Both static
// scanners reported the file CLEAN, because:
//   * the repo scanner does not model ternary arms or template literals at all;
//   * my sweep's prose rule capped word count at 20, so the LONGEST sentences
//     (the 27-word "Hide #all?…") hid best, while their shorter siblings were
//     caught — a length cap on a residue detector inverts the risk;
//   * its word class required every word to start [A-Za-z], so `#all` broke the
//     chain — and `#channel` is this repo's own documented ref grammar;
//   * its template rule only inspected the prefix abutting `${`, so
//     `Make "${name}" public? …` escaped on the quote character.
// The static tools now catch all of these, but the durable guard is the one
// below: OPEN EACH DIALOG AND READ THE DOM. Short labels are what scanners see;
// long prose is what users read.

const PROBE_NAME = "ai-research";
const originalPatch = api.patch.bind(api);

afterEach(() => {
  cleanup();
  api.patch = originalPatch;
  useChannelStore.setState({ channels: [] } as never);
  useServerStore.setState({ servers: [], current: null, members: [] } as never);
  useAuthStore.setState({ user: null } as never);
  resetServerFeatureFlagsForTests();
});

/** The form body is gated on action-specific channel capabilities, which come from the
 *  server store's role — with no seeded role the dialog renders only its title
 *  and Cancel, and a DOM dump would pass while asserting nearly nothing. */
function seed(
  channelOver: Record<string, unknown> = {},
  serverOver: Record<string, unknown> = {},
  pinned: SidebarPinnedRef[] = [],
  topbarOverflowEnabled = true,
) {
  const server = { id: "s1", slug: "s1", name: "S", role: "owner", plan: "pro", ...serverOver };
  useAuthStore.setState({ user: { id: "u1", name: "U" }, initialized: true } as never);
  useServerStore.setState({
    servers: [server],
    current: server,
    members: [],
    loading: false,
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual" as const,
      jointChannelSortMode: "manual" as const,
      dmSortMode: "manual" as const,
      pinnedSortMode: "manual" as const,
      pinned,
      pinnedChannelIds: pinned.filter((r) => r.kind === "channel").map((r) => r.id),
      pinnedAgentIds: pinned.filter((r) => r.kind === "agent").map((r) => r.id),
      pinnedOrder: pinned.map((r) => `${r.kind}:${r.id}`),
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      pinnedVersion: 0,
    },
  } as never);
  useChannelStore.setState({
    channels: [{
      id: "c1", name: PROBE_NAME, description: "", type: "channel",
      serverId: "s1", archivedAt: null, jointServers: [], ...channelOver,
    }],
  } as never);
  setServerFeatureFlagForTests("s1", TOPBAR_OVERFLOW_FEATURE_FLAG_KEY, topbarOverflowEnabled);
  return String(channelOver.name ?? PROBE_NAME);
}

function renderZh(name: string, onLeave = true) {
  return render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter>
        <EditChannelDialog
          channelId="c1"
          initialName={name}
          initialDescription=""
          onLeaveChannel={onLeave ? async () => {} : undefined}
          onClose={() => {}}
        />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

/** `Agent` and `handle` are the product's own terms and stay English inside zh
 *  copy (`handle` per Raft's own agent docs: "your @mention handle"); `research`
 *  is a fragment of the seeded channel name, which is data, not copy. Everything
 *  else appearing as an English word run is residue.
 *  NOTE: `handle` is a copy judgement, not a mechanical exemption — it is in the
 *  batch sent to @AngLee for confirmation. If it is ruled translatable, this
 *  entry comes out and `channel.edit.invitedPeopleHint` changes with it. */
function assertNoEnglish(context: string) {
  const text = document.body.textContent ?? "";
  const runs = new Set(text.match(/[A-Za-z][A-Za-z ]{5,}/g) ?? []);
  const unexpected = [...runs]
    .map((r) => r.trim())
    .filter((r) => !/^(Agent|Agents|handle|research)$/.test(r));
  assert.deepEqual(unexpected, [], `untranslated English in ${context}: ${unexpected.join(" | ")}`);
}

test("the default edit state renders in Chinese with no untranslated English", () => {
  renderZh(seed());

  const text = document.body.textContent ?? "";
  for (const zh of ["设置", "名称", "描述", "保存更改", "取消"]) {
    assert.ok(text.includes(zh), `dialog should render ${zh}`);
  }
  assertNoEnglish("the default edit state");
});

test("the #all channel renders its Chinese rename hint", () => {
  // `allCannotRename` is a ternary arm on FormField's `hint` prop. It survived
  // both scanners in the first pass because `#all` broke the prose word chain.
  renderZh(seed({ name: "all" }));

  assert.ok(
    (document.body.textContent ?? "").includes("#all 频道无法重命名"),
    "the #all rename hint must be Chinese",
  );
  assertNoEnglish("the #all edit state");
});

// Every ConfirmDialog reachable from this component, with the state that
// produces it and the trigger that opens it. Each row's `message` prop was
// English until this batch.
const CONFIRMS: Array<{
  what: string;
  channel: Record<string, unknown>;
  server?: Record<string, unknown>;
  trigger: string;
  expect: string;
  action: string;
}> = [
  { what: "archive", channel: {}, trigger: "归档频道", expect: "成员仍可阅读", action: "归档" },
  { what: "make private", channel: {}, trigger: "设为私密", expect: "未加入的服务器成员", action: "私密" },
  { what: "make public", channel: { type: "private" }, trigger: "设为公开", expect: "所有服务器成员将恢复", action: "公开" },
  { what: "hide #all", channel: { name: "all" }, trigger: "隐藏 #all", expect: "#all 将从频道列表中消失", action: "隐藏 #all" },
  { what: "restore #all", channel: { name: "all", type: "private" }, trigger: "恢复 #all", expect: "#all 将重新作为面向服务器成员", action: "恢复 #all" },
  { what: "leave", channel: {}, trigger: "退出频道", expect: "你将停止接收", action: "离开" },
  { what: "delete", channel: {}, trigger: "删除频道", expect: "都会被永久删除", action: "删除" },
  {
    what: "disconnect joint",
    channel: { type: "joint", jointServers: [{ serverId: "s2", serverSlug: "x" }] },
    trigger: "断开频道",
    expect: "将从此服务器移除",
    action: "断开",
  },
  {
    what: "convert to joint",
    channel: {},
    server: { slug: "botiverse" },
    trigger: "转换为联合频道",
    expect: "转换期间",
    action: "转换",
  },
];

for (const c of CONFIRMS) {
  test(`the ${c.what} confirmation renders its message in Chinese`, () => {
    renderZh(seed(c.channel, c.server));
    fireEvent.click(screen.getByRole("button", { name: c.trigger }));

    const text = document.body.textContent ?? "";
    assert.ok(text.includes(c.expect), `${c.what} message missing: ${c.expect}`);
    const dialog = screen.getAllByRole("dialog").at(-1)!;
    assert.ok(within(dialog).getByRole("button", { name: c.action }));
    assertNoEnglish(`the ${c.what} confirmation`);
  });
}

test("the interpolated confirmations name the channel via ICU, not concatenation", () => {
  // These four were template literals built around `${initialName}`. An ICU
  // argument that gets dropped does not fail typecheck — formatMessage just
  // renders the sentence without it, so the user sees 「」 with nothing inside.
  renderZh(seed());
  fireEvent.click(screen.getByRole("button", { name: "删除频道" }));
  assert.ok(
    (document.body.textContent ?? "").includes(`「${PROBE_NAME}」及其中的所有消息都会被永久删除`),
    "the channel name must be interpolated into the delete confirmation",
  );

  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;
  for (const id of [
    "channel.edit.confirmArchive",
    "channel.edit.confirmMakePublic",
    "channel.edit.confirmMakePrivate",
    "channel.edit.confirmLeave",
    "channel.edit.confirmConvert",
    "channel.edit.confirmDisconnect",
    "channel.edit.confirmDelete",
  ]) {
    assert.match(en[id], /\{name\}/, `en ${id} needs {name}`);
    assert.match(zh[id], /\{name\}/, `zh ${id} needs {name}`);
  }
});

test("the task-identity drop sentence is one ICU plural message", () => {
  // DECLARED GAP, narrowly: this string renders only when `taskIdentityDropPrompt`
  // is set, and that state is written ONLY from the convert API's response body
  // (`handleConvertToJoint`). There is no prop or context seam to reach it, so it
  // stays catalog-only here; the render tooth belongs in e2e. Every OTHER confirm
  // message above is click-covered.
  //
  // It was previously assembled from four JSX fragments around two {expr} holes
  // plus an inline `? "" : "s"` — a sentence frame that cannot translate as a
  // unit, and that neither scanner nor my sweep models even now.
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;
  const id = "channel.edit.taskIdentityDropCount";
  for (const arg of ["{direct}", "{threads}"]) {
    assert.ok(en[id].includes(arg), `en ${id} needs ${arg}`);
    assert.ok(zh[id].includes(arg), `zh ${id} needs ${arg}`);
  }
  assert.match(en[id], /\{count, plural,/, "en must pluralize via ICU, not a ternary");
  assert.match(zh[id], /\{count, plural,/, "zh must pluralize via ICU");
  // zh has no plural distinction: a single `other` arm is correct, and an `one`
  // arm copied over from English would be a mistranslation, not a nicety.
  assert.ok(!/\bone\s*\{/.test(zh[id]), "zh must not carry an English `one` arm");
});

test("confirmation buttons use short action verbs instead of repeating dialog titles", () => {
  assert.equal(enMessages["channel.edit.archiveAction"], "Archive");
  assert.equal(enMessages["channel.edit.disconnectAction"], "Disconnect");
  assert.equal(enMessages["channel.edit.deleteAction"], "Delete");
  assert.equal(zhMessages["channel.edit.archiveAction"], "归档");
  assert.equal(zhMessages["channel.edit.disconnectAction"], "断开");
  assert.equal(zhMessages["channel.edit.deleteAction"], "删除");
});

test("every ternary button pair is two distinct messages", () => {
  // 12 idle/in-flight pairs. If a later edit collapses either arm onto the other
  // key, one state silently shows the wrong label — and no render test that only
  // exercises the idle state would notice.
  const zh = zhMessages as Record<string, string>;
  const pairs: Array<[string, string]> = [
    ["channel.edit.resending", "channel.edit.resendInvite"],
    ["channel.edit.inviting", "channel.edit.sendInvite"],
    ["channel.edit.saving", "channel.edit.saveChanges"],
    ["channel.edit.converting", "channel.edit.convertToJoint"],
    ["channel.edit.unarchiving", "channel.edit.unarchiveChannel"],
    ["channel.edit.restoreAll", "channel.edit.hideAll"],
    ["channel.edit.makeChannelPublic", "channel.edit.makeChannelPrivate"],
    ["channel.edit.makePublic", "channel.edit.makePrivate"],
    ["channel.edit.disconnectJointChannel", "channel.edit.deleteChannel"],
    ["channel.edit.disconnectChannel", "channel.edit.deleteChannel"],
    ["channel.edit.disconnecting", "channel.edit.deleting"],
    ["channel.edit.leaveAction", "channel.edit.leaving"],
  ];
  for (const [a, b] of pairs) {
    assert.notEqual(zh[a], zh[b], `${a} and ${b} must stay distinct`);
  }
});

test("the max-servers sentence is ONE ICU message used by both call sites", () => {
  // It was built twice — once as a template literal for the error path, once as
  // JSX prose. Two copies of one sentence drift; a single {max} message cannot.
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;
  assert.match(en["channel.edit.maxServers"], /\{max\}/, "en needs {max}");
  assert.match(zh["channel.edit.maxServers"], /\{max\}/, "zh needs {max}");
});

test("zh values are translated, and Cancel reuses the shared key", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;
  for (const id of Object.keys(en).filter((k) => k.startsWith("channel.edit."))) {
    assert.notEqual(zh[id], en[id], `${id} is still the English string`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }
  assert.equal(en["channel.edit.cancel"], undefined, "Cancel must reuse settings.common.cancel");
});

// ---------------------------------------------------------------------------
// @Wug's review of #5756 found three residues this file's first version missed.
// All three are shapes my sweep ALSO missed, for a fourth and fifth reason:
//   * `${count} invite emails resent.` -- after punching out the ${...} hole the
//     residue starts LOWERCASE, and the prose rule required a capital first word.
//   * `cond ? " · This server" : ""` -- the ternary rule required BOTH arms to be
//     non-empty, so an empty else-arm disabled it.
//   * `{server.status}` -- a raw data value rendered as a label. No string
//     scanner can ever see this one; only a render assertion can.
// Both sweep bugs are fixed; the third is why render coverage is the real tooth.
// ---------------------------------------------------------------------------

test("the invite-sent status pluralizes in Chinese, not just the singular case", () => {
  // The bug: singular went through the catalog, plural fell through to an
  // English template literal -- so inviting ONE person looked fully translated
  // and inviting two did not. Assert BOTH arms.
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;
  for (const id of ["channel.edit.inviteSentCount", "channel.edit.inviteResentCount"]) {
    assert.match(en[id], /\{count, plural,/, `en ${id} must be an ICU plural`);
    assert.match(zh[id], /\{count, plural,/, `zh ${id} must be an ICU plural`);
    assert.ok(!/\bone\s*\{/.test(zh[id]), `zh ${id} must not carry an English one-arm`);
  }

  // The singular-only ids they replaced are removed, not left dangling: a dead
  // catalog key is the next migration's false evidence that a case is handled.
  assert.equal(en["channel.edit.inviteSent"], undefined, "superseded singular id must be gone");
  assert.equal(en["channel.edit.inviteResent"], undefined, "superseded singular id must be gone");
});

test("the connected-server row renders Chinese for the current server and both statuses", () => {
  // `{server.status}` rendered the raw union value ("active" / "pending"). A
  // data value used as a label is invisible to every string scanner, so this
  // assertion is the only thing that can catch it.
  seed({
    type: "joint",
    jointServers: [
      { serverId: "s1", serverSlug: "home", serverName: "Home", status: "active", isCurrentServer: true },
      { serverId: "s2", serverSlug: "peer", serverName: "Peer", status: "pending", isCurrentServer: false },
    ],
  });
  renderZh("ai-research");

  const text = document.body.textContent ?? "";
  assert.ok(text.includes("此服务器"), "current-server marker must be Chinese");
  assert.ok(text.includes("已连接"), "active status must be Chinese");
  assert.ok(text.includes("待接受"), "pending status must be Chinese");
  assert.ok(!text.includes("This server"), "no untranslated current-server marker");
  // The raw union values must not reach the DOM as labels. Checked against the
  // rendered text rather than the source, because the source legitimately still
  // contains "active" as a comparison operand.
  assert.ok(!/\bactive\b/.test(text), "raw status value leaked");
  assert.ok(!/\bpending\b/.test(text), "raw status value leaked");
});

test("name-validation errors are built entirely from the catalog", () => {
  // Passing a TRANSLATED label into shared validateName produces "频道名称 is
  // required" -- a mixed-language sentence, and one no scanner flags because no
  // English literal appears at the call site. The reason-code path formats the
  // whole sentence instead.
  const zh = zhMessages as Record<string, string>;
  assert.equal(
    formatNameValidationError({ code: "required" }, "channel.edit.nameFieldName",
      ((d: { id: string }, v?: Record<string, unknown>) =>
        (zh[d.id] ?? d.id).replace(/\{(\w+)\}/g, (_m, k) => String(v?.[k] ?? ""))) as never),
    "请填写频道名称",
  );
  assert.equal(
    formatNameValidationError({ code: "tooShort", minLength: 5 }, "channel.edit.nameFieldName",
      ((d: { id: string }, v?: Record<string, unknown>) =>
        (zh[d.id] ?? d.id).replace(/\{(\w+)\}/g, (_m, k) => String(v?.[k] ?? ""))) as never),
    "频道名称至少需要 5 个字符",
  );
  assert.equal(formatNameValidationError(null, "channel.edit.nameFieldName", (() => "") as never), null);
});

// ---------------------------------------------------------------------------
// Channel Settings Pin/Unpin action — task #552.
// These are behavior teeth, not i18n teeth, but they live here because this
// file already owns the EditChannelDialog render harness and store seeding.
// ---------------------------------------------------------------------------

test("the Pin action is visible for an ordinary unpinned channel", () => {
  renderZh(seed({}, {}, [], false));
  assert.ok(screen.getByRole("button", { name: "置顶" }), "Pin button must render");
  assert.equal(screen.queryByRole("button", { name: "取消置顶" }), null, "Unpin button must not render");
});

test("the Unpin action is visible when the channel is already pinned", () => {
  renderZh(seed({}, {}, [{ kind: "channel", id: "c1" }], false));
  assert.ok(screen.getByRole("button", { name: "取消置顶" }), "Unpin button must render");
  assert.equal(screen.queryByRole("button", { name: "置顶" }), null, "Pin button must not render");
});

test("the #all channel does not show Pin/Unpin", () => {
  renderZh(seed({ name: "all" }));
  assert.equal(screen.queryByRole("button", { name: "置顶" }), null);
  assert.equal(screen.queryByRole("button", { name: "取消置顶" }), null);
});

test("pinning a channel appends it to pinned refs and preserves unrelated refs", async () => {
  const unrelated: SidebarPinnedRef = { kind: "agent", id: "agent-other" };
  renderZh(seed({}, {}, [unrelated], false));

  let patchedUrl = "";
  let patchedPayload: unknown = null;
  api.patch = ((url: string, payload: unknown) => {
    patchedUrl = url;
    patchedPayload = payload;
    return Promise.resolve({ data: {} });
  }) as typeof api.patch;

  fireEvent.click(screen.getByRole("button", { name: "置顶" }));

  await waitFor(() => assert.equal(patchedUrl, "/servers/s1/sidebar-order"));
  assert.deepEqual(
    (patchedPayload as { pinned: SidebarPinnedRef[] }).pinned,
    [unrelated, { kind: "channel", id: "c1" }],
    "pin must append the channel ref after the unrelated ref",
  );
});

test("unpinning a channel removes only its ref and preserves unrelated refs", async () => {
  const unrelated: SidebarPinnedRef = { kind: "agent", id: "agent-other" };
  renderZh(seed({}, {}, [{ kind: "channel", id: "c1" }, unrelated], false));

  let patchedPayload: unknown = null;
  api.patch = ((_url: string, payload: unknown) => {
    patchedPayload = payload;
    return Promise.resolve({ data: {} });
  }) as typeof api.patch;

  fireEvent.click(screen.getByRole("button", { name: "取消置顶" }));

  await waitFor(() => {
    assert.deepEqual(
      (patchedPayload as { pinned: SidebarPinnedRef[] }).pinned,
      [unrelated],
      "unpin must remove only the channel ref",
    );
  });
});

test("pinning tolerates a missing pinned array in the fixture", async () => {
  // Mirrors the regression surface from old PR #4450: legacy fixtures may not
  // seed sidebarOrder.pinned. The action must treat it as empty, not throw.
  const server = { id: "s1", slug: "s1", name: "S", role: "owner", plan: "pro" };
  useAuthStore.setState({ user: { id: "u1", name: "U" }, initialized: true } as never);
  useServerStore.setState({
    servers: [server],
    current: server,
    members: [],
    loading: false,
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinned: undefined as never,
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      pinnedVersion: 0,
    },
  } as never);
  useChannelStore.setState({
    channels: [{
      id: "c1", name: PROBE_NAME, description: "", type: "channel",
      serverId: "s1", archivedAt: null, jointServers: [],
    }],
  } as never);

  renderZh(PROBE_NAME);

  let patchedPayload: unknown = null;
  api.patch = ((_url: string, payload: unknown) => {
    patchedPayload = payload;
    return Promise.resolve({ data: {} });
  }) as typeof api.patch;

  fireEvent.click(screen.getByRole("button", { name: "置顶" }));

  await waitFor(() => {
    assert.deepEqual(
      (patchedPayload as { pinned: SidebarPinnedRef[] }).pinned,
      [{ kind: "channel", id: "c1" }],
      "pin must work when pinned is missing",
    );
  });
});
