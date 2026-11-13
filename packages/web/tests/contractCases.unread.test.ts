/**
 * Web's loader for the unread contract cases the app runs too
 * (packages/shared/contract-cases/unread/, format in its README).
 *
 * Every case file is validated against the schema. An agreed case runs here
 * when web has a pure function that decides it; any other case is a skipped
 * test whose name says why (pending product decision, a known web gap, or
 * nothing web can drive yet). Nothing passes without being checked: an agreed
 * case web cannot drive must be listed in WEB_CANNOT_DRIVE_YET with its
 * reason, and a listed case that becomes drivable fails until it is removed.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { resolveMarkUnreadOutcome } from "@botiverse/raft-shared";
import {
  getChannelUnreadIndicatorState,
  getChannelUnreadSegments,
  getDmUnreadIndicatorState,
  shouldShowActivityMutedIcon,
} from "../src/utils/channelUnreadIndicator";

const KNOWN_FORMAT_VERSIONS = new Set([1]);

/** Agreed cases web has no pure function for yet, and why. */
const WEB_CANNOT_DRIVE_YET: Readonly<Record<string, string>> = {
  "R3-hold-until-leave":
    "the hold lives in threadUnreadHold/autoReadHold with the thread panel's lifecycle; needs a store harness with a mocked api",
  "R3-only-my-replies-in-thread":
    "the hold and the toast live in threadUnreadHold/inboxRowActions with the thread panel's lifecycle; needs a store harness with a mocked api",
};

type Row = { joined: boolean; muted: boolean; unread: number; threads?: number; hasNew?: boolean; markedUnread?: boolean; mention?: boolean };
type Step = { act: string; surface?: string; status?: number; body?: Record<string, unknown> };
type State = Record<string, unknown> & { outcome?: string; rowDisplay?: Record<string, unknown> };
type Expectation = { requests?: unknown[]; state?: State };
type ContractCase = {
  formatVersion: number;
  id: string;
  status: "agreed" | "pending-product-decision";
  knownGaps?: { client: "web" | "app"; reason: string }[];
  given: { conversation: { id: string; kind: "channel" | "thread" | "dm" }; row?: Row };
  steps: Step[];
  checkpoints?: unknown[];
  expect?: Expectation;
  decision?: { question: string; candidates: { id: string; currentBehaviourOf: string[] }[] };
};

const sharedRoot = dirname(createRequire(import.meta.url).resolve("@botiverse/raft-shared/package.json"));
const casesDir = join(sharedRoot, "contract-cases", "unread");
const schema = JSON.parse(readFileSync(join(casesDir, "case.schema.json"), "utf8")) as object;
const cases = readdirSync(join(casesDir, "cases"))
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({ name, value: JSON.parse(readFileSync(join(casesDir, "cases", name), "utf8")) as ContractCase }));

/** Only the listed keys of an object, so a case asserts exactly what it names. */
function onlyKeys(actual: Record<string, unknown>, expected: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]]));
}

type Runner = (contractCase: ContractCase) => void;

/**
 * R1: what a 200 Mark as Unread answer means, as the inbox and message stores
 * resolve it (resolveMarkUnreadOutcome). Drives a case that is exactly
 * "markUnread, then a 200 answer" and asserts only `state.outcome`.
 */
function markUnreadAnswerRunner(contractCase: ContractCase): Runner | string {
  const [mark, answer, ...rest] = contractCase.steps;
  const expect = contractCase.expect ?? {};
  if (mark?.act !== "markUnread" || answer?.act !== "serverResponds" || rest.length > 0) return "not a markUnread → answer case";
  if (answer.status !== 200) return `a ${answer.status} answer has no pure function on web`;
  if (contractCase.checkpoints || expect.requests || Object.keys(expect.state ?? {}).some((key) => key !== "outcome")) {
    return "asserts more than the outcome (requests, checkpoints, or other state)";
  }
  return () => assert.equal(resolveMarkUnreadOutcome(answer.body), expect.state?.outcome);
}

/**
 * R9–R11, S1: a channel row's unread display, from the Sidebar's own helpers
 * (getChannelUnreadIndicatorState, shouldShowActivityMutedIcon, and
 * getChannelUnreadSegments for the numbers ChannelUnreadSegments draws). The
 * not-joined thread gating is not checked: the Sidebar applies it before
 * calling the helpers.
 */
function channelRowRunner(contractCase: ContractCase): Runner | string {
  const { conversation, row } = contractCase.given;
  const display = contractCase.expect?.state?.rowDisplay;
  if (!row || !display || contractCase.steps.length > 0) return "not a row display case";
  if (conversation.kind !== "channel") return "not a channel row";
  if (Object.keys(contractCase.expect?.state ?? {}).length !== 1 || contractCase.expect?.requests) return "asserts more than rowDisplay";
  if (!row.joined && (row.threads ?? 0) > 0) return "the not-joined thread gating is in the Sidebar component";
  if (row.mention !== undefined) return "the mention marker is computed in the Sidebar component";
  return () => {
    const state = getChannelUnreadIndicatorState({
      unread: row.unread,
      joined: row.joined,
      showMutedIcon: shouldShowActivityMutedIcon({ activityMuted: row.muted, joined: row.joined }),
      hasNew: row.hasNew,
      threadUnread: row.threads ?? 0,
      markedUnread: row.markedUnread,
    });
    const kind = state.showLoudUnreadBadge ? "loud"
      : state.showQuietUnreadCount ? "quiet"
        : state.showQuietNewDot ? "newDot"
          : state.showMarkedUnreadDot ? "markedDot"
            : "none";
    const shown = kind === "loud" || kind === "quiet";
    const segments = shown ? getChannelUnreadSegments(row.unread, row.threads ?? 0) : {};
    assert.deepEqual(onlyKeys({ kind, segments, unreadTone: state.unreadTone }, display), display);
  };
}

/**
 * R11: a DM row's unread display, from getDmUnreadIndicatorState (DmRow,
 * AgentDmRow, SidebarPeerRowBody). A DM row shows one number, the unread.
 * `mention` is an input the web rule ignores (it never pierces a mute), so it
 * is accepted and has no effect; `threads`/`hasNew` have no meaning for a DM.
 */
function dmRowRunner(contractCase: ContractCase): Runner | string {
  const { conversation, row } = contractCase.given;
  const display = contractCase.expect?.state?.rowDisplay;
  if (!row || !display || contractCase.steps.length > 0) return "not a row display case";
  if (conversation.kind !== "dm") return "not a DM row";
  if (Object.keys(contractCase.expect?.state ?? {}).length !== 1 || contractCase.expect?.requests) return "asserts more than rowDisplay";
  if ((row.threads ?? 0) > 0 || row.hasNew !== undefined) return "threads/hasNew on a DM row";
  return () => {
    const state = getDmUnreadIndicatorState({ unread: row.unread, markedUnread: row.markedUnread === true, activityMuted: row.muted });
    const kind = state.showLoudUnreadBadge ? "loud"
      : state.showQuietUnreadCount ? "quiet"
        : state.showMarkedUnreadDot ? "markedDot"
          : "none";
    const segments = kind === "loud" || kind === "quiet" ? { unread: row.unread } : {};
    assert.deepEqual(onlyKeys({ kind, segments, unreadTone: state.unreadTone }, display), display);
  };
}

const RUNNERS = [markUnreadAnswerRunner, channelRowRunner, dmRowRunner];

/** A runner for the case, or why web cannot run it. */
function planFor(contractCase: ContractCase): Runner | { skip: string } {
  if (!KNOWN_FORMAT_VERSIONS.has(contractCase.formatVersion)) {
    return { skip: `formatVersion ${contractCase.formatVersion} is not one this loader knows` };
  }
  if (contractCase.status === "pending-product-decision") {
    const web = contractCase.decision?.candidates.find((candidate) => candidate.currentBehaviourOf.includes("web"));
    return { skip: `pending product decision: ${contractCase.decision?.question} (web today: ${web?.id ?? "none"})` };
  }
  const gap = contractCase.knownGaps?.find((entry) => entry.client === "web");
  if (gap) return { skip: `known web gap: ${gap.reason}` };
  const misses: string[] = [];
  for (const runner of RUNNERS) {
    const plan = runner(contractCase);
    if (typeof plan === "function") {
      assert.equal(WEB_CANNOT_DRIVE_YET[contractCase.id], undefined, `${contractCase.id} is drivable now: remove it from WEB_CANNOT_DRIVE_YET`);
      return plan;
    }
    misses.push(plan);
  }
  const listed = WEB_CANNOT_DRIVE_YET[contractCase.id];
  assert.ok(listed, `${contractCase.id}: no web runner (${misses.join("; ")}); drive it or list it in WEB_CANNOT_DRIVE_YET with a reason`);
  return { skip: `web cannot drive it yet: ${listed}` };
}

describe("unread contract cases", () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

  it("finds the case files", () => {
    assert.ok(cases.length > 0, `no cases in ${casesDir}`);
  });

  for (const { name, value } of cases) {
    it(`${name} is valid against case.schema.json`, () => {
      assert.equal(validate(value), true, JSON.stringify(validate.errors));
      assert.equal(`${value.id}.json`, name);
    });
  }

  it("lists only existing agreed cases as not drivable", () => {
    for (const id of Object.keys(WEB_CANNOT_DRIVE_YET)) {
      const found = cases.find(({ value }) => value.id === id)?.value;
      assert.equal(found?.status, "agreed", `${id} in WEB_CANNOT_DRIVE_YET is not an agreed case`);
    }
  });

  for (const { value } of cases) {
    const plan = planFor(value);
    if (typeof plan === "function") it(`${value.id}`, () => plan(value));
    else it.skip(`${value.id} (skipped: ${plan.skip})`, () => {});
  }
});
