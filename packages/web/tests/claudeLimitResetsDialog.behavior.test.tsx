// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RuntimeAccountUsageSnapshot, RuntimeLimitResetsReadResult } from "@botiverse/raft-shared";
import { RuntimeUsageSurface } from "../src/components/machine/RuntimeUsageSurface";
import type { SurfaceClaudeLimitReset } from "../src/components/machine/RuntimeUsageSurface";
import { ClaudeLimitResetsDialog } from "../src/features/computer/ClaudeLimitResetsDialog";
import type { ClaudeLimitResetAvailable } from "../src/features/computer/claudeLimitResetCopy";
import type { RuntimeAuthClient } from "../src/utils/runtimeAuthClient";
import { renderWithIntl, TestIntlProvider } from "./helpers/intl";

// "Use a limit reset" goes as Claude Code's own `/limit-reset` (artin): it reads
// at once, asking no one first (#proj-raft-computer:4e327d5c): someone who may
// use a reset reads with consent at the 5-hour limit, and below it reads again
// with consent when the Computer says the account is at the limit after all. A
// viewer who may not use resets never sends consent: a read with it can spend
// the connecting person's 5-hour reset. Then one usable kind goes straight to
// its confirm, several to "Which reset do you want to use?", and a read on
// Claude's older program that used the 5-hour reset ends with Claude Code's line.
const READ: RuntimeLimitResetsReadResult = { kind: "read", resets: [{ kind: "five_hour", state: "none" }] };
const CONSENT_REQUIRED: RuntimeLimitResetsReadResult = { kind: "unsupported", reason: "consent_required" };
const WEEKLY = { kind: "weekly", state: "available", resetsLeft: 1, expiresText: "Nov 26, 4:59pm" } as const;
const FABLE = { kind: "fable", state: "available", resetsLeft: 3 } as const;

function clientAnswering(answers: (consent: boolean) => RuntimeLimitResetsReadResult) {
  const sent: boolean[] = [];
  const client = {
    readLimitResets: async (_serverId: string, _machineId: string, consent: boolean) => {
      sent.push(consent);
      return answers(consent);
    },
  } as unknown as RuntimeAuthClient;
  return { client, sent };
}

function open(
  client: RuntimeAuthClient,
  opts: { atFiveHourLimit: boolean; canUse: boolean },
  on: { onUse?: (status: ClaudeLimitResetAvailable, atLimit: boolean) => void; onNote?: (note: string, usageChanged: boolean) => void } = {},
) {
  return renderWithIntl(
    <StrictMode>
      <ClaudeLimitResetsDialog serverId="s" machineId="m" client={client} onUse={on.onUse ?? (() => {})} onNote={on.onNote ?? (() => {})} onClose={() => {}} {...opts} />
    </StrictMode>,
  );
}

afterEach(cleanup);

test("at the 5-hour limit, someone who may use a reset reads once, with consent, unasked", async () => {
  const { client, sent } = clientAnswering(() => READ);
  open(client, { atFiveHourLimit: true, canUse: true });
  await waitFor(() => assert.deepEqual(sent, [true]));
});

test("below the limit the read carries no consent; a consent_required answer gets one more read with it", async () => {
  const { client, sent } = clientAnswering((consent) => (consent ? READ : CONSENT_REQUIRED));
  open(client, { atFiveHourLimit: false, canUse: true });
  await waitFor(() => assert.deepEqual(sent, [false, true]));
});

test("a viewer who may not use resets never sends consent", async () => {
  const below = clientAnswering(() => CONSENT_REQUIRED);
  open(below.client, { atFiveHourLimit: false, canUse: false });
  await waitFor(() => assert.deepEqual(below.sent, [false]));
  cleanup();
  const atLimit = clientAnswering(() => READ);
  open(atLimit.client, { atFiveHourLimit: true, canUse: false });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(atLimit.sent, []);
});

test("while reading it says \"This takes a moment\"", async () => {
  const client = { readLimitResets: () => new Promise(() => {}) } as unknown as RuntimeAuthClient;
  open(client, { atFiveHourLimit: false, canUse: true });
  await screen.findByText("This takes a moment");
});

test("one usable kind skips the list and goes straight to its confirm", async () => {
  const used: string[] = [];
  const { client } = clientAnswering(() => ({ kind: "read", resets: [{ kind: "five_hour", state: "none" }, WEEKLY, { kind: "full", state: "none" }] }));
  open(client, { atFiveHourLimit: false, canUse: true }, { onUse: (status) => used.push(status.kind) });
  await waitFor(() => assert.deepEqual(used, ["weekly"]));
  assert.equal(screen.queryAllByRole("radio").length, 0);
});

test("at the 5-hour limit only the 5-hour reset counts: it alone goes to the confirm", async () => {
  const used: string[] = [];
  const { client } = clientAnswering(() => ({ kind: "read", resets: [{ kind: "five_hour", state: "available", resetsLeft: 2 }, WEEKLY, FABLE] }));
  open(client, { atFiveHourLimit: true, canUse: true }, { onUse: (status) => used.push(status.kind) });
  await waitFor(() => assert.deepEqual(used, ["five_hour"]));
});

test("a read that needed consent (stale card usage) is treated as at the limit: only the 5-hour reset, and the confirm knows", async () => {
  const used: [string, boolean][] = [];
  const { client, sent } = clientAnswering((consent) => (consent
    ? { kind: "read", resets: [{ kind: "five_hour", state: "available", resetsLeft: 1 }, WEEKLY, FABLE] }
    : CONSENT_REQUIRED));
  open(client, { atFiveHourLimit: false, canUse: true }, { onUse: (status, atLimit) => used.push([status.kind, atLimit]) });
  await waitFor(() => assert.deepEqual(used, [["five_hour", true]]));
  assert.deepEqual(sent, [false, true]);
});

test("on Claude's older program, a 5-hour state the read could not show is never \"nothing was used\"", async () => {
  const notes: [string, boolean][] = [];
  const { client } = clientAnswering(() => ({ kind: "read", program: "legacy", resets: [{ kind: "five_hour", state: "unknown" }] }));
  open(client, { atFiveHourLimit: true, canUse: true }, { onNote: (note, usageChanged) => notes.push([note, usageChanged]) });
  await waitFor(() => assert.deepEqual(notes, [["Couldn't confirm whether the 5-hour reset was used · check /usage in Claude Code", true]]));
});

test("at the limit with the 5-hour state unread, it never claims there is no 5-hour reset", async () => {
  const notes: string[] = [];
  const { client } = clientAnswering(() => ({ kind: "read", resets: [{ kind: "five_hour", state: "unknown" }, WEEKLY] }));
  open(client, { atFiveHourLimit: true, canUse: true }, { onNote: (note) => notes.push(note) });
  await waitFor(() => assert.deepEqual(notes, ["Couldn't read your resets · try again in a moment"]));
});

test("several usable kinds are offered under \"Which reset do you want to use?\" in Claude Code's words; the chosen one goes to the confirm", async () => {
  const used: string[] = [];
  const { client } = clientAnswering(() => ({ kind: "read", resets: [{ kind: "five_hour", state: "none" }, WEEKLY, FABLE, { kind: "full", state: "none" }] }));
  open(client, { atFiveHourLimit: false, canUse: true }, { onUse: (status) => used.push(status.kind) });
  await screen.findByText("Which reset do you want to use?");
  assert.equal(screen.getAllByRole("radio").length, 2);
  screen.getByText("Use a weekly reset");
  screen.getByText("1 left · until Nov 26, 4:59pm");
  screen.getByText("Use a Fable reset");
  assert.deepEqual(used, []);
  fireEvent.click(screen.getByText("Use a Fable reset"));
  fireEvent.click(screen.getByRole("button", { name: "Use this reset" }));
  await waitFor(() => assert.deepEqual(used, ["fable"]));
});

test("on Claude's older program a read that used the 5-hour reset ends with Claude Code's success line and a usage read", async () => {
  const notes: [string, boolean][] = [];
  const { client } = clientAnswering(() => ({ kind: "read", program: "legacy", fiveHourSpent: true, resets: [{ kind: "five_hour", state: "none" }] }));
  open(client, { atFiveHourLimit: true, canUse: true }, { onNote: (note, usageChanged) => notes.push([note, usageChanged]) });
  await waitFor(() => assert.deepEqual(notes, [["5-hour limit reset · your weekly limit still applies", true]]));
});

test("on Claude's older program with this week's reset gone, nothing is used and the line says so", async () => {
  const notes: string[] = [];
  const { client } = clientAnswering(() => ({ kind: "read", program: "legacy", resets: [{ kind: "five_hour", state: "none" }] }));
  open(client, { atFiveHourLimit: true, canUse: true }, { onNote: (note) => notes.push(note) });
  await waitFor(() => assert.deepEqual(notes, ["Weekly reset already used · nothing was used"]));
});

test("no usable kind ends with a line; at the 5-hour limit it says where the other kinds are", async () => {
  const notes: string[] = [];
  const none = clientAnswering(() => ({ kind: "read", resets: [{ kind: "five_hour", state: "none" }, { kind: "weekly", state: "none" }] }));
  open(none.client, { atFiveHourLimit: false, canUse: true }, { onNote: (note) => notes.push(note) });
  await waitFor(() => assert.deepEqual(notes, ["No reset to use right now · nothing was used"]));
  cleanup();
  const atLimit = clientAnswering(() => ({ kind: "read", resets: [{ kind: "five_hour", state: "none" }, WEEKLY] }));
  open(atLimit.client, { atFiveHourLimit: true, canUse: true }, { onNote: (note) => notes.push(note) });
  await waitFor(() => assert.match(notes[1] ?? "", /^No 5-hour reset to use · nothing was used · .*Settings › Usage on claude\.ai$/));
});

test("a viewer who may not use resets gets the plain list, never the choice or the confirm", async () => {
  const used: string[] = [];
  const { client } = clientAnswering(() => ({ kind: "read", resets: [WEEKLY, FABLE] }));
  open(client, { atFiveHourLimit: false, canUse: false }, { onUse: (status) => used.push(status.kind) });
  await waitFor(() => assert.equal(screen.getAllByRole("listitem").length, 2));
  assert.equal(screen.queryAllByRole("radio").length, 0);
  assert.deepEqual(used, []);
});

function claudeSnapshot(atLimit: boolean): RuntimeAccountUsageSnapshot {
  return {
    protocolVersion: 2,
    provider: "claude",
    collectedAt: "2026-11-19T03:00:00.000Z",
    staleAfter: "2099-11-19T03:30:00.000Z",
    collectorVersion: "test",
    accounts: [{
      accountKey: "c".repeat(64),
      maskedLabel: "x*****n@botiverse.dev",
      health: atLimit ? "rate_limited" : "ok",
      windows: [{ id: "session", label: "Current session", status: atLimit ? "limit_reached" : "ok", usedRatio: atLimit ? 1 : 0.4, resetsAt: "2099-11-24T09:00:00.000Z" }],
    }],
  };
}

function claudeCard(claudeLimitReset: SurfaceClaudeLimitReset) {
  return render(
    <TestIntlProvider>
      <RuntimeUsageSurface
        runtimeId="claude"
        provider="claude"
        result={{ state: "fresh", snapshot: claudeSnapshot(claudeLimitReset.atFiveHourLimit) }}
        loading={false}
        loadError={false}
        refreshState="idle"
        cooldownLeftMs={0}
        onRefresh={() => {}}
        auth={null}
        runtimeName="Claude Code"
        limitReset={null}
        claudeLimitReset={claudeLimitReset}
        note={null}
      />
    </TestIntlProvider>,
  );
}

test("the card has one Claude entry, \"Use a limit reset\", the main action at the 5-hour limit", () => {
  let opened = 0;
  claudeCard({ atFiveHourLimit: true, canUse: true, onOpen: () => { opened += 1; } });
  const entry = screen.getByRole("button", { name: "Use a limit reset" });
  assert.equal(entry.hasAttribute("data-primary-action"), true);
  assert.equal(screen.queryAllByRole("button", { name: "View available resets" }).length, 0);
  assert.equal(screen.queryAllByRole("button", { name: "Use 5-hour reset" }).length, 0);
  fireEvent.click(entry);
  assert.equal(opened, 1);
  cleanup();
  claudeCard({ atFiveHourLimit: false, canUse: true, onOpen: () => {} });
  assert.equal(screen.getByRole("button", { name: "Use a limit reset" }).hasAttribute("data-primary-action"), false);
});

test("a viewer who may not use resets gets \"View available resets\" instead, never \"Use a limit reset\"", () => {
  claudeCard({ atFiveHourLimit: false, canUse: false, onOpen: () => {} });
  screen.getByRole("button", { name: "View available resets" });
  assert.equal(screen.queryAllByRole("button", { name: "Use a limit reset" }).length, 0);
});
