import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import CreateChannelDialog from "../src/components/channel/CreateChannelDialog";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";

// CreateChannelDialog — first component in the `channel.*` namespace.
//
// Namespace choice: catalog namespaces map to component directories
// (message.* / agent.* / machine.* / settings.* / layout.* / member.* / ui.*),
// and src/components/channel/ had none. So `channel.create.*`, leaving
// `channel.edit.*` and `channel.createJoint.*` for the two siblings. Decided
// before writing keys — inventing a parallel namespace is how settings.* nearly
// grew a stray `settings.administration.*` in sub-batch G.
//
// Assertions here are only what typecheck cannot enforce (per @artin): id
// presence is already a compile error via Record<MessageId, string>.

afterEach(() => {
  cleanup();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("the dialog renders in Chinese, with no untranslated English in the DOM", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter>
        <CreateChannelDialog onClose={() => {}} />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  const text = document.body.textContent ?? "";
  for (const zh of ["创建频道", "名称", "描述", "可见性", "公开", "私密", "成员", "取消"]) {
    assert.ok(text.includes(zh), `dialog should render ${zh}`);
  }

  // The DOM-dump backstop. `Agent` stays English by product convention (cf.
  // 引导 Agent in the catalog); everything else must be gone. This is the check
  // that catches ternary arms and split-JSX prose, which both static scanners
  // miss — and which cost 41 findings on the AppNotifications batch.
  // The `optional` exemption that used to live here is GONE: ui/FormField now
  // localizes its marker (task #14 / #5742, merged 62ddeb27f), so `(optional)`
  // must no longer appear. Leaving the exemption would have silently disabled
  // this dump's ability to catch it regressing to English — an allowlist that
  // outlives its reason is a guard that stopped guarding.
  const runs = new Set(text.match(/[A-Za-z][A-Za-z ]{5,}/g) ?? []);
  const allowed = /^(Agent|Agents)[A-Za-z ]*$/;
  const unexpected = [...runs].filter((r) => !allowed.test(r.trim()));
  assert.deepEqual(unexpected, [], `untranslated English reached the DOM: ${unexpected.join(" | ")}`);
});

test("the visibility control's label and accessible name are BOTH Chinese", () => {
  // The split-attribute class: `label` and `ariaLabel` sit on one control, and
  // migrating only the visible one leaves screen-reader users on English while
  // the UI looks fully translated. Queried by role+name so the accessible name
  // is what's asserted, not the visible text.
  render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter>
        <CreateChannelDialog onClose={() => {}} />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  assert.ok(screen.getByText("可见性"), "visible label");
  assert.ok(
    document.querySelector('[aria-label="频道可见性"]'),
    "accessible name must be Chinese too",
  );
  assert.equal(
    document.querySelector('[aria-label="Channel visibility"]'), null,
    "no untranslated aria-label",
  );
});

test("the two ICU messages keep their arguments", () => {
  // `Channel limit reached ({used}/{max} on {plan} plan).` and
  // `No matches for "{query}"` were English sentences with values concatenated
  // in. Dropping an argument does not fail typecheck — formatMessage just
  // renders without it.
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  for (const arg of ["{used}", "{max}", "{plan}"]) {
    assert.ok(en["channel.create.limitReached"].includes(arg), `en limitReached needs ${arg}`);
    assert.ok(zh["channel.create.limitReached"].includes(arg), `zh limitReached needs ${arg}`);
  }
  assert.ok(en["channel.create.noMatchesFor"].includes("{query}"), "en noMatchesFor needs {query}");
  assert.ok(zh["channel.create.noMatchesFor"].includes("{query}"), "zh noMatchesFor needs {query}");
});

test("zh values are translated, and Cancel reuses the shared key", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  for (const id of Object.keys(en).filter((k) => k.startsWith("channel.create."))) {
    // `agents` deliberately stays "Agent" in zh — the product's own term.
    if (id === "channel.create.agents") continue;
    assert.notEqual(zh[id], en[id], `${id} is still the English string`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }

  // Cancel reuses settings.common.cancel rather than adding channel.create.cancel —
  // a second key for one word is how a catalog starts drifting.
  assert.equal(en["channel.create.cancel"], undefined, "Cancel must not get its own key");
  assert.ok(en["settings.common.cancel"], "the shared Cancel key must exist");
});

test("the archived-name-collision response renders its zh-cn recovery state", async () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;
  for (const id of [
    "channel.create.archivedNameHeld",
    "channel.create.archivedCanManage",
    "channel.create.archivedCannotManage",
  ]) {
    assert.notEqual(zh[id], en[id], `${id} is still English`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }

  // The mono span lives INSIDE the message as a <mono> tag so translators can
  // move it; the sentence is not split around a bare <span> any more. Note the
  // ICU argument is {name} and the tag is <mono> — same identifier for both is a
  // duplicate-key compile error.
  assert.match(en["channel.create.archivedNameHeld"], /<mono>#\{name\}<\/mono>/, "en keeps the <mono> tag");
  assert.match(zh["channel.create.archivedNameHeld"], /<mono>#\{name\}<\/mono>/, "zh keeps the <mono> tag");

  useAuthStore.setState({ user: { id: "user-1" } } as never);
  useServerStore.setState({
    current: { id: "server-1", plan: "free", role: "owner" },
    members: [],
  } as never);
  useChannelStore.setState({
    channels: [],
    createChannel: async () => Promise.reject({
      response: {
        data: {
          code: "archived_name_collision",
          archivedChannelId: "archived-1",
          archivedChannelName: "旧频道",
          archivedChannelType: "channel",
          canUnarchiveArchivedChannel: true,
        },
      },
    }),
  } as never);

  render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter>
        <CreateChannelDialog onClose={() => {}} prefilledName="旧频道" />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "创建频道" }));

  assert.ok(await screen.findByText((_, element) =>
    element?.tagName === "P"
      && element.textContent === "名称 #旧频道 已被一个已归档的频道占用。"));
  assert.ok(screen.getByText(zh["channel.create.archivedCanManage"]));
  assert.ok(screen.getByRole("button", { name: zh["channel.create.unarchive"] }));
  assert.ok(screen.getByRole("button", { name: zh["channel.create.changeName"] }));
  assert.doesNotMatch(document.body.textContent ?? "", /is held by an archived channel|Unarchive it to keep its history/);
});
