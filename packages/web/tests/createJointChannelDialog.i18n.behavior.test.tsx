import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import CreateJointChannelDialog from "../src/components/channel/CreateJointChannelDialog";
import { useServerStore } from "../src/store/serverStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// CreateJointChannelDialog — 13 new `channel.createJoint.*` ids.
//
// MOST OF THIS FILE'S STRINGS WERE ALREADY IN THE CATALOG. 14 of them are
// byte-identical to ids `channel.create.*` / `channel.edit.*` already own
// (Name, Description, Agents, Humans, Cancel, Unarchive, Change name, the
// archived-collision sentence, the members search placeholder, the invite
// hint/placeholder/labels...). Those are REUSED, not duplicated: a second key
// holding the same English is how two translations of one sentence drift apart.
//
// Two ids I nearly added and deliberately did not:
//   * `serverSlugPlaceholder` ("partner-workspace") — an example slug with
//     nothing to translate. It stays a literal; adding it would have meant a zh
//     value identical to en, which the parity test below correctly rejects.
//   * `submit` — identical to `title`. One id renders both the heading and the
//     button.
//
// NAMESPACE SMELL, stated rather than hidden: five joint-invite strings are
// reused from `channel.edit.*` because EditChannelDialog got there first. They
// belong to neither dialog. Once #5756 lands they should move to a shared
// `channel.jointInvite.*`; reusing them beats duplicating them in the meantime.

afterEach(() => {
  cleanup();
  useServerStore.setState({ servers: [], current: null, members: [] } as never);
  useAgentStore.setState({ agents: [] } as never);
  useAuthStore.setState({ user: null } as never);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
});

function seed({ plan = "pro", withMembers = true }: { plan?: string; withMembers?: boolean } = {}) {
  const server = { id: "s1", slug: "s1", name: "S", role: "owner", plan };
  useAuthStore.setState({ user: { id: "u1", name: "U" }, initialized: true } as never);
  useAgentStore.setState({
    agents: withMembers ? [{ id: "a1", name: "bot", displayName: "机器人", avatarUrl: null }] : [],
  } as never);
  useServerStore.setState({
    servers: [server], current: server, loading: false,
    members: withMembers ? [{ userId: "u2", name: "bob", displayName: "小明" }] : [],
  } as never);
}

function renderZh() {
  return render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter>
        <CreateJointChannelDialog onClose={() => {}} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

/** `Agent`, `slug` and `handle` stay English inside zh copy by product
 *  convention (`handle` per @AngLee's ruling on the #5756 batch). Member names
 *  are seeded in Chinese so that an ASCII run can only come from copy. */
function assertNoEnglish(context: string) {
  const text = document.body.textContent ?? "";
  const runs = new Set(text.match(/[A-Za-z][A-Za-z ]{5,}/g) ?? []);
  const unexpected = [...runs]
    .map((r) => r.trim())
    .filter((r) => !/^(Agent|Agents|slug|handle)$/.test(r));
  assert.deepEqual(unexpected, [], `untranslated English in ${context}: ${unexpected.join(" | ")}`);
}

test("the default dialog renders in Chinese with no untranslated English", () => {
  seed();
  renderZh();

  const text = document.body.textContent ?? "";
  for (const zh of ["创建联合频道", "名称", "描述", "邀请服务器", "添加服务器", "当前服务器成员", "取消"]) {
    assert.ok(text.includes(zh), `dialog should render ${zh}`);
  }
  assertNoEnglish("the default state");
});

test("the limited-time Free allowance keeps creation enabled and renders in Chinese without a hard date", () => {
  seed({ plan: "free" });
  renderZh();

  const text = document.body.textContent ?? "";
  assert.ok(text.includes("Free 套餐可限时免费创建 1 个联合频道。"), "limited-time allowance banner");
  assert.ok(!text.includes("9 月 1 日"), "no expiry copy");
  assert.equal(
    (screen.getByRole("button", { name: "创建联合频道" }) as HTMLButtonElement).disabled,
    false,
    "the limited-time Free allowance must leave submit enabled",
  );
  assertNoEnglish("the limited-time Free allowance");
});

test("a Free server that already hosts one active Joint Channel sees the original disabled-form paywall", () => {
  seed({ plan: "free" });
  useChannelStore.setState({
    channels: [{
      id: "joint-hosted",
      name: "hosted-joint",
      description: null,
      type: "joint",
      createdAt: "2026-08-25T00:00:00.000Z",
      archivedAt: null,
      jointRole: "host",
    }],
  } as never);
  renderZh();

  assert.ok(screen.getByText("第二个联合频道需要 Pro 套餐。"));
  assert.ok(screen.getByRole("button", { name: "查看账单" }));
  assert.ok(screen.getByPlaceholderText("例如 partner-launch"), "the original create form remains visible");
  assert.ok(document.querySelector("form"), "the upfront gate must not collapse the dialog to a warning-only card");
  assert.equal(
    (screen.getByRole("button", { name: "创建联合频道" }) as HTMLButtonElement).disabled,
    true,
    "the original paywall shape keeps the form visible but disables creation",
  );
  assertNoEnglish("the upfront Free limit");
});

test("participant and archived host projections do not consume the Free server's active hosted allowance", () => {
  seed({ plan: "free" });
  useChannelStore.setState({
    channels: [
      {
        id: "joint-participant",
        name: "invited-joint",
        description: null,
        type: "joint",
        createdAt: "2026-08-25T00:00:00.000Z",
        archivedAt: null,
        jointRole: "participant",
      },
      {
        id: "joint-archived-host",
        name: "archived-hosted-joint",
        description: null,
        type: "joint",
        createdAt: "2026-08-24T00:00:00.000Z",
        archivedAt: "2026-08-25T00:00:00.000Z",
        jointRole: "host",
      },
    ],
  } as never);
  renderZh();

  assert.ok(screen.getByText("Free 套餐可限时免费创建 1 个联合频道。"));
  assert.ok(screen.getByPlaceholderText("例如 partner-launch"));
  assert.equal(screen.queryByText("第二个联合频道需要 Pro 套餐。"), null);
});

test("the second-channel limit response renders localized recovery", async () => {
  seed({ plan: "free" });
  useChannelStore.setState({
    createChannel: async () => {
      throw {
        response: {
          data: {
            code: "joint_channel_free_limit_reached",
            error: "Creating a second Joint Channel requires the Pro plan.",
          },
        },
      };
    },
  } as never);
  renderZh();

  fireEvent.change(screen.getByPlaceholderText("例如 partner-launch"), {
    target: { value: "第二个频道" },
  });
  fireEvent.change(screen.getByPlaceholderText("partner-workspace"), {
    target: { value: "partner" },
  });
  fireEvent.change(screen.getByPlaceholderText("@admin 或 admin@example.com"), {
    target: { value: "admin@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建联合频道" }));

  assert.ok(await screen.findByText("第二个联合频道需要 Pro 套餐。"));
  assert.ok(screen.getByRole("button", { name: "查看账单" }));
  assert.doesNotMatch(document.body.textContent ?? "", /Creating a second Joint Channel/);
});

test("the max-servers sentence interpolates the limit rather than concatenating it", () => {
  seed();
  renderZh();
  // The sentence was JSX prose split around {MAX_JOINT_CHANNEL_SERVERS}. Split
  // prose cannot translate as a unit — Chinese puts the number elsewhere in the
  // clause — so the whole sentence has to be one ICU message.
  assert.ok(
    (document.body.textContent ?? "").includes("联合频道最多支持 3 个服务器，含本服务器。"),
    "max-servers sentence must be one message with {max} filled in",
  );
  const en = enMessages as Record<string, string>;
  assert.match(en["channel.createJoint.maxServers"], /\{max\}/, "en needs {max}");
  assert.match((zhMessages as Record<string, string>)["channel.createJoint.maxServers"], /\{max\}/, "zh needs {max}");
});

test("a second server invite numbers both its heading and its remove button in Chinese", () => {
  // The remove button's accessible name was a template literal
  // (`Remove server invite ${n}`) — visible-text assertions are blind to it, so
  // it is queried by accessible name on purpose. The numbering only appears once
  // a SECOND draft exists, which is why this clicks "添加服务器" first.
  seed();
  renderZh();
  fireEvent.click(screen.getByRole("button", { name: "添加服务器" }));

  const text = document.body.textContent ?? "";
  assert.ok(text.includes("第 1 个服务器邀请"), "first invite heading");
  assert.ok(text.includes("第 2 个服务器邀请"), "second invite heading");
  assert.ok(screen.getByLabelText("移除第 2 个服务器邀请"), "remove button accessible name must be Chinese");
  assert.equal(document.querySelector('[aria-label^="Remove server invite"]'), null, "no English aria-label");
  assertNoEnglish("two server invites");
});

test("the member-picker empty and no-match states render in Chinese", () => {
  seed({ withMembers: false });
  renderZh();
  assert.ok(
    (document.body.textContent ?? "").includes("没有可选成员"),
    "empty member list — a state a seeded-with-data render never reaches",
  );

  cleanup();
  seed();
  renderZh();
  fireEvent.change(screen.getByPlaceholderText("按名称搜索成员"), {
    target: { value: "zzz-no-such-member" },
  });
  assert.ok(
    (document.body.textContent ?? "").includes("没有匹配「zzz-no-such-member」的结果"),
    "no-match state with the query interpolated",
  );
});

test("name validation errors are Chinese sentences, not a translated label in an English frame", () => {
  // Passing a translated label into shared validateName yields "频道名称 is
  // required". This dialog uses the reason-code path instead, so the whole
  // sentence comes from the catalog.
  seed();
  renderZh();
  const form = document.querySelector("form");
  assert.ok(form, "form present");
  fireEvent.submit(form as HTMLFormElement);

  const text = document.body.textContent ?? "";
  assert.ok(text.includes("请填写频道名称"), "validation error must be a full Chinese sentence");
  assert.ok(!text.includes("is required"), "no English sentence frame");
});

test("the archived-name-collision response renders catalog-backed recovery", async () => {
  seed();
  useChannelStore.setState({
    createChannel: async () => {
      throw {
        response: {
          data: {
            code: "archived_name_collision",
            archivedChannelId: "archived-1",
            archivedChannelName: "旧项目",
            archivedChannelType: "joint",
            canUnarchiveArchivedChannel: true,
          },
        },
      };
    },
  } as never);
  renderZh();

  fireEvent.change(screen.getByPlaceholderText("例如 partner-launch"), {
    target: { value: "旧项目" },
  });
  fireEvent.change(screen.getByPlaceholderText("partner-workspace"), {
    target: { value: "partner" },
  });
  fireEvent.change(screen.getByPlaceholderText("@admin 或 admin@example.com"), {
    target: { value: "admin@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建联合频道" }));

  assert.ok(await screen.findByText(/旧项目/));
  assert.ok(screen.getByRole("button", { name: "取消归档" }));
  assert.ok(screen.getByRole("button", { name: "修改名称" }));
  assert.doesNotMatch(document.body.textContent ?? "", /is held by an archived channel/);

  // The <mono> tag lives inside the message so a translator can move it.
  assert.match(
    (enMessages as Record<string, string>)["channel.create.archivedNameHeld"],
    /<mono>#\{name\}<\/mono>/,
    "the tag must stay inside the message",
  );
});

test("every new id is translated, and no string was duplicated to get there", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;
  const ids = Object.keys(en).filter((k) => k.startsWith("channel.createJoint."));
  assert.equal(ids.length, 13, "13 genuinely new strings; the rest are reused");

  for (const id of ids) {
    assert.notEqual(zh[id], en[id], `${id} is still the English string`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }

  // No new id may duplicate the English of another `channel.*` id. Scoped to
  // that family on purpose: within one domain, identical English really does
  // mean the same string, and a second key for it is how two translations drift
  // apart — which is the whole reason 14 strings here are reused rather than
  // re-minted. ACROSS domains it means nothing: "Add server" is also
  // `agent.mcp.addServer`, an MCP server, which must stay a separate id and may
  // well translate differently. Checking globally produced exactly that false
  // positive, so the scope is the point, not a loophole.
  const channelIds = new Map<string, string>();
  for (const [k, v] of Object.entries(en)) {
    if (k.startsWith("channel.") && !k.startsWith("channel.createJoint.")) channelIds.set(v, k);
  }
  for (const id of ids) {
    const clash = channelIds.get(en[id]);
    assert.equal(clash, undefined, `${id} duplicates the English of ${clash} — reuse it instead`);
  }

  // Two cross-surface collisions DO exist and are deliberate, recorded so they
  // stay visible: `channel.createJoint.title` vs `layout.sidebar.createJointChannel`,
  // and `channel.createJoint.viewBilling` vs `message.chatPanel.viewBilling`.
  // Same product action, re-minted per surface because the catalog has no
  // `common.action.*` namespace (`settings.common.cancel` is the precedent for
  // what it should look like). Importing layout.*/message.* ids into a channel
  // dialog is worse coupling than the duplication, so unifying them is a
  // catalog-shape pass of its own rather than something to smuggle in here.
  for (const existing of ["layout.sidebar.createJointChannel", "message.chatPanel.viewBilling"]) {
    assert.ok(en[existing], `${existing} must still exist for that note to make sense`);
  }
});
