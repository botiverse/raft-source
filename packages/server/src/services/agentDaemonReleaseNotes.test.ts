import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  getAgentDaemonReleaseNotesBetween,
  getAgentDaemonReleaseNotice,
  renderAgentDaemonReleaseNotice,
} from "./agentDaemonReleaseNotes.js";

const repoRoot = new URL("../../../../", import.meta.url);

function readPackageVersion(packageName: "cli" | "computer" | "daemon"): string {
  return JSON.parse(
    readFileSync(new URL(`packages/${packageName}/package.json`, repoRoot), "utf8"),
  ).version;
}

// 0.40.2 is the bootstrap baseline: every agent-facing change shipped from
// 0.40.2 onward is in the catalog. These tests pin that contract so that the
// baseline can't drift forward (e.g. to 0.40.3) without an explicit decision.

test("agent-facing release notes: unstamped Computer daemon maps to the 0.72.0 alignment release", () => {
  assert.deepEqual(
    getAgentDaemonReleaseNotesBetween("0.0.0-dev", "0.72.1").map((note) => note.version),
    ["0.72.1"],
  );
  assert.deepEqual(
    getAgentDaemonReleaseNotesBetween("0.0.0-dev", "0.72.4"),
    getAgentDaemonReleaseNotesBetween("0.72.0", "0.72.4"),
  );
});

test("agent-facing release notes: 0.40.1 -> 0.41.0 surfaces both v0.40.2 and v0.41.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.40.1", "0.41.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.40.2", "0.41.0"]);
});

test("agent-facing release notes: 0.40.2 -> 0.41.0 surfaces only v0.41.0 entries (baseline floor not redelivered)", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.40.2", "0.41.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.41.0"]);
});

test("agent-facing release notice: 0.40.1 -> 0.41.0 includes Activity Log mirror (v0.40.2) and wake-up redirect (v0.41.0) copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.40.1", "0.41.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /Runtime Profile.*mirrored into Activity Log/);
  assert.match(allCopy, /wake-up tools.*route through Slock reminders/);
});

test("agent-facing release notice render omits private repository release-note URLs", () => {
  const notice = getAgentDaemonReleaseNotice("0.57.1", "0.57.2");
  assert.ok(notice);
  const rendered = renderAgentDaemonReleaseNotice(notice);
  assert.doesNotMatch(rendered, /Release notes:/);
  assert.doesNotMatch(rendered, /github\.com\/botiverse\/slock\/pull/);
  assert.match(rendered, /Agent-facing daemon changes:/);
});

test("agent-facing release notice: 1.0.15 -> 1.0.16 corrects mute semantics without rewriting 1.0.0 history", () => {
  const historicalNotice = getAgentDaemonReleaseNotice("0.72.4", "1.0.0");
  assert.ok(historicalNotice);
  const historicalCopy = historicalNotice.notes
    .flatMap((note) => note.entries)
    .flatMap((entry) => [entry.summary, entry.whyItMatters ?? ""])
    .join(" | ");
  assert.match(historicalCopy, /channel AND its threads/);
  assert.doesNotMatch(historicalCopy, /Older CLI builds/);

  const notice = getAgentDaemonReleaseNotice("1.0.15", "1.0.16");
  assert.ok(notice);
  assert.deepEqual(notice.notes.map((note) => note.version), ["1.0.16"]);
  const allCopy = notice.notes
    .flatMap((note) => note.entries)
    .flatMap((entry) => [entry.summary, entry.whyItMatters ?? ""])
    .join(" | ");

  assert.match(allCopy, /Older CLI builds/);
  assert.match(allCopy, /personal @mention does not re-follow you/);
  assert.match(allCopy, /sentence is stale/);
  assert.match(allCopy, /mention reactivates an explicitly unfollowed thread/);
  assert.match(allCopy, /commands remain compatible/);
  assert.match(allCopy, /upgrade the Computer\/daemon\/CLI to 1\.0\.16 or later/);
});

test("agent-facing release notice: 1.0.16 -> 1.0.17 carries scoped Reminder and runtime recovery truth", () => {
  const notice = getAgentDaemonReleaseNotice("1.0.16", "1.0.17");
  assert.ok(notice);
  assert.deepEqual(notice.notes.map((note) => note.version), ["1.0.17"]);

  const allCopy = notice.notes
    .flatMap((note) => note.entries)
    .flatMap((entry) => [entry.summary, entry.whyItMatters ?? ""])
    .join(" | ");

  assert.match(allCopy, /Server\/App\/Agent-scoped pending-fire receipts/);
  assert.match(allCopy, /two Server identities sharing one Raft home/);
  assert.match(allCopy, /bounded capacity exits/);
  assert.match(allCopy, /offered allow-once permission/);
  assert.match(allCopy, /ordinary, late, cross-session, or persistent permission requests still fail closed/);
  assert.match(allCopy, /message read --around/);
  assert.match(allCopy, /no longer advances the unread cursor/);

  // The four discoverability entries required by the task #295 review: new
  // commands, proxy diagnostics, and the removed third-party prompt must be
  // announced to agents upgrading through 1.0.17.
  assert.match(allCopy, /`raft reminder ack`/);
  assert.match(allCopy, /`raft task amend`/);
  assert.match(allCopy, /PROXY_5XX/);
  assert.match(allCopy, /correlation id/);
  assert.match(allCopy, /third-party app safety prompt/);
  assert.match(allCopy, /untrusted data and never instructions/);

  // Reviewer-included candidates (task #295 seat, PR #6567 review): entries
  // that change how an agent reads an existing surface must be announced.
  assert.match(allCopy, /OVERDUE/);
  assert.match(allCopy, /do not read an unmarked row as evidence of liveness/);
  assert.match(allCopy, /--target-confirmed/);
  assert.match(allCopy, /held as a draft unless explicitly confirmed/);
});

test("agent-facing release notice: public Alpha 1.0.21 -> 1.0.22 carries the exact actionable successor interval", () => {
  const notice = getAgentDaemonReleaseNotice("1.0.21", "1.0.22");
  assert.ok(notice);
  assert.deepEqual(notice.notes.map((note) => note.version), ["1.0.22"]);
  assert.equal(notice.notes[0]?.entries.length, 7);

  const allCopy = notice.notes
    .flatMap((note) => note.entries)
    .flatMap((entry) => [entry.summary, entry.whyItMatters ?? ""])
    .join(" | ");

  // The interval is source-accounted rather than inferred from commit subjects:
  // 9db6c74d is the task-list timestamp entry below; 4079928f changes held-send
  // TEXT presentation only; d9e8bd71 is exactly reverted by 9a2a202f. Computer-
  // only host lifecycle is outside the agent-facing/actionable release-note scope.
  // The seven positive families plus the exact entry count make these exclusions
  // load-bearing: adding an eighth presentation/host/net-zero entry fails here.
  assert.doesNotMatch(allCopy, /post-login launch carrier|macOS login carrier|raft-computer doctor/);
  assert.doesNotMatch(allCopy, /Effect: draft_saved|Draft saved:|Next action:/);
  assert.doesNotMatch(allCopy, /Add is only for humans|consequence-first mention receipts/);
  assert.match(allCopy, /already claimed by you/);
  assert.match(allCopy, /Being assigned a task is a reservation, not a completed claim/);
  assert.match(allCopy, /created=/);
  assert.match(allCopy, /updated=/);
  assert.match(allCopy, /QUERY_TOO_BROAD/);
  assert.match(allCopy, /SEARCH_UNAVAILABLE/);
  assert.match(allCopy, /SEARCH_TIMEOUT/);
  assert.match(allCopy, /--sort recent/);
  assert.match(allCopy, /path parameters into the action URL/);
  assert.match(allCopy, /without also repeating those fields/);
  assert.match(allCopy, /manual get membership/);
  assert.match(allCopy, /invite link/);
  assert.match(allCopy, /hidden human directory/);
  assert.match(allCopy, /does not prove whether a hidden person exists/);
  assert.match(allCopy, /invalid_attachment_id/);
  assert.match(allCopy, /absent and inaccessible attachments/);
});

test("agent-facing release notice: public Alpha 1.0.22 -> 1.0.23 stays limited to the exact agent-observable interval", () => {
  const notice = getAgentDaemonReleaseNotice("1.0.22", "1.0.23");
  assert.ok(notice);
  assert.deepEqual(notice.notes.map((note) => note.version), ["1.0.23"]);
  assert.equal(notice.notes[0]?.entries.length, 3);

  const allCopy = notice.notes
    .flatMap((note) => note.entries)
    .flatMap((entry) => [entry.summary, entry.whyItMatters ?? ""])
    .join(" | ");

  assert.match(allCopy, /`raft-computer channel versions \[latest\|alpha\]`/);
  assert.match(allCopy, /active and superseded releases/);
  assert.match(allCopy, /`--json`/);
  assert.match(allCopy, /bounded `--limit`/);
  assert.match(allCopy, /one authoritative release selection/);
  assert.match(allCopy, /no K operation started/);
  assert.match(allCopy, /package availability only/);
  assert.match(allCopy, /Do not treat `--dry-run` as an authorization check/);
  assert.match(allCopy, /`channel set` applies to the next upgrade/);
  assert.match(allCopy, /Direct agent HTTP search calls/);
  assert.match(allCopy, /`INVALID_DATE_FILTER`/);
  assert.match(allCopy, /`after`\/`before`/);
  assert.match(allCopy, /`2026-08-31T14:30:00\+08:00`/);
  assert.match(allCopy, /`raft message search`/);
  assert.match(allCopy, /silently interpreted as UTC/);
  assert.match(allCopy, /pasting a `Time:` value/);

  assert.doesNotMatch(allCopy, /policy_row_missing|policyRevision|raw response body/);
  assert.doesNotMatch(allCopy, /post-login|macOS login carrier|existing-K|realpath/);
  assert.doesNotMatch(allCopy, /restart/);
});

test("agent-facing release notice: public Alpha 1.0.23 -> 1.0.24 carries the exact actionable successor interval", () => {
  const notice = getAgentDaemonReleaseNotice("1.0.23", "1.0.24");
  assert.ok(notice);
  assert.deepEqual(notice.notes.map((note) => note.version), ["1.0.24"]);
  assert.equal(notice.notes[0]?.entries.length, 4);

  const allCopy = notice.notes
    .flatMap((note) => note.entries)
    .flatMap((entry) => [entry.summary, entry.whyItMatters ?? ""])
    .join(" | ");

  assert.match(allCopy, /`raft user info <name>`/);
  assert.match(allCopy, /inspected user's visible channel memberships/);
  assert.match(allCopy, /caller's joined or muted state/);

  assert.match(allCopy, /Pi SDK 0\.84\.4/);
  assert.match(allCopy, /DeepSeek V4 Flash Vision/);
  assert.match(allCopy, /GLM 5\.3/);
  assert.match(allCopy, /Qwen 3\.8 Flash/);
  assert.match(allCopy, /stale unsupported model aliases/);

  assert.match(allCopy, /`raft-computer operation acknowledge <operationId>`/);
  assert.match(allCopy, /exact terminal receipt id/);
  assert.match(allCopy, /durable audit record/);
  assert.match(allCopy, /active, missing, unreadable, or different receipts fail closed/);

  assert.match(allCopy, /response, idle, and size-derived overall deadlines/);
  assert.match(allCopy, /30-minute hard maximum/);
  assert.match(allCopy, /fixed whole-transfer timeout/);
  assert.match(allCopy, /false rollback/);

  // The AX registry/branding/example series is definition and test tooling: it
  // deliberately preserves formatter/runtime bytes. Server-only MachineMeta
  // timestamping and release/acceptance harness work are outside this
  // Computer/CLI/daemon agent-actionable notice.
  assert.doesNotMatch(allCopy, /axSurface|AX HTML|print seam|branded text|typed examples/);
  assert.doesNotMatch(allCopy, /MachineMeta|observedAt|existing-K|realpath|Bash 3\.2/);
  assert.doesNotMatch(allCopy, /policy_row_missing|policyRevision|raw response body/);
});

test("agent-facing release notice: public Alpha 1.0.24 -> 1.0.25 carries the exact actionable successor interval", () => {
  const notice = getAgentDaemonReleaseNotice("1.0.24", "1.0.25");
  assert.ok(notice);
  assert.deepEqual(notice.notes.map((note) => note.version), ["1.0.25"]);
  assert.equal(notice.notes[0]?.entries.length, 6);

  const allCopy = notice.notes
    .flatMap((note) => note.entries)
    .flatMap((entry) => [entry.summary, entry.whyItMatters ?? ""])
    .join(" | ");

  assert.match(allCopy, /Local CLI and tray upgrades/);
  assert.match(allCopy, /resident service.*Hands.*K/);
  assert.match(allCopy, /no Server session, attachment, or lifecycle intent/);
  assert.match(allCopy, /remote policy remains at the Server trigger boundary/);
  assert.match(allCopy, /status and doctor/);
  assert.match(allCopy, /promoted, rolled-back, or failed receipt/);

  assert.match(allCopy, /Agent API transport failures/);
  assert.match(allCopy, /proxy diagnostics/);
  assert.match(allCopy, /write outcome is ambiguous/);
  assert.match(allCopy, /not to automatically resend/);

  assert.match(allCopy, /Agent Login callback handoff/);
  assert.match(allCopy, /one-time code/);
  assert.match(allCopy, /browser state or callback cookies/);

  assert.match(allCopy, /Kimi model profiles/);
  assert.match(allCopy, /supported and default reasoning efforts/);
  assert.match(allCopy, /new and resumed sessions/);

  assert.match(allCopy, /`raft manual search`/);
  assert.match(allCopy, /correction and canonical-concept expansion reasons/);

  assert.match(allCopy, /channel-level admin authority/);
  assert.match(allCopy, /server and channel roles separately/);
  assert.match(allCopy, /does not grant server-profile or visibility control/);

  assert.doesNotMatch(allCopy, /policy_row_missing|policyRevision|raw response body/);
  assert.doesNotMatch(allCopy, /stable promotion|production deployment/);
});

test("Computer Alpha 1.0.28 closes the Computer, CLI, and daemon carrier tuple", () => {
  assert.deepEqual(
    {
      computer: readPackageVersion("computer"),
      cli: readPackageVersion("cli"),
      daemon: readPackageVersion("daemon"),
    },
    {
      computer: "1.0.28",
      cli: "0.0.24",
      daemon: "1.0.25",
    },
  );
});

test("agent-facing release notes: 1.0.1 -> 1.0.15 registers the exact App-management capability", () => {
  const notes = getAgentDaemonReleaseNotesBetween("1.0.1", "1.0.15");
  assert.deepEqual(notes.map((note) => note.version), ["1.0.15"]);
  const entries = notes.flatMap((note) => note.entries);
  const entry = entries.find(
    (candidate) => candidate.capabilityId === "integration-app-management",
  );
  assert.ok(entry);
  assert.deepEqual(entry.commands, [
    "raft integration app prepare register",
    "raft integration app prepare recover-owner",
    "raft integration app rotate-secret",
    "raft integration app transfer-owner",
    "raft integration app update",
    "raft integration app logo",
    "raft integration app clear-logo",
    "raft integration app share-link",
    "raft integration app share-link-status",
    "raft integration app revoke-share-link",
    "raft integration app request-publish",
    "raft integration app request-unpublish",
    "raft integration app delete",
    "raft integration app list",
    "raft integration app status",
  ]);
  assert.match(entry.summary, /register and manage source-owned Apps/);
  assert.match(entry.summary, /rotate-secret --client <key> --output <new-private-path>/);
  assert.match(entry.summary, /never to stdout or JSON/);
  assert.match(entry.summary, /agent-selected, newly created mode-0600 file/);
  assert.match(entry.summary, /outside Web\/static\/shared surfaces/);
  assert.match(entry.whyItMatters ?? "", /fails closed on Windows/);
  assert.match(entry.whyItMatters ?? "", /caller-managed after return/);
  assert.match(entry.whyItMatters ?? "", /retain any empty or sensitive private artifact/);
  assert.match(entry.whyItMatters ?? "", /Marketplace requests are not approvals/);
});

test("agent-facing release notice: 0.40.2 -> 0.41.0 omits Activity Log mirror copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.40.2", "0.41.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.doesNotMatch(allCopy, /Runtime Profile.*mirrored into Activity Log/);
  assert.match(allCopy, /wake-up tools.*route through Slock reminders/);
});

test("agent-facing release notes: 0.41.0 -> 0.42.0 surfaces only v0.42.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.41.0", "0.42.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.42.0"]);
});

test("agent-facing release notice: 0.41.0 -> 0.42.0 includes runtime switch + runtime context + profile CLI + channel members copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.41.0", "0.42.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /runtime can be switched.*Claude.*Codex.*Kimi/);
  assert.match(allCopy, /current runtime and model are now exposed/);
  assert.match(allCopy, /slock profile show and slock profile update/);
  assert.match(allCopy, /slock channel members is now advertised/);
});

test("agent-facing release notes: 0.42.0 -> 0.43.0 surfaces only v0.43.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.42.0", "0.43.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.43.0"]);
});

test("agent-facing release notice: 0.42.0 -> 0.43.0 includes OpenCode runtime + public channel write contract + profile flags + workspace contract copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.42.0", "0.43.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /OpenCode joins.*supported agent runtime/);
  assert.match(allCopy, /Public channels enforce join-to-write/);
  assert.match(allCopy, /slock profile update now accepts --display-name/);
  assert.match(allCopy, /flexible, agent-owned workspace/);
});

test("agent-facing release notes: 0.43.0 -> 0.44.0 surfaces only v0.44.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.43.0", "0.44.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.44.0"]);
});

test("agent-facing release notice: 0.43.0 -> 0.44.0 includes reminder snooze + silent claim failure + online recovery", () => {
  const notice = getAgentDaemonReleaseNotice("0.43.0", "0.44.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /slock reminder gains snooze, update/);
  assert.match(allCopy, /slock task claim now stays silent/);
  assert.match(allCopy, /Agents stay online through daemon reconnects/);
  // Status dot sweep is not agent-observable (pure UI), so it does not
  // ship in the agent-facing notice. Per tygg 2026-05-03
  // #proj-release:29e3073f msg=52af2b56.
  assert.doesNotMatch(allCopy, /sweep-from-daemon/);
});

test("agent-facing release notes: 0.44.0 -> 0.46.0 surfaces only v0.46.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.44.0", "0.46.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.46.0"]);
});

test("agent-facing release notes: 0.46.0 -> 0.46.1 surfaces only v0.46.1 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.46.0", "0.46.1");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.46.1"]);
});

test("agent-facing release notice: 0.46.0 -> 0.46.1 includes Gemini Windows fix + reply-target hints + membership notifications + workspace scoping + txt preview", () => {
  const notice = getAgentDaemonReleaseNotice("0.46.0", "0.46.1");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /Gemini agents on Windows.*8191-char/);
  assert.match(allCopy, /Daemon delivery prompts now include a reply-target hint/);
  assert.match(allCopy, /Channel membership changes.*delivered as a system message/);
  assert.match(allCopy, /Other agents' workspaces and activity logs are no longer visible/);
  assert.match(allCopy, /Plain-text.*attachments now preview inline/);
});

test("agent-facing release notice: 0.44.0 -> 0.46.0 includes stdin recovery + non-stdin recovery + Gemini transport unify + delivery-state guard + N26 release_notice prompt fix + private channels + search sort/sender + attachment limits + runtime error persist + gated/startup notice + Claude MCP preserve + stalled stdin restart + OpenCode model + reminder lifecycle prompt", () => {
  const notice = getAgentDaemonReleaseNotice("0.44.0", "0.46.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  // Original 0.45.0 entries (5/4 prep, never published; consolidated into the
  // 5/7 publish as 0.46.0 per tygg #proj-release:145d82c4 msg=1ced8605 —
  // skip the never-shipped 0.45.0 tag to keep daemon version history
  // aligned with npm-visible tags).
  assert.match(allCopy, /stdin-driven runtimes.*recover automatically/);
  assert.match(allCopy, /Non-stdin runtimes.*Cursor, Gemini, OpenCode.*recover stale deliveries/);
  assert.match(allCopy, /If you run on Gemini.*same Slock CLI transport/);
  assert.match(allCopy, /guards in-flight delivery state/);
  // 5/4 -> 5/7 additions appended into the same 0.46.0 block.
  assert.match(allCopy, /Daemon release notices no longer claim a runtime control action/);
  assert.match(allCopy, /Channels can be private \(membership-gated\)/);
  assert.match(allCopy, /slock message search adds --sort relevance\|recent/);
  assert.match(allCopy, /Attachment uploads cap at 50MB and reject empty files/);
  assert.match(allCopy, /Visible runtime errors persist after turn end/);
  assert.match(allCopy, /Runtime Profile notice delivery now also fires reliably for gated and startup runtimes/);
  assert.match(allCopy, /your user-side MCP plugins are preserved/);
  assert.match(allCopy, /Stalled stdin runtimes are restarted automatically/);
  assert.match(allCopy, /OpenCode model is detected from the OpenCode CLI itself/);
  assert.match(allCopy, /Reminder lifecycle.*described fully in your system prompt/);
  assert.match(allCopy, /Gemini's static model catalog matches what the runtime actually supports/);
});

test("agent-facing release notes: 0.62.0 -> 0.63.0 surfaces only v0.63.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.62.0", "0.63.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.63.0"]);
});

test("agent-facing release notice: 0.62.0 -> 0.63.0 includes Codex reliability and mention Add wording copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.62.0", "0.63.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /Codex runtime startup, resume fallback/);
  assert.match(allCopy, /Mention actions now use Add instead of Invite/);
});

test("agent-facing release notes: 0.62.0 -> 0.63.2 surfaces v0.63.0 and v0.63.2 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.62.0", "0.63.2");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.63.0", "0.63.2"]);
});

test("agent-facing release notice: 0.63.0 -> 0.63.2 includes non-Computer 0.63.2 copy and omits Computer copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.63.0", "0.63.2");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /Codex no longer receives an injected default `CODEX_HOME`/);
  assert.match(allCopy, /Claude custom-provider agents now ignore host-level Claude user settings/);
  assert.match(allCopy, /Held `raft message send` drafts now explicitly say/);
  assert.doesNotMatch(allCopy, /Computer/);
});

test("agent-facing release notes: 0.63.2 -> 0.63.3 surfaces only v0.63.3 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.63.2", "0.63.3");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.63.3"]);
});

test("agent-facing release notice: 0.63.2 -> 0.63.3 includes joint-channel message resolution copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.63.2", "0.63.3");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => `${e.summary} ${e.whyItMatters}`)
    .join(" | ");
  assert.match(allCopy, /Message resolution now works through joint-channel projections/);
  assert.match(allCopy, /normal `raft message resolve` flow/);
});

test("agent-facing release notes: 0.63.3 -> 0.63.4 surfaces only v0.63.4 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.63.3", "0.63.4");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.63.4"]);
});

test("agent-facing release notice: 0.63.3 -> 0.63.4 includes Pi SDK 0.79.8 and internal Kimi SDK copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.63.3", "0.63.4");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => `${e.summary} ${e.whyItMatters}`)
    .join(" | ");
  assert.match(allCopy, /Pi runtime now uses Pi SDK 0\.79\.8/);
  assert.match(allCopy, /Kimi SDK runtime now uses the internal @botiverse\/kimi-code-sdk 0\.18\.0 build/);
  assert.match(allCopy, /normal Runtime Profile flow/);
});

test("agent-facing release notes: 0.53.0 -> 0.54.0 surfaces only v0.54.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.53.0", "0.54.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.54.0"]);
});

test("agent-facing release notice: 0.53.0 -> 0.54.0 includes Antigravity runtime + Runtime Profile session reset + 0.53.x informational-notice delivery fix + Codex premature-terminal fix + action-card computer constraints + Cursor Windows env", () => {
  const notice = getAgentDaemonReleaseNotice("0.53.0", "0.54.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /Antigravity joins.*supported agent runtime/);
  assert.match(allCopy, /Runtime Profile change applies, the session is treated as a fresh start/);
  assert.match(allCopy, /Informational daemon notices no longer block ordinary message delivery/);
  assert.match(allCopy, /Codex-runtime turns no longer wedge silently after a terminal event/);
  assert.match(allCopy, /Action cards that target a specific computer/);
  assert.match(allCopy, /Runtime mute and false-stall observability is sharper/);
  assert.match(allCopy, /On Windows, Cursor runtimes now inherit the user's environment/);
  assert.match(allCopy, /Stuck runtime startup now times out/);
  // Daemon-internal items dropped from agent-facing catalog per tygg
  // #proj-release:60302ee8 msg=7189aa2d 2026-05-26 ("这些 Agent 看不到。这些偏向于 Daemon 的改动"):
  // login-required diagnostic class, Codex OAuth invalidation auth-required,
  // daemon-refresh wakeability re-arm, Windows Claude/Gemini/credential-proxy
  // launch-path fixes — all observable to humans/operators in diagnostic
  // surfaces, not by the agent itself.
  assert.doesNotMatch(allCopy, /Runtime login-required failures are now surfaced/);
  assert.doesNotMatch(allCopy, /Codex OAuth invalidation is now treated as auth-required/);
  assert.doesNotMatch(allCopy, /After a daemon refresh, the wakeability path/);
  assert.doesNotMatch(allCopy, /Windows Claude launches no longer hit `spawn EINVAL`/);
  // Joint-channel items are botiverse-scoped and intentionally NOT in the
  // general release catalog (stdrc #proj-release:60302ee8 msg=4fe885d2/a2384580
  // 2026-05-26).
  assert.doesNotMatch(allCopy, /Joint channels.*Activity feed/);
});

test("agent-facing release notes: 0.54.0 -> 0.54.2 surfaces v0.54.1 and v0.54.2 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.54.0", "0.54.2");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.54.1", "0.54.2"]);
});

test("agent-facing release notice: 0.54.0 -> 0.54.2 includes proxy env honor + credential proxy streaming guard + local slock proxy bypass + structured spawn failure + OpenCode replay recovery", () => {
  const notice = getAgentDaemonReleaseNotice("0.54.0", "0.54.2");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /honor `HTTP_PROXY` \/ `HTTPS_PROXY`/);
  assert.match(allCopy, /credential proxy.*guards against streaming failures/);
  assert.match(allCopy, /local `slock` CLI wrapper now bypasses `HTTP_PROXY`/);
  assert.match(allCopy, /Runtime spawn failures now surface a structured error/);
  assert.match(allCopy, /OpenCode runtimes recover automatically when the upstream rejects a session replay/);
});

test("agent-facing release notes: 0.56.1 -> 0.57.0 surfaces only v0.57.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.56.1", "0.57.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.57.0"]);
});

test("agent-facing release notice: 0.56.1 -> 0.57.0 includes output-channel rule + removed-channel notification purge + runtime error cooldown copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.56.1", "0.57.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /text you produce outside a `slock` command is not delivered/);
  assert.match(allCopy, /removed from a private or joint channel, the daemon now purges/);
  assert.match(allCopy, /recoverable runtime or provider failures/);
});

test("agent-facing release notes: 0.57.0 -> 0.57.1 surfaces only v0.57.1 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.57.0", "0.57.1");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.57.1"]);
});

test("agent-facing release notice: 0.57.0 -> 0.57.1 includes inbox coalescing + consume boundary fixes + recovery backoff copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.57.0", "0.57.1");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /Duplicate inbox notices.*coalesced/);
  assert.match(allCopy, /Inbox consume no longer re-fires orphaned residue/);
  assert.match(allCopy, /new-message delivery.*backs off exponentially/);
});

test("agent-facing release notes: 0.57.1 -> 0.57.2 surfaces only v0.57.2 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.57.1", "0.57.2");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.57.2"]);
});

test("agent-facing release notice: 0.57.1 -> 0.57.2 includes stdin dedup + error cooldown + CLI retry + volatile ack + CC1 cleanup + bound inbox copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.57.1", "0.57.2");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /stdin notices are now deduplicated/);
  assert.match(allCopy, /Unclassified runtime errors now cool down/);
  assert.match(allCopy, /CLI now retries transient network errors/);
  assert.match(allCopy, /Delivery acknowledgement cursors are now volatile/);
  assert.match(allCopy, /visible state now clears on explicit.*stopAgent/);
  assert.match(allCopy, /Inbox notice contributions are now bounded/);
});

test("agent-facing release notes: 0.57.2 -> 0.57.3 surfaces v0.57.3 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.57.2", "0.57.3");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.57.3"]);
});

test("agent-facing release notice: 0.57.2 -> 0.57.3 includes credential hygiene scope copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.57.2", "0.57.3");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /Credential hygiene rule narrowed to public channels/);
});

test("agent-facing release notes: 0.57.3 -> 0.57.4 surfaces only v0.57.4 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.57.3", "0.57.4");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.57.4"]);
});

test("agent-facing release notice: 0.57.3 -> 0.57.4 includes spawn backoff + Pi compaction + rebind + stale error copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.57.3", "0.57.4");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /agent start attempts now back off/);
  assert.match(allCopy, /Pi SDK compaction is now enabled/);
  assert.match(allCopy, /rebind to the latest launch/);
  assert.match(allCopy, /Runtime progress now invalidates stale errors/);
});

test("agent-facing release notes: 0.57.4 -> 0.57.6 surfaces only v0.57.6 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.57.4", "0.57.6");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.57.6"]);
});

test("agent-facing release notice: 0.57.4 -> 0.57.6 includes content-free inbox notice reframe copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.57.4", "0.57.6");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /Content-free inbox notices now clearly signal that unread messages exist/);
});

test("agent-facing release notes: 0.57.7 -> 0.58.0 surfaces only v0.58.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.57.7", "0.58.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.58.0"]);
});

test("agent-facing release notice: 0.57.7 -> 0.58.0 includes rename migration guide reference", () => {
  const notice = getAgentDaemonReleaseNotice("0.57.7", "0.58.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /Slock is now Raft/);
  assert.match(allCopy, /raft manual get rename-slock-to-raft/);
});

test("agent-facing release notes: 0.58.0 -> 0.59.0 surfaces only v0.59.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.58.0", "0.59.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.59.0"]);
});

test("agent-facing release notice: 0.58.0 -> 0.59.0 includes mention behavior change copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.58.0", "0.59.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /no longer silently pull you into conversations/);
  assert.match(allCopy, /explicit Add\/Notify actions/);
});

test("agent-facing release notes: 0.63.5 -> 0.63.6 surfaces only v0.63.6 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.63.5", "0.63.6");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.63.6"]);
});

test("agent-facing release notes: 0.40.2 -> 0.63.6 does not redeliver the baseline floor", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.40.2", "0.63.6");
  const versions = notes.map((n) => n.version);
  assert.ok(!versions.includes("0.40.2"));
  assert.ok(versions.includes("0.63.6"));
});

test("agent-facing release notice: 0.63.5 -> 0.63.6 includes runtime error fence + integration app prepare + raft_secret copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.63.5", "0.63.6");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /Runtime error restart fence/);
  assert.match(allCopy, /raft integration app prepare/);
  assert.match(allCopy, /raft_secret_/);
});

test("agent-facing release notes: 0.63.6 -> 0.63.7 surfaces only v0.63.7 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.63.6", "0.63.7");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.63.7"]);
});

test("agent-facing release notes: 0.40.2 -> 0.63.7 does not redeliver the baseline floor", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.40.2", "0.63.7");
  const versions = notes.map((n) => n.version);
  assert.ok(!versions.includes("0.40.2"));
  assert.ok(versions.includes("0.63.7"));
});

test("agent-facing release notice: 0.63.6 -> 0.63.7 includes runner credential backoff + recipient-specific mention + Kimi 0.19.2 copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.63.6", "0.63.7");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /Runner credential mint failures now back off/);
  assert.match(allCopy, /recipient-specific/);
  assert.match(allCopy, /0\.19\.2-botiverse\.0/);
  assert.match(allCopy, /Turn-end inbox notices now flush/);
  assert.match(allCopy, /wait for session readiness/);
  assert.match(allCopy, /ELECTRON_RUN_AS_NODE/);
  assert.doesNotMatch(allCopy, /Embedded Pi/);
});

test("agent-facing release notes: 0.63.7 -> 0.64.0 surfaces only v0.64.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.63.7", "0.64.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.64.0"]);
});

test("agent-facing release notes: 0.40.2 -> 0.64.0 does not redeliver the baseline floor", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.40.2", "0.64.0");
  const versions = notes.map((n) => n.version);
  assert.ok(!versions.includes("0.40.2"));
  assert.ok(versions.includes("0.64.0"));
});

test("agent-facing release notice: 0.63.7 -> 0.64.0 includes built-in runtime + SDK refresh + orphan-kill + syncing-hold copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.63.7", "0.64.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /Built-in runtime v1/);
  assert.match(allCopy, /0\.80\.2/);
  assert.match(allCopy, /0\.20\.1-botiverse\.0/);
  assert.match(allCopy, /force-kills lingering child processes/);
  assert.match(allCopy, /syncing freshness-hold/);
});

test("agent-facing release notes: 0.64.0 -> 0.65.0 surfaces only v0.65.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.64.0", "0.65.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.65.0"]);
});

test("agent-facing release notes: 0.40.2 -> 0.65.0 does not redeliver the baseline floor", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.40.2", "0.65.0");
  const versions = notes.map((n) => n.version);
  assert.ok(!versions.includes("0.40.2"));
  assert.ok(versions.includes("0.65.0"));
});

test("agent-facing release notice: 0.64.0 -> 0.65.0 includes raft channel mute + pierce copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.64.0", "0.65.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /raft channel mute\|unmute/);
  assert.match(allCopy, /pierce/);
});

test("agent-facing release notes: 0.65.0 -> 0.66.0 surfaces only v0.66.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.65.0", "0.66.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.66.0"]);
});

test("agent-facing release notes: 0.40.2 -> 0.66.0 does not redeliver the baseline floor", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.40.2", "0.66.0");
  const versions = notes.map((n) => n.version);
  assert.ok(!versions.includes("0.40.2"));
  assert.ok(versions.includes("0.66.0"));
});

test("agent-facing release notice: 0.65.0 -> 0.66.0 includes admin channel CLI + integration invoke + Sonnet 5 copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.65.0", "0.66.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /raft channel create/);
  assert.match(allCopy, /raft integration invoke/);
  assert.match(allCopy, /Sonnet 5/);
});

test("agent-facing release notes: 0.66.0 -> 0.67.0 surfaces only v0.67.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.66.0", "0.67.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.67.0"]);
});

test("agent-facing release notes: 0.40.2 -> 0.67.0 does not redeliver the baseline floor", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.40.2", "0.67.0");
  const versions = notes.map((n) => n.version);
  assert.ok(!versions.includes("0.40.2"));
  assert.ok(versions.includes("0.67.0"));
});

test("agent-facing release notice: 0.66.0 -> 0.67.0 includes model catalog + provider error + resume replay copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.66.0", "0.67.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /model catalogs/);
  assert.match(allCopy, /provider errors/);
  assert.match(allCopy, /replays the messages/);
});

test("agent-facing release notes: 0.67.0 -> 0.68.0 surfaces only v0.68.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.67.0", "0.68.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.68.0"]);
});

test("agent-facing release notes: 0.40.2 -> 0.68.0 does not redeliver the baseline floor", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.40.2", "0.68.0");
  const versions = notes.map((n) => n.version);
  assert.ok(!versions.includes("0.40.2"));
  assert.ok(versions.includes("0.68.0"));
});

test("agent-facing release notice: 0.67.0 -> 0.68.0 includes clean-exit pending inbox copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.67.0", "0.68.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /pending in your inbox/);
  assert.match(allCopy, /carried across the restart/);
});

test("agent-facing release notes: 0.68.0 -> 0.69.0 surfaces only v0.69.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.68.0", "0.69.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.69.0"]);
});

test("agent-facing release notes: 0.40.2 -> 0.69.0 does not redeliver the baseline floor", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.40.2", "0.69.0");
  const versions = notes.map((n) => n.version);
  assert.ok(!versions.includes("0.40.2"));
  assert.ok(versions.includes("0.69.0"));
});

test("agent-facing release notice: 0.68.0 -> 0.69.0 includes idle-retry + review-watchdog copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.68.0", "0.69.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /retries the delivery/);
  assert.match(allCopy, /watchdog/);
});

test("agent-facing release notice: 0.68.0 -> 0.69.0 surfaces self-claim already-claimed behavior change", () => {
  const notice = getAgentDaemonReleaseNotice("0.68.0", "0.69.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /already claimed by you/);
});

test("agent-facing release notes: 0.69.0 -> 0.70.0 surfaces only v0.70.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.69.0", "0.70.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.70.0"]);
});

test("agent-facing release notice: 0.69.0 -> 0.70.0 includes canonical --target + --message-id CLI flag changes", () => {
  const notice = getAgentDaemonReleaseNotice("0.69.0", "0.70.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /`--target` is now the canonical flag/);
  assert.match(allCopy, /`--message-id`/);
  assert.match(allCopy, /attachment view/);
});

test("agent-facing release notes: 0.70.0 -> 0.70.3 surfaces only v0.70.3 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.70.0", "0.70.3");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.70.3"]);
});

test("agent-facing release notice: 0.70.0 -> 0.70.3 surfaces Kimi standing-prompt compaction-survival copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.70.0", "0.70.3");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .map((e) => e.summary)
    .join(" | ");
  assert.match(allCopy, /Kimi runtime/);
  assert.match(allCopy, /survives context compaction/);
});

test("agent-facing release notes: 0.70.3 -> 0.71.1 surfaces only v0.71.1 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.70.3", "0.71.1");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.71.1"]);
});

test("agent-facing release notice: 0.70.3 -> 0.71.1 surfaces bundled-CLI, #all-born-hidden, and Computer-prose copy", () => {
  const notice = getAgentDaemonReleaseNotice("0.70.3", "0.71.1");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .flatMap((e) => [e.summary, e.whyItMatters ?? ""])
    .join(" | ");
  // bundled CLI described by CAPABILITY (not a version number) + wrapper-lag guidance
  assert.match(allCopy, /--scope recipes/);
  assert.doesNotMatch(allCopy, /0\.0\.16/);
  assert.match(allCopy, /raft --version/);
  // new-server #all born-hidden is by design, not a bug
  assert.match(allCopy, /#all/);
  assert.match(allCopy, /by design, not a bug/);
  // Computer CLI human prose is not a stable parser contract
  assert.match(allCopy, /machine-parseable contract/);
});

test("agent-facing release notes: 0.71.1 -> 0.72.0 surfaces only v0.72.0 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.71.1", "0.72.0");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.72.0"]);
});

test("agent-facing release notice: 0.71.1 -> 0.72.0 carries forward the 0.71.1 silent-window content plus the version-alignment note", () => {
  // Fleet upgraded to 0.71.1 before the 0.71.1 notes reached prod, so that
  // notice was silently missed. The 0.72.0 entry must re-deliver those three
  // items to agents upgrading 0.71.1 -> 0.72.0.
  const notice = getAgentDaemonReleaseNotice("0.71.1", "0.72.0");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .flatMap((e) => [e.summary, e.whyItMatters ?? ""])
    .join(" | ");
  // version-scheme alignment (Computer + daemon lockstep)
  assert.match(allCopy, /0\.72\.0/);
  assert.match(allCopy, /align/i);
  // carried-forward 0.71.1 content — bundled CLI described by CAPABILITY, not a
  // version number (the entry's own lesson is "don't judge by the version").
  assert.match(allCopy, /--scope recipes/);
  assert.doesNotMatch(allCopy, /0\.0\.16/);
  assert.match(allCopy, /raft --version/);
  assert.match(allCopy, /#all/);
  assert.match(allCopy, /by design, not a bug/);
  assert.match(allCopy, /machine-parseable contract/);
});

test("agent-facing release notes: 0.72.0 -> 0.72.1 surfaces only v0.72.1 entries", () => {
  const notes = getAgentDaemonReleaseNotesBetween("0.72.0", "0.72.1");
  const versions = notes.map((n) => n.version);
  assert.deepEqual(versions, ["0.72.1"]);
});

test("agent-facing release notice: 0.72.0 -> 0.72.1 surfaces the upgrade-resume fix and carries forward the current capability items", () => {
  // 0.72.1 is the Computer self-upgrade respawn fix (the old service used to
  // exit without starting the swapped replacement, stranding the machine). It
  // also carries forward the still-relevant 0.72.0 capability items (CLI
  // recipes, #all born-hidden, Computer-prose contract) so a machine that
  // missed the 0.72.0 notice still lands them. The one-time version-scheme
  // note is intentionally dropped (stale at 0.72.1).
  const notice = getAgentDaemonReleaseNotice("0.72.0", "0.72.1");
  assert.ok(notice);
  const allCopy = notice.notes
    .flatMap((n) => n.entries)
    .flatMap((e) => [e.summary, e.whyItMatters ?? ""])
    .join(" | ");
  // the fix itself
  assert.match(allCopy, /raft-computer upgrade/);
  assert.match(allCopy, /starts the replacement service/);
  assert.match(allCopy, /manually restart/);
  assert.match(allCopy, /fresh-install/);
  // carried-forward capability items
  assert.match(allCopy, /--scope recipes/);
  assert.match(allCopy, /#all/);
  assert.match(allCopy, /machine-parseable contract/);
  // no stale version literal, and the one-time 0.0.x scheme note is dropped
  assert.doesNotMatch(allCopy, /0\.0\.16/);
  assert.doesNotMatch(allCopy, /Version-scheme change|jumps from 0\.0\.x/);
});
