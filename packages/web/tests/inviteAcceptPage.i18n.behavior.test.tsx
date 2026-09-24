import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import { TestIntlProvider } from "./helpers/intl";
import InviteAcceptPage from "../src/components/auth/InviteAcceptPage";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// InviteAcceptPage — 25 ids under `pages.invite.*`.
//
// The hard part of this file is the inside-count sentence. It was assembled at
// runtime by a module-scope helper:
//
//   pluralize(n, "human", "humans") -> <strong>{...}</strong>
//   <>Meet {segments[0]}{" and "}{segments[1]} inside.</>
//
// Three separate things make that untranslatable: the plural -s is hand-rolled
// English, the connectives ("Meet", "and", "inside.") are literals joined in
// English word order, and the <strong> positions are fixed by code. Chinese has
// no plural -s and orders the clause differently. So each SHAPE is now one
// complete ICU message and the helper only chooses which one.
//
// This file mounts the page for real via the existing api.get mock pattern, so
// there is no declared gap: every state below is genuinely rendered.

// ---------------------------------------------------------------------------
// REACT CONSOLE GUARD (@Wug's finding on #5763).
//
// react-intl renders rich-text chunks as an ARRAY, so a chunk function returning
// an unkeyed element triggers "Each child in a list should have a unique key
// prop". It is only a warning, so every assertion in this file passed while it
// was happening.
//
// The FIRST version of this guard was itself a false green: it installed the spy
// inside its own test, but React warns ONCE per element type, so the warning had
// already been emitted by an earlier test's render and the spy saw nothing. The
// spy must be installed at module scope, before any render in the file.
// ---------------------------------------------------------------------------
const consoleMessages: string[] = [];
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

/** Node emits process-level warnings (e.g. `(node:123) Warning: --localstorage-file
 *  ...`) through console.warn from the HARNESS, not from rendering. Those are the
 *  only thing filtered, and the pattern is deliberately narrow: anything React or
 *  the component logs still fails. A broad filter here would quietly recreate the
 *  false green this guard exists to prevent. */
const HARNESS_NOISE = /^\(node:\d+\) |^\(Use `node --trace-warnings/;
const record = (args: unknown[]) => {
  const text = String(args[0]);
  if (!HARNESS_NOISE.test(text)) consoleMessages.push(text);
};
console.error = (...args: unknown[]) => { record(args); };
console.warn = (...args: unknown[]) => { record(args); };

after(() => {
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
});

afterEach(() => {
  // Asserted per test so the failure names the state that produced it, rather
  // than one aggregate failure at the end of the file.
  const seen = consoleMessages.splice(0, consoleMessages.length);
  assert.deepEqual(seen, [], `React logged during render:\n${seen.join("\n")}`);
});

const originalApiGet = api.get;

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState({ current: null, servers: [], members: [] } as never);
});

type InviteInfo = Record<string, unknown>;

function renderZh(info: InviteInfo | { __status: number }) {
  api.get = (async () => {
    if ("__status" in info) {
      const err = new Error("http") as Error & { response?: { status: number } };
      err.response = { status: info.__status as number };
      throw err;
    }
    return { data: info };
  }) as typeof api.get;

  return render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter>
        <InviteAcceptPage
          token="invite-token"
          onInviteConsumed={() => {}}
          onSwitchToLogin={() => {}}
          onSwitchToRegister={() => {}}
        />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

const BASE: InviteInfo = {
  kind: "join_link",
  serverName: "回声工作区",
  inviterName: null,
  memberCount: 0,
  agentCount: 0,
  insideCountsHidden: false,
  humanSeatLimitReached: false,
  humanSeatLimitMessage: null,
  agreement: null,
};

test("a join link renders its Chinese invitation with the server name inside the sentence", async () => {
  renderZh({ ...BASE });

  assert.ok(await screen.findByText("加入此服务器"), "join-link title");
  const text = document.body.textContent ?? "";
  assert.ok(text.includes("使用此链接加入 Raft 上的 回声工作区。"), "server name placed by the zh translation");
  assert.ok(!text.includes("Use this link to join"), "no untranslated sentence");
});

test("a personal invite renders BOTH tag positions from the translation", async () => {
  // Two distinct tags in one sentence (<inviter> and <server>). If either were
  // left as JSX around a bare value, zh could not reorder them.
  renderZh({ ...BASE, kind: "invite", inviterName: "小明" });

  assert.ok(await screen.findByText("你收到了邀请"), "invite title");
  assert.ok(
    (document.body.textContent ?? "").includes("小明 邀请你加入 Raft 上的 回声工作区。"),
    "both inviter and server names placed by the zh translation",
  );
});

test("the inside-count sentence pluralizes and orders in Chinese, in all four shapes", async () => {
  // All four shapes, because each is a DIFFERENT message and only the shape
  // actually rendered proves anything. The singular cases matter most: English
  // needs "1 human", zh needs no plural distinction at all.
  const cases: Array<[InviteInfo, string]> = [
    [{ memberCount: 12, agentCount: 4 }, "认识里面的 12 位人类 和 4 个 Agent。"],
    [{ memberCount: 1, agentCount: 1 }, "认识里面的 1 位人类 和 1 个 Agent。"],
    [{ memberCount: 3, agentCount: 0 }, "认识里面的 3 位人类。"],
    [{ memberCount: 0, agentCount: 2 }, "认识里面的 2 个 Agent。"],
  ];
  for (const [info, expected] of cases) {
    renderZh({ ...BASE, ...info });
    await screen.findByText("加入此服务器");
    assert.ok(
      (document.body.textContent ?? "").includes(expected),
      `inside-count shape ${JSON.stringify(info)} should render: ${expected}`,
    );
    cleanup();
  }
});

test("hidden inside counts render the Chinese everyone sentence", async () => {
  renderZh({ ...BASE, memberCount: 12, agentCount: 4, insideCountsHidden: true });

  assert.ok(await screen.findByText("所有人"), "bolded everyone");
  const text = document.body.textContent ?? "";
  assert.ok(text.includes("认识里面的所有人。"), "everyone sentence");
  assert.ok(!/12|4 /.test(text.replace("回声工作区", "")), "hidden counts must not leak");
});

test("the human-seat-limit banner and the signed-out prompt render in Chinese", async () => {
  renderZh({ ...BASE, humanSeatLimitReached: true });
  await screen.findByText("加入此服务器");
  assert.ok(
    (document.body.textContent ?? "").includes("此服务器当前没有可用的人类席位。"),
    "seat-limit banner",
  );

  cleanup();
  renderZh({ ...BASE });
  await screen.findByText("加入此服务器");
  const text = document.body.textContent ?? "";
  // Signed out: the sign-in prompt and both auth buttons.
  assert.ok(text.includes("登录或创建账户以接受此邀请。"), "sign-in prompt");
  assert.ok(text.includes("创建账户"), "create-account button");
  assert.ok(!text.includes("Create Account"), "no untranslated button");
});

test("an expired link and a rate-limited response render distinct Chinese errors", async () => {
  // Two different HTTP statuses map to two different messages. A single error
  // test would let one silently collapse onto the other.
  renderZh({ __status: 404 });
  assert.ok(await screen.findByText("此邀请链接无效或已过期。"), "404 copy");

  cleanup();
  renderZh({ __status: 429 });
  assert.ok(await screen.findByText("尝试次数过多，请稍等一分钟后重试。"), "429 copy");
});

test("the inside-count messages keep their plural arms and movable tags", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  for (const id of ["pages.invite.insideBoth", "pages.invite.insideHumans"]) {
    assert.match(en[id], /\{humans, plural,/, `en ${id} must pluralize via ICU`);
    assert.match(zh[id], /\{humans, plural,/, `zh ${id} must pluralize via ICU`);
    assert.ok(!/\bone\s*\{/.test(zh[id]), `zh ${id} must not carry an English one-arm`);
  }
  assert.match(en["pages.invite.insideAgents"], /\{agents, plural,/, "en agents plural");

  // The tags must be movable, not decorative: zh places the server name at a
  // different offset than en does. Asserting mere presence would pass even if
  // the sentence were still assembled in English word order.
  for (const id of ["pages.invite.joinLinkDescription", "pages.invite.acceptedDescription"]) {
    assert.match(en[id], /<server><\/server>/, `en ${id} keeps the tag`);
    assert.match(zh[id], /<server><\/server>/, `zh ${id} keeps the tag`);
  }
  assert.notEqual(
    en["pages.invite.joinLinkDescription"].indexOf("<server>"),
    zh["pages.invite.joinLinkDescription"].indexOf("<server>"),
    "the whole point is that the two locales place it differently",
  );
  // Two DISTINCT tag names in one sentence — reusing one name for both would
  // render the inviter's markup around the server name.
  for (const cat of [en, zh]) {
    assert.match(cat["pages.invite.inviterDescription"], /<inviter><\/inviter>/);
    assert.match(cat["pages.invite.inviterDescription"], /<server><\/server>/);
  }
});

test("every id this batch added is translated", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;
  const ids = Object.keys(en).filter((k) => k.startsWith("pages.invite."));
  assert.equal(ids.length, 26);
  for (const id of ids) {
    assert.notEqual(zh[id], en[id], `${id} is still English`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }
  // Distinct states must stay distinct copy.
  assert.notEqual(zh["pages.invite.joinThisServer"], zh["pages.invite.youreInvited"]);
  assert.notEqual(zh["pages.invite.joiningServer"], zh["pages.invite.agreeAndJoin"]);
  assert.notEqual(zh["pages.invite.invalidOrExpired"], zh["pages.invite.tooManyAttempts"]);
});

test("switching locale re-renders the error WITHOUT refetching the invite", async () => {
  // The bug this pins: putting `formatMessage` in the fetch effect's dependency
  // array silences the exhaustive-deps warning and makes a LOCALE SWITCH REFETCH
  // the invite. Storing the message id in state and formatting at render avoids
  // both that and the opposite failure (text frozen in the old locale).
  //
  // I have caught this exact shape twice reviewing other people's i18n PRs, in
  // both directions, so it gets a tooth rather than a comment.
  let calls = 0;
  api.get = (async () => {
    calls += 1;
    const err = new Error("http") as Error & { response?: { status: number } };
    err.response = { status: 404 };
    throw err;
  }) as typeof api.get;

  const ui = (locale: "en" | "zh-cn") => (
    <TestIntlProvider locale={locale}>
      <MemoryRouter>
        <InviteAcceptPage
          token="invite-token"
          onInviteConsumed={() => {}}
          onSwitchToLogin={() => {}}
          onSwitchToRegister={() => {}}
        />
      </MemoryRouter>
    </TestIntlProvider>
  );

  const view = render(ui("zh-cn"));
  assert.ok(await screen.findByText("此邀请链接无效或已过期。"), "zh error");
  assert.equal(calls, 1, "one fetch");

  view.rerender(ui("en"));
  assert.ok(await screen.findByText("This invite link is invalid or has expired."), "error follows the locale");
  assert.equal(calls, 1, "a locale switch must NOT refetch the invite");
});

test("the accepted state renders in Chinese with the server name interpolated", async () => {
  // Reaching this state matters beyond its own copy: it is the ONLY place the
  // `accepted-server` rich chunk renders, so without mounting it the console
  // guard above cannot see that chunk at all. Removing its key was the one
  // mutation of four that stayed green before this test existed.
  useAuthStore.setState({
    user: { id: "u1", name: "u", displayName: "U" },
    initialized: true,
    acceptInvite: async () => ({ serverName: "回声工作区", serverId: "s1" }),
  } as never);
  useServerStore.setState({
    servers: [], current: null, members: [], loading: false,
    loadServers: async () => {},
  } as never);

  renderZh({
    ...BASE,
    agreement: { id: "a1", title: "使用条款", version: 3, bodyMarkdown: "内容" },
  });
  fireEvent.click(await screen.findByRole("button", { name: "同意并加入" }));

  assert.ok(await screen.findByText("加入成功"), "accepted title");
  const text = document.body.textContent ?? "";
  assert.ok(text.includes("你已加入 回声工作区。"), "server name placed by the zh translation");
  assert.ok(text.includes("进入 Raft"), "continue action");
  assert.ok(!text.includes("You've joined"), "no untranslated sentence");
});
