// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
// The runtime usage card, laid out from what it is read for (#oar-raft:3a3f8fc1, xxchan):
// - a healthy card has no action row and no "OK" chip: the account, its windows, its resets left and credits
//   (always in sight), and Refresh beside "Updated …";
// - Upgrade is a text link in the version line, and gone once it has an outcome (a failure offers Retry);
// - a limit reset is offered only once a window is nearly used up (a quiet button), and as the card's main
//   action, with why, once the account is limited;
// - Sign out sits in the Computer's own account's menu;
// - signed out, the card says what that stops and offers one full-width "Sign in to …";
// - no sentence repeats a tag (Kirby's copy pass): a reauth account has its tag and Sign in, a reset button no count.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RuntimeAccountUsageSnapshot, RuntimeAuthStatus } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import { RuntimeUsageSurface } from "../src/components/machine/RuntimeUsageSurface";
import type { SurfaceAuth, SurfaceLimitReset } from "../src/components/machine/RuntimeUsageSurface";
import { limitResetOffer } from "../src/components/machine/limitResetOffer";
import type { RuntimeUpgradeState } from "../src/features/computer/runtimeUpgradeOutcomeCopy";
import type { RuntimeAuthView } from "../src/utils/runtimeAuthClient";

afterEach(cleanup);

type Account = RuntimeAccountUsageSnapshot["accounts"][number];

const RESET = "2099-11-24T09:00:00.000Z";
const VIEW: RuntimeAuthView = {
  status: { collectedAt: "2026-11-19T03:00:00.000Z", runtimes: { codex: { kind: "logged_in" } } },
  availability: "ok",
  runtimes: ["codex"],
  logoutRuntimes: ["codex"],
  canAct: true,
  runtimeUpgrade: true,
  upgradableRuntimes: ["codex"],
};

function account(usedRatio: number, extra: Partial<Account> = {}): Account {
  return {
    accountKey: "c".repeat(64),
    planLabel: "pro",
    maskedLabel: "x*****n@botiverse.dev",
    health: usedRatio >= 1 ? "rate_limited" : "ok",
    windows: [{ id: "w_week", label: "Codex · 1 week", status: usedRatio >= 1 ? "limit_reached" : "ok", usedRatio, resetsAt: RESET }],
    limitResetsAvailable: 1,
    credits: { available: true, balance: "1240" },
    ...extra,
  };
}

function snapshot(accounts: Account[]): RuntimeAccountUsageSnapshot {
  return {
    protocolVersion: 2,
    provider: "codex",
    collectedAt: "2026-11-19T03:00:00.000Z",
    staleAfter: "2099-11-19T03:30:00.000Z",
    collectorVersion: "test",
    accounts,
  };
}

function card(options: {
  accounts?: Account[];
  status?: RuntimeAuthStatus;
  upgrade?: RuntimeUpgradeState;
  limitReset?: SurfaceLimitReset | null;
  onSignOut?: () => void;
  onUpgrade?: () => void;
  /** No usage to read: the card is the sign-in alone. */
  noUsage?: boolean;
  locale?: "en" | "zh-cn";
  canAct?: boolean;
} = {}) {
  const auth: SurfaceAuth = {
    runtime: "codex",
    status: options.status ?? { kind: "logged_in" },
    view: options.canAct === false ? { ...VIEW, canAct: false } : VIEW,
    onSignIn: () => {},
    onSignOut: options.onSignOut ?? (() => {}),
    onConnectProvider: () => {},
    onSignOutProvider: () => {},
    upgrade: { state: options.upgrade ?? { kind: "idle" }, onUpgrade: options.onUpgrade ?? (() => {}) },
    update: null,
  };
  render(
    <TestIntlProvider locale={options.locale}>
      <RuntimeUsageSurface
        runtimeId="codex"
        runtimeVersion="0.170.0"
        provider={options.noUsage ? null : "codex"}
        result={options.noUsage ? null : { state: "fresh", snapshot: snapshot(options.accounts ?? [account(0.56)]) }}
        loading={false}
        loadError={false}
        refreshState="idle"
        cooldownLeftMs={0}
        onRefresh={() => {}}
        auth={auth}
        runtimeName="Codex CLI"
        limitReset={options.limitReset ?? null}
        note={null}
      />
    </TestIntlProvider>,
  );
}

test("a healthy card: no action row, no OK chip, resets left and credits always shown, Refresh beside Updated", () => {
  card();
  assert.equal(screen.queryByTestId("runtime-usage-actions") === null, true, "no action row");
  assert.equal(screen.queryByTestId("runtime-account-health") === null, true, "a healthy account needs no word");
  assert.equal(screen.getByTestId("runtime-account-limit-resets").textContent, "1 reset left");
  assert.equal(screen.getByTestId("runtime-account-credits").textContent, "1,240 credits");
  // One line of secondary text, not two chips that look pressable (Kirby).
  assert.equal(screen.getByTestId("runtime-account-facts").textContent, "1 reset left · 1,240 credits");
  assert.equal(screen.queryByTestId("runtime-limit-reset-action") === null, true);
  assert.equal(screen.queryByText("Sign out") === null, true, "Sign out is not a button on the card");
  assert.ok(screen.getByTestId("runtime-usage-refresh").parentElement?.textContent?.includes("Updated"));
  assert.ok(screen.getAllByRole("meter")[0]?.textContent?.startsWith("Week"), "a known window in the reader's language");
});

test("a reset is offered only once a window is nearly used up, and leads once the account is limited", () => {
  assert.equal(limitResetOffer(account(0.56)), null, "56% with days to go: no button");
  assert.deepEqual(limitResetOffer(account(0.85)), { primary: false });
  assert.deepEqual(limitResetOffer(account(1)), { primary: true });
  // Only a model's own window used up (Codex's Spark): the account is not limited, so a quiet button.
  const spark = { id: "w_spark", label: "GPT-5.3-Codex-Spark · 1 week", status: "limit_reached" as const, usedRatio: 1, resetsAt: RESET, scope: { kind: "model" as const, name: "GPT-5.3-Codex-Spark" } };
  assert.deepEqual(limitResetOffer(account(0.3, { health: "rate_limited", windows: [account(0.3).windows[0]!, spark] })), { primary: false });

  card({ accounts: [account(0.85)], limitReset: { primary: false, onUse: () => {} } });
  // No count on the button: the facts line above already says "1 reset left".
  assert.equal(screen.getByTestId("runtime-limit-reset-action").textContent, "Use a reset");
  assert.equal(screen.getByTestId("runtime-account-limit-resets").textContent, "1 reset left");
  assert.equal(screen.queryByTestId("runtime-limit-callout") === null, true);
  cleanup();

  card({ accounts: [account(1)], limitReset: { primary: true, onUse: () => {} } });
  // No banner: the "used up" tag already says the limit is used up (xxchan: a sentence
  // restating it is noise). The reset is the card's one primary action.
  assert.equal(screen.queryByTestId("runtime-limit-callout") === null, true);
  assert.equal(screen.getByTestId("runtime-limit-reset-action").hasAttribute("data-primary-action"), true);
  assert.equal(screen.getByTestId("runtime-limit-reset-action").hasAttribute("data-primary-action"), true);
  assert.equal(screen.getByTestId("runtime-account-health").textContent, "used up");
});

test("Sign out sits in the account's menu", async () => {
  let signedOut = 0;
  card({ onSignOut: () => { signedOut += 1; } });
  fireEvent.click(screen.getByTestId("runtime-account-menu"));
  fireEvent.click(await screen.findByTestId("runtime-auth-sign-out"));
  assert.equal(signedOut, 1);
});

test("Upgrade is a link in the version line, and gone once it has an outcome", () => {
  card();
  const link = screen.getByTestId("runtime-upgrade-action");
  assert.equal(link.tagName, "SPAN", "a text link in the sentence, not a button");
  assert.equal(link.parentElement?.textContent, "0.170.0Upgrade");
  cleanup();

  // With no update check reported (an older Computer), a press that upgraded used to leave the button: no more.
  card({ upgrade: { kind: "done", result: { kind: "upgraded", from: "0.162.0", to: "0.170.0" } } });
  assert.equal(screen.queryByTestId("runtime-upgrade-action") === null, true);
  assert.equal(screen.getByTestId("runtime-upgrade-outcome").textContent, "Upgraded Codex CLI from 0.162.0 to 0.170.0.");
  cleanup();

  card({ upgrade: { kind: "done", result: { kind: "current", version: "0.170.0" } } });
  assert.equal(screen.queryByTestId("runtime-upgrade-action") === null, true);
  cleanup();

  // A failure another press may fix brings Upgrade back beside the outcome (said once, not "Try again. Try again").
  let pressed = 0;
  card({ upgrade: { kind: "refused", reason: "failed" }, onUpgrade: () => { pressed += 1; } });
  assert.equal(screen.getByTestId("runtime-upgrade-outcome").textContent, "Couldn't upgrade Codex CLI. Try again.");
  assert.equal(screen.getByTestId("runtime-upgrade-action").textContent, "Upgrade");
  fireEvent.click(screen.getByTestId("runtime-upgrade-action"));
  assert.equal(pressed, 1);
  cleanup();

  card({ upgrade: { kind: "refused", reason: "computer_offline" } });
  assert.equal(screen.queryByTestId("runtime-upgrade-action") === null, false, "back online, it can be pressed again");
  cleanup();

  // Timed out: it may still finish there, so no second press is offered.
  card({ upgrade: { kind: "refused", reason: "computer_timeout" } });
  assert.equal(screen.queryByTestId("runtime-upgrade-action") === null, true);
  cleanup();

  // Running: the same link, busy, so focus stays on it.
  let pressedWhileRunning = 0;
  card({ upgrade: { kind: "running" }, onUpgrade: () => { pressedWhileRunning += 1; } });
  const busy = screen.getByTestId("runtime-upgrade-action");
  assert.equal(busy.getAttribute("aria-disabled"), "true");
  assert.equal(busy.textContent, "Upgrading…");
  fireEvent.click(busy);
  assert.equal(pressedWhileRunning, 0);
});

test("a used-up account still running on credits is not told its agents wait", () => {
  card({ accounts: [account(1, { health: "ok" })], limitReset: { primary: true, onUse: () => {}, onCredits: true } });
  const banner = screen.getByTestId("runtime-limit-callout");
  assert.equal(banner.getAttribute("data-slot"), "banner", "the DS Banner, not a hand-made box");
  assert.ok(banner.contains(screen.getByTestId("runtime-limit-reset-action")), "the reset is the banner's action");
  const callout = banner.textContent ?? "";
  assert.match(callout, /A reset stops it spending credits\./);
  assert.doesNotMatch(callout, /wait/);
});

test("with no own account drawn (nothing read yet), Sign out and the reset stay reachable under the usage", () => {
  card({ accounts: [account(0.56, { agentIds: ["a1"] })], limitReset: { primary: false, onUse: () => {} } });
  assert.equal(screen.queryByTestId("runtime-account-menu") === null, true);
  const actions = screen.getByTestId("runtime-usage-actions");
  assert.ok(actions.textContent?.includes("Sign out"));
  assert.ok(actions.textContent?.includes("Use a reset"));
  assert.doesNotMatch(actions.textContent ?? "", /left/);
});

test("signed out: the Not signed in tag and one full-width Sign in, no sentence repeating them (xxchan, #oar-raft msg=4fb971ed)", () => {
  card({ status: { kind: "logged_out" } });
  assert.equal(screen.queryByTestId("runtime-auth-signed-out-impact") === null, true);
  assert.equal(screen.getByTestId("runtime-auth-sign-in").textContent, "Sign in to Codex CLI");
  assert.equal(screen.queryByRole("meter") === null, true, "no empty usage block");
  // "Not signed in" ends the title line, so the version line stays the second line (Kirby).
  assert.ok(screen.getByTestId("runtime-usage-title").parentElement?.contains(screen.getByTestId("runtime-auth-logged-out")));
});

test("no credits left reads orange in the facts line", () => {
  card({ accounts: [account(0.56, { credits: { available: false } })] });
  const credits = screen.getByTestId("runtime-account-credits");
  assert.equal(credits.classList.contains("text-warning-strong"), true);
  assert.equal(screen.getByTestId("runtime-account-limit-resets").classList.contains("text-warning-strong"), false);
});

test("a card with no usage shows the signed-in account under the title or the Signed in chip on the title line, never both", () => {
  card({ noUsage: true, status: { kind: "logged_in", account: { maskedLabel: "x*****n@botiverse.dev", planLabel: "pro" } } });
  assert.equal(screen.getByTestId("runtime-auth-account").textContent, "x*****n@botiverse.dev · Pro");
  assert.equal(screen.queryByTestId("runtime-auth-logged-in") === null, true);
  cleanup();

  card({ noUsage: true, status: { kind: "logged_in" } });
  assert.equal(screen.queryByTestId("runtime-auth-account") === null, true);
  assert.ok(screen.getByTestId("runtime-usage-title").parentElement?.contains(screen.getByTestId("runtime-auth-logged-in")));
});

test("subscription plan reads as a plan in en and zh-cn, normalising known lowercase tiers and keeping branded names (#oar-raft:#44)", () => {
  card({ accounts: [account(0.56, { planLabel: "team" })] });
  assert.equal(screen.getByTestId("runtime-account-plan").textContent, "Team plan");
  cleanup();

  card({ locale: "zh-cn", accounts: [account(0.56, { planLabel: "team" })] });
  assert.equal(screen.getByTestId("runtime-account-plan").textContent, "Team 套餐");
  cleanup();

  card({ accounts: [account(0.56, { planLabel: "max" })] });
  assert.equal(screen.getByTestId("runtime-account-plan").textContent, "Max plan");
  cleanup();

  card({ accounts: [account(0.56, { planLabel: "SuperGrok" })] });
  assert.equal(screen.getByTestId("runtime-account-plan").textContent, "SuperGrok plan");
  cleanup();

  card({ accounts: [account(0.56, { planLabel: "Plan a" })] });
  assert.equal(screen.getByTestId("runtime-account-plan").textContent, "Plan a");
  cleanup();

  card({ locale: "zh-cn", accounts: [account(0.56, { planLabel: "Team 套餐" })] });
  assert.equal(screen.getByTestId("runtime-account-plan").textContent, "Team 套餐");
  cleanup();

  card({ accounts: [account(0.56, { planLabel: "constructor" })] });
  assert.equal(screen.getByTestId("runtime-account-plan").textContent, "constructor plan");
  cleanup();

  card({ accounts: [account(0.56, { planLabel: "   " })] });
  assert.equal(screen.getByTestId("runtime-account-plan").textContent, "Runtime account");
  cleanup();

  card({ accounts: [account(0.56, { planLabel: undefined })] });
  assert.equal(screen.getByTestId("runtime-account-plan").textContent, "Runtime account");
});

test("one model group used up while the account runs others: a warning chip, not a healthy card (#oar-raft bf7c6b31)", () => {
  const gemini = { id: "w_gem5h", label: "Gemini Models · 5 hours", status: "limit_reached" as const, usedRatio: 1, resetsAt: RESET, scope: { kind: "models" as const, name: "Gemini Models" } };
  const claudeGpt = { id: "w_cg5h", label: "Claude and GPT models · 5 hours", status: "ok" as const, usedRatio: 0.2, resetsAt: RESET, scope: { kind: "models" as const, name: "Claude and GPT models" } };
  card({ accounts: [account(0.2, { health: "ok", windows: [gemini, claudeGpt], credits: undefined, limitResetsAvailable: undefined })] });
  assert.equal(screen.getByTestId("runtime-account-health").textContent, "some models used up");
  cleanup();

  // Every group has room: no chip.
  card({ accounts: [account(0.2, { health: "ok", windows: [{ ...gemini, status: "ok", usedRatio: 0.5 }, claudeGpt], credits: undefined, limitResetsAvailable: undefined })] });
  assert.equal(screen.queryByTestId("runtime-account-health") === null, true);
  cleanup();

  // The whole account rate limited keeps its own word.
  card({ accounts: [account(1, { windows: [gemini, { ...claudeGpt, status: "limit_reached", usedRatio: 1 }], credits: undefined, limitResetsAvailable: undefined })] });
  assert.equal(screen.getByTestId("runtime-account-health").textContent, "used up");
});

test("every model group used up while OAR says not rate limited: maybe on credits while credits are not reported", () => {
  const gemini = { id: "w_gem5h", label: "Gemini Models · 5 hours", status: "limit_reached" as const, usedRatio: 1, resetsAt: RESET, scope: { kind: "models" as const, name: "Gemini Models" } };
  const claudeGpt = { id: "w_cgwk", label: "Claude and GPT models · week", status: "limit_reached" as const, usedRatio: 1, resetsAt: RESET, scope: { kind: "models" as const, name: "Claude and GPT models" } };
  const claudeGpt5h = { ...claudeGpt, id: "w_cg5h", label: "Claude and GPT models · 5 hours", status: "ok" as const, usedRatio: 0.3 };
  card({ accounts: [account(1, { health: "ok", windows: [gemini, claudeGpt5h, claudeGpt], credits: undefined, limitResetsAvailable: undefined })] });
  assert.equal(screen.getByTestId("runtime-account-health").textContent, "may be on credits", "a group with one window used up counts as used up");
  cleanup();

  // Credits reported: each row says it runs on credits (as Codex's), no chip.
  card({ accounts: [account(1, { health: "ok", windows: [gemini, claudeGpt], credits: { available: true, balance: "300" }, limitResetsAvailable: undefined })] });
  assert.equal(screen.queryByTestId("runtime-account-health") === null, true);
  cleanup();

  // Credits reported as none: used up, whatever OAR's flag says.
  card({ accounts: [account(1, { health: "ok", windows: [gemini, claudeGpt], credits: { available: false }, limitResetsAvailable: undefined })] });
  assert.equal(screen.getByTestId("runtime-account-health").textContent, "used up");
});

// DeepSeek Harness: a status-only runtime (no sign-in in OAR, `runtimeAuthStatusOnly`). Its card says how
// its key is set, to every viewer, and never offers Sign in; a missing dsh gets its install line.
function dshCard(status: RuntimeAuthStatus, canAct = true) {
  const view: RuntimeAuthView = {
    status: { collectedAt: "2026-11-19T03:00:00.000Z", runtimes: { dsh: status } },
    availability: "ok",
    runtimes: ["claude", "codex", "kimi", "qoder"],
    logoutRuntimes: [],
    canAct,
  };
  render(
    <TestIntlProvider>
      <RuntimeUsageSurface
        runtimeId="dsh"
        runtimeVersion="0.2.2-rc.1"
        provider={null}
        result={null}
        loading={false}
        loadError={false}
        refreshState="idle"
        cooldownLeftMs={0}
        onRefresh={() => {}}
        auth={{ runtime: "dsh", status, view, onSignIn: () => {}, onSignOut: () => {}, onConnectProvider: () => {}, onSignOutProvider: () => {}, upgrade: null, update: null }}
        runtimeName="DeepSeek Harness"
        limitReset={null}
        note={null}
      />
    </TestIntlProvider>,
  );
}

test("DeepSeek Harness: an installed dsh (status unknown) shows how its key is set and no Sign in, also to a viewer who cannot act", () => {
  for (const canAct of [true, false]) {
    dshCard({ kind: "unknown" }, canAct);
    assert.match(screen.getByTestId("runtime-auth-credentials-note").textContent ?? "", /DEEPSEEK_API_KEY.*mode 600|mode 600.*DEEPSEEK_API_KEY/, String(canAct));
    assert.equal(screen.queryByRole("button", { name: /Sign in/ }) === null, true, `no Sign in (canAct ${canAct})`);
    assert.equal(screen.queryByTestId("runtime-auth-unavailable") === null, true, "never \"upgrade this Computer to sign in\"");
    cleanup();
  }
});

test("DeepSeek Harness: not installed shows its npm install line, not the credentials note", () => {
  dshCard({ kind: "unavailable", reason: "not_installed" });
  assert.ok(screen.getByTestId("runtime-auth-install-line").textContent?.includes("npm install -g @deepseek-ai/dsh"));
  assert.equal(screen.queryByTestId("runtime-auth-credentials-note") === null, true);
  assert.equal(screen.queryByRole("button", { name: /Sign in/ }) === null, true);
});

test("reauth: the tag and Sign in under the account, no sentence repeating the tag and no last-known meters (Kirby)", () => {
  const reauth = account(0.56, { health: "reauth_required" });
  card({ accounts: [reauth] });
  assert.equal(screen.getByTestId("runtime-account-health").textContent, "sign in again");
  const block = screen.getByTestId("runtime-account-plan").closest(".px-4");
  // The facts line is the account's only line of text.
  assert.deepEqual([...(block?.querySelectorAll("p") ?? [])].map((p) => p.getAttribute("data-testid")), ["runtime-account-facts"]);
  assert.equal(screen.queryByRole("meter") === null, true);
  const signIn = screen.getByTestId("runtime-auth-sign-in");
  assert.equal(signIn.textContent, "Sign in to Codex CLI");
  assert.ok(block?.contains(signIn), "under the Computer's own account");
  cleanup();

  // A viewer who may not act reads the tag alone.
  card({ accounts: [reauth], canAct: false });
  assert.equal(screen.getByTestId("runtime-account-health").textContent, "sign in again");
  assert.equal(screen.queryByTestId("runtime-auth-sign-in") === null, true);
  cleanup();

  // An account that could not be read: its "error" tag says it, no sentence under it.
  card({ accounts: [account(0.56, { health: "error" })] });
  assert.equal(screen.getByTestId("runtime-account-health").textContent, "error");
  assert.equal(screen.queryByText("Couldn't read usage.") === null, true);
});
