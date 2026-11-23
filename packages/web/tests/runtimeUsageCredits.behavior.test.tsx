// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { createIntl } from "react-intl";
import type { RuntimeAccountUsageSnapshot } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import { DEFAULT_LOCALE } from "../src/i18n/locale";
import { mergedMessages } from "../src/i18n/messages";
import { summarizeRuntimeUsage } from "../src/components/machine/bulkChangeModelPlan";
import { rackRuntimeCell } from "../src/components/machine/rack/rackRuntimeColumns";
import { runtimeUsageText, runtimeUsageWindowsLine } from "../src/components/machine/runtimeUsageText";
import { usageAccountNeedsAttention, usageCreditsText, usageOnCredits } from "../src/components/machine/runtimeUsageCredits";
import { RuntimeUsageContents } from "../src/components/machine/RuntimeUsageSurface";
import { RuntimeUsageWindowList } from "../src/components/machine/RuntimeUsageWindowList";
import { RUNTIME_USAGE_REQUEST_HEADERS } from "../src/utils/runtimeAccountUsageClient";
import type { Machine } from "../src/store/machineStore";

// A Codex account whose weekly limit is used up but which still has credits
// keeps working, spending them: the web says it runs on credits, never "Used
// up" / "Back in …" / "limit reached". Without credits (absent, or none
// left) a used-up window reads as before.

afterEach(cleanup);

type Account = RuntimeAccountUsageSnapshot["accounts"][number];

const RESET = "2099-11-18T09:09:00.000Z";
const week = { id: "w_week", label: "Codex · 1 week", status: "limit_reached" as const, usedRatio: 1, resetsAt: RESET };
const fiveHours = { id: "w_5h", label: "Codex · 5 hours", status: "ok" as const, usedRatio: 0.2 };

function snapshotOf(credits?: Account["credits"]): RuntimeAccountUsageSnapshot {
  return {
    protocolVersion: 2,
    provider: "codex",
    collectedAt: "2026-11-18T09:00:00.000Z",
    staleAfter: "2099-11-18T09:30:00.000Z",
    collectorVersion: "test",
    accounts: [{
      accountKey: "c".repeat(64),
      planLabel: "Plus",
      health: credits?.available ? "ok" : "rate_limited",
      windows: [fiveHours, week],
      ...(credits ? { credits } : {}),
    }],
  };
}

const ON_CREDITS = { available: true, balance: "30784" };
const intl = createIntl({ locale: "en", defaultLocale: DEFAULT_LOCALE, messages: mergedMessages("en") });
const machine = { id: "m1", runtimes: ["codex"] } as unknown as Machine;

test("usage requests declare that this build reads an account's credits", () => {
  assert.match(Object.values(RUNTIME_USAGE_REQUEST_HEADERS).join(","), /runtime-usage-credits@1/);
});

test("an account runs on credits only when they say they can be spent", () => {
  assert.equal(usageOnCredits({ credits: ON_CREDITS }), true);
  assert.equal(usageOnCredits({ credits: { available: false, balance: "0" } }), false);
  assert.equal(usageOnCredits({}), false);
  assert.equal(usageOnCredits(null), false);
});

test("the runtime chip's warning: none for a full window on credits; still for no credits or an unreadable window", () => {
  const account = (credits?: Account["credits"]) => snapshotOf(credits).accounts[0]!;
  assert.equal(usageAccountNeedsAttention(account(ON_CREDITS)), false);
  assert.equal(usageAccountNeedsAttention(account()), true);
  assert.equal(usageAccountNeedsAttention(account({ available: false, balance: "0" })), true);
  const unreadable = account(ON_CREDITS);
  assert.equal(usageAccountNeedsAttention({ ...unreadable, windows: [...unreadable.windows, { id: "w_x", label: "Other", status: "parse_unavailable" }] }), true);
});

test("the credits beside the account: a formatted balance, unlimited, none; nothing when unknown", () => {
  const text = (credits: Account["credits"]) => usageCreditsText(credits, intl.formatMessage);
  assert.equal(text(ON_CREDITS), "30,784 credits");
  assert.equal(text({ available: true, balance: "1" }), "1 credit");
  assert.equal(text({ available: true, balance: "12.5" }), "12.5 credits");
  assert.equal(text({ available: true, balance: "0.0004" }), "0.0004 credits", "a fraction is never rounded away");
  assert.equal(text({ available: true, balance: "12345678901234567890" }), "12345678901234567890 credits", "past 15 digits a whole balance is shown as written");
  assert.equal(text({ available: true, balance: "1,234.5" }), "1,234.5 credits", "a balance that is not a plain number is shown as written");
  assert.equal(text({ available: true, unlimited: true }), "Unlimited credits");
  assert.equal(text({ available: true }), "Credits available");
  assert.equal(text({ available: false, balance: "0" }), "No credits left");
  assert.equal(text(undefined), null);
});

test("weekly window used up, credits left: the summary, picker line and compact line say it runs on credits", () => {
  const snapshot = snapshotOf(ON_CREDITS);
  const summary = summarizeRuntimeUsage(snapshot);
  assert.deepEqual(summary, { kind: "credits", plan: "Plus", resetsAt: RESET });
  assert.equal(runtimeUsageText(summary, intl.formatMessage, "en"), "Plus · Using credits");
  const line = runtimeUsageWindowsLine(snapshot, intl.formatMessage, "en");
  assert.deepEqual(line?.windows, [
    { text: "5h 20% used", limitReached: false },
    { text: "Week on credits", limitReached: false },
  ]);
});

test("weekly window used up, credits left: the rack cell is a full bar, not used up, \"On credits\"", () => {
  const cell = rackRuntimeCell(machine, "codex", { codex: { state: "fresh", snapshot: snapshotOf(ON_CREDITS) } });
  assert.equal(cell.kind, "value");
  if (cell.kind !== "value") return;
  assert.equal(cell.used, 100);
  assert.equal(cell.usedUp, false);
  assert.equal(cell.summary.kind, "credits");
});

for (const [name, credits] of [["unknown credits", undefined], ["no credits left", { available: false, balance: "0" }]] as const) {
  test(`weekly window used up, ${name}: used up, as before`, () => {
    const snapshot = snapshotOf(credits);
    const summary = summarizeRuntimeUsage(snapshot);
    assert.deepEqual(summary, { kind: "limit", plan: "Plus", resetsAt: RESET });
    assert.match(runtimeUsageText(summary, intl.formatMessage, "en") ?? "", /^Plus · Used up · resets /);
    const line = runtimeUsageWindowsLine(snapshot, intl.formatMessage, "en");
    assert.equal(line?.windows[1]?.limitReached, true);
    assert.match(line?.windows[1]?.text ?? "", /^Week used up · resets /);
    const cell = rackRuntimeCell(machine, "codex", { codex: { state: "fresh", snapshot } });
    assert.equal(cell.kind === "value" ? cell.usedUp : null, true);
  });
}

test("the usage card shows the credits beside the account and a used-up window that runs on credits", () => {
  render(
    <TestIntlProvider>
      <RuntimeUsageContents result={{ state: "fresh", snapshot: snapshotOf(ON_CREDITS) }} loading={false} loadError={false} />
    </TestIntlProvider>,
  );
  assert.equal(screen.getByTestId("runtime-account-credits").textContent, "30,784 credits");
  const meter = screen.getAllByRole("meter").find((node) => node.textContent?.startsWith("Week"));
  assert.match(meter?.getAttribute("aria-valuetext") ?? "", /^Used up · using credits · resets /);
});

test("the usage card without credits: no credits line, the window reads used up", () => {
  render(
    <TestIntlProvider>
      <RuntimeUsageContents result={{ state: "fresh", snapshot: snapshotOf() }} loading={false} loadError={false} />
    </TestIntlProvider>,
  );
  assert.equal(screen.queryByTestId("runtime-account-credits") === null, true);
  const meter = screen.getAllByRole("meter").find((node) => node.textContent?.startsWith("Week"));
  assert.match(meter?.getAttribute("aria-valuetext") ?? "", /^Used up · resets /);
});

test("the agent's usage row says a used-up window runs on credits", () => {
  render(
    <TestIntlProvider>
      <RuntimeUsageWindowList windows={[{ ...week, onCredits: true }, week]} />
    </TestIntlProvider>,
  );
  const [onCredits, usedUp] = screen.getAllByRole("meter");
  assert.match(onCredits?.getAttribute("aria-valuetext") ?? "", /^Used up · using credits · resets /);
  assert.match(usedUp?.getAttribute("aria-valuetext") ?? "", /^Used up · resets /);
});
