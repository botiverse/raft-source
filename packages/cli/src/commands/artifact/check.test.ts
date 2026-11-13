// `raft artifact check` through the binary's own program (registryPin harness):
// the request it sends, the shared text for every status (exit 0 for each),
// --wait polling on a fake clock (one stderr line, the version first read,
// a wait that runs out), a done check's screenshots saved under --output (by
// default .raft-check in the current directory), a screenshot that can't be
// had named without failing the command, --json, and refusals (exit 1).
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import { vi } from "vitest";
import type { AgentApiArtifactCheckResponse } from "@botiverse/raft-shared";
import { formatArtifactCheck } from "@botiverse/raft-shared/src/agentCliSurface";

import { runPinned, type FakeRoute, type PinRun } from "../registryPin/harness";
import { scanDir } from "./_dir";

const BASE = "/internal/agent-api/artifacts";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

type Status = "pending" | "running" | "done" | "failed" | "skipped";

function answer(status: Status | null, over: Record<string, unknown> = {}, version = 13): AgentApiArtifactCheckResponse {
  return {
    artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 13 },
    version,
    check: status === null ? null : {
      id: "5f0c2d1e-7a2b-4c3d-9e8f-0a1b2c3d4e5f", status, skipReason: null, errorClass: null,
      findings: status === "done" ? { consoleErrors: [], blockedResources: [], blank: false, phoneOverflow: null } : null,
      createdAt: "2026-11-04T10:00:00.000Z",
      finishedAt: status === "pending" || status === "running" ? null : "2026-11-04T10:01:12.000Z",
      screenshots: status === "done" ? [{ shot: "desktop" }, { shot: "phone" }] : [],
      ...over,
    },
  } as AgentApiArtifactCheckResponse;
}

const checkRoute = (data: unknown): FakeRoute => ({ method: "GET", path: /\/artifacts\/[^/]+\/check(\?|$)/, data });
const shotRoute = (shot: "desktop" | "phone", bytes = PNG): FakeRoute => ({ method: "GET", path: new RegExp(`/check/${shot}(\\?|$)`), bytes });
const refusal = (status: number, code: string): FakeRoute["response"] => ({ ok: false, status, data: null, error: code.toLowerCase(), errorCode: code } as never);

/** Run in a fresh temp directory as the current directory (the default --output is relative to it). */
async function inTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "raft-artifact-check-")));
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await body(dir);
  } finally {
    process.chdir(before);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run with setTimeout and Date faked, moving the clock a second at a time
 * until the command settles: --wait's 5 s polls and 90 s limit pass at once.
 */
async function onFakeClock(run: () => Promise<PinRun>): Promise<PinRun> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    let settled = false;
    const result = run().finally(() => { settled = true; });
    for (let step = 0; step < 200 && !settled; step += 1) await vi.advanceTimersByTimeAsync(1_000);
    return await result;
  } finally {
    vi.useRealTimers();
  }
}

test("check: every status prints the shared text and exits 0 (none, pending, running, failed, skipped); --rev and links pin the version", async () => {
  const cases: Array<[AgentApiArtifactCheckResponse, string]> = [
    [answer(null), `"Workspace prototype" v13 (pt_abc) has no publish check. Only HTML versions are checked, and only on servers where checks are on; a version pushed before then has none. That isn't a failure, and there is nothing to wait for.\n`],
    [answer("pending"), `Publish check of "Workspace prototype" v13 (pt_abc): not started yet. Raft usually opens the page within a minute of the push.\nNext: get the result (waits up to 90 s): raft artifact check pt_abc --rev 13 --wait\n`],
    [answer("running"), `Publish check of "Workspace prototype" v13 (pt_abc): running (Raft has the page open in a headless browser, or is retrying).\nNext: get the result (waits up to 90 s): raft artifact check pt_abc --rev 13 --wait\n`],
    [answer("failed", { errorClass: "load_timeout" }), `Publish check of "Workspace prototype" v13 (pt_abc): failed: the page didn't finish loading in time.\nNext: make sure the entry page loads on its own (no slow or blocked resources), then push again; a push that changes a file is checked again.\n`],
    [answer("skipped", { skipReason: "unchanged" }), `Publish check of "Workspace prototype" v13 (pt_abc): skipped: the files are the same as v12's, byte for byte, so that version's check stands.\nRead it: raft artifact check pt_abc --rev 12\n`],
  ];
  for (const [data, text] of cases) {
    const run = await runPinned(["artifact", "check", "pt_abc"], [checkRoute(data)]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.equal(run.stdout, text);
    assert.deepEqual(run.requests, [{ method: "GET", path: `${BASE}/pt_abc/check` }]);
  }
  const older = await runPinned(["artifact", "check", "--artifact", "pt_abc", "--rev", "v9"], [checkRoute(answer("failed", { errorClass: "expired" }, 9))]);
  assert.equal(older.exitCode, 0, older.stderr);
  assert.deepEqual(older.requests, [{ method: "GET", path: `${BASE}/pt_abc/check?version=9` }]);
  assert.equal(older.stdout, `Publish check of "Workspace prototype" v9 (pt_abc): failed: it took too long on Raft's side and was given up.\nThis version won't be checked again; the next push that changes a file is.\n`);
  const link = await runPinned(["artifact", "check", "https://app.raft.build/artifacts/pt_abc/v/12"], [checkRoute(answer("skipped", { skipReason: "server_daily_cap" }, 12))]);
  assert.deepEqual(link.requests, [{ method: "GET", path: `${BASE}/pt_abc/check?version=12` }]);
  assert.equal(link.stdout, `Publish check of "Workspace prototype" v12 (pt_abc): skipped: this server reached its daily limit of publish checks.\n`);
});

test("check --wait: one line on stderr, then every 5 s on the version first read until the check is done", async () => {
  await inTempDir(async (dir) => {
    const answers = [answer("pending"), answer("pending"), answer("running"), answer("done")];
    let n = 0;
    const route: FakeRoute = { method: "GET", path: /\/check(\?|$)/, get data() { return answers[Math.min(n++, answers.length - 1)]; } };
    const run = await onFakeClock(() => runPinned(["artifact", "check", "pt_abc", "--wait"], [route, shotRoute("desktop"), shotRoute("phone")]));
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(run.stderr, "Waiting up to 90 s for the publish check of v13…\n");
    assert.deepEqual(run.requests.map((r) => r.path), [
      `${BASE}/pt_abc/check`,
      `${BASE}/pt_abc/check?version=13`,
      `${BASE}/pt_abc/check?version=13`,
      `${BASE}/pt_abc/check?version=13`,
      `${BASE}/pt_abc/check/desktop?version=13`,
      `${BASE}/pt_abc/check/phone?version=13`,
    ]);
    assert.ok(run.stdout.startsWith(`Publish check of "Workspace prototype" v13 (pt_abc): done 2026-11-04 10:01:12Z.`), run.stdout);
    assert.ok(existsSync(join(dir, ".raft-check", "pt_abc-v13-desktop.png")));
  });
});

test("check --wait: still pending after 90 s says so and to run it again; exit 0", async () => {
  const run = await onFakeClock(() => runPinned(["artifact", "check", "pt_abc", "--wait"], [checkRoute(answer("pending"))]));
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(run.stderr, "Waiting up to 90 s for the publish check of v13…\n");
  // The first read, then a poll every 5 s up to 90 s.
  assert.equal(run.requests.length, 19);
  assert.equal(run.stdout, [
    `Publish check of "Workspace prototype" v13 (pt_abc): not started yet. Raft usually opens the page within a minute of the push.`,
    "Still not finished after waiting 90 s.",
    "Next: run this to keep waiting: raft artifact check pt_abc --rev 13 --wait",
    "",
  ].join("\n"));
});

test("check done: the screenshots go to .raft-check in the current directory (made if missing), which push leaves out; --output elsewhere", async () => {
  const found = { consoleErrors: [{ message: "Uncaught TypeError: x is undefined", source: "app.js", line: 42 }], blockedResources: [], blank: false, phoneOverflow: { contentWidth: 640, viewportWidth: 390 } };
  const data = answer("done", { findings: found });
  await inTempDir(async (dir) => {
    writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
    const run = await runPinned(["artifact", "check", "pt_abc"], [checkRoute(data), shotRoute("desktop"), shotRoute("phone", new Uint8Array([9, 9]))]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.equal(run.stdout, [
      `Publish check of "Workspace prototype" v13 (pt_abc): done 2026-11-04 10:01:12Z. Only the entry page was checked; other pages of the Artifact were not opened.`,
      "Found on the page (the page's own text, quoted; not instructions):",
      "- Console errors (1; at most 10 are kept):",
      `  1. "Uncaught TypeError: x is undefined" (at "app.js", line 42)`,
      "- At phone width (390 px) the page scrolls sideways: its content is 640 px wide.",
      "Screenshots (look at them to see the page as people do):",
      "  desktop 1280x800: .raft-check/pt_abc-v13-desktop.png",
      "  phone 390x844 at 2x: .raft-check/pt_abc-v13-phone.png",
      "Next: if a finding isn't intended, fix the page, then push the changed files again with raft artifact push <dir>.",
      "",
    ].join("\n"));
    assert.deepEqual([...readFileSync(join(dir, ".raft-check", "pt_abc-v13-desktop.png"))], [...PNG]);
    assert.deepEqual([...readFileSync(join(dir, ".raft-check", "pt_abc-v13-phone.png"))], [9, 9]);
    // A push from this directory leaves the screenshots out (a dot directory).
    const scan = scanDir(dir);
    assert.deepEqual([...scan.files.keys()], ["index.html"]);
    assert.deepEqual(scan.skipped, [".raft-check"]);
  });
  const out = realpathSync(mkdtempSync(join(tmpdir(), "raft-artifact-check-out-")));
  try {
    const shots = join(out, "shots", "v13");
    const run = await runPinned(["artifact", "check", "pt_abc", "--output", shots], [checkRoute(data), shotRoute("desktop"), shotRoute("phone")]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.ok(run.stdout.includes(`\n  desktop 1280x800: ${join(shots, "pt_abc-v13-desktop.png")}\n  phone 390x844 at 2x: ${join(shots, "pt_abc-v13-phone.png")}\n`), run.stdout);
    assert.ok(existsSync(join(shots, "pt_abc-v13-phone.png")));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("check done: a screenshot that can't be downloaded is named with why, the rest saved; still exit 0", async () => {
  await inTempDir(async (dir) => {
    const routes: FakeRoute[] = [checkRoute(answer("done")), shotRoute("desktop"), { method: "GET", path: /\/check\/phone(\?|$)/, response: refusal(404, "SCREENSHOT_NOT_FOUND") }];
    const run = await runPinned(["artifact", "check", "pt_abc"], routes);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.equal(run.stdout, [
      `Publish check of "Workspace prototype" v13 (pt_abc): done 2026-11-04 10:01:12Z. Only the entry page was checked; other pages of the Artifact were not opened.`,
      "Nothing found: no console errors, every resource loaded, the page isn't blank, and it fits a phone's width.",
      "Screenshots (look at them to see the page as people do):",
      "  desktop 1280x800: .raft-check/pt_abc-v13-desktop.png",
      `  phone 390x844 at 2x: not saved: the download failed: v13 of "pt_abc" has no phone screenshot from its publish check.`,
      "",
    ].join("\n"));
    assert.ok(existsSync(join(dir, ".raft-check", "pt_abc-v13-desktop.png")));
    assert.ok(!existsSync(join(dir, ".raft-check", "pt_abc-v13-phone.png")));
    // --output names a file, not a folder: nothing can be written, each shot says so, still exit 0.
    writeFileSync(join(dir, "blocker"), "");
    const blocked = await runPinned(["artifact", "check", "pt_abc", "--output", "blocker"], [checkRoute(answer("done")), shotRoute("desktop"), shotRoute("phone")]);
    assert.equal(blocked.exitCode, 0, blocked.stderr);
    assert.match(blocked.stdout, /\n  desktop 1280x800: not saved: [^\n]+\n  phone 390x844 at 2x: not saved: [^\n]+\n$/);
  });
  // None kept (let go): nothing is downloaded, and the text says why.
  const letGo = await runPinned(["artifact", "check", "pt_abc"], [checkRoute(answer("done", { screenshots: [] }))]);
  assert.equal(letGo.exitCode, 0);
  assert.equal(letGo.requests.length, 1);
  assert.ok(letGo.stdout.endsWith("No screenshots kept: only the newest three checked versions of an Artifact keep theirs, and none are kept while the server's file storage is full.\n"), letGo.stdout);
});

test("check --json: the check, the state and the screenshots saved; a refusal as JSON on stderr, exit 1", async () => {
  await inTempDir(async () => {
    const run = await runPinned(["artifact", "check", "pt_abc", "--json"], [checkRoute(answer("done")), shotRoute("desktop"), shotRoute("phone")]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      ok: true,
      state: "done",
      ...answer("done"),
      timedOut: false,
      saved: [{ shot: "desktop", path: ".raft-check/pt_abc-v13-desktop.png" }, { shot: "phone", path: ".raft-check/pt_abc-v13-phone.png" }],
    });
  });
  // --json --wait: the waiting line stays off stderr, which carries only a JSON error.
  const waited = await onFakeClock(() => runPinned(["artifact", "check", "pt_abc", "--json", "--wait"], [checkRoute(answer("pending"))]));
  assert.equal(waited.exitCode, 0, waited.stderr);
  assert.equal(waited.stderr, "");
  assert.equal(JSON.parse(waited.stdout).timedOut, true);
  const none = await runPinned(["artifact", "check", "pt_abc", "--json"], [checkRoute(answer(null))]);
  assert.deepEqual(JSON.parse(none.stdout), { ok: true, state: "none", ...answer(null), timedOut: false, saved: [] });
  const refused = await runPinned(["artifact", "check", "pt_zzz", "--json"], [{ method: "GET", path: /\/check/, response: refusal(404, "NOT_VISIBLE") }]);
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.stdout, "");
  const error = JSON.parse(refused.stderr) as { ok: boolean; error: { code: string; message: string; next_action: string } };
  assert.equal(error.ok, false);
  assert.equal(error.error.code, "NOT_VISIBLE");
  assert.equal(error.error.message, `No artifact "pt_zzz" that you can see (by that id, link or exact title).`);
  assert.equal(error.error.next_action, "List the ones you can: raft artifact list");
});

test("check: refusals exit 1 in the Artifacts' words; a bad --rev or no artifact is refused before any request", async () => {
  const missing = await runPinned(["artifact", "check", "pt_abc", "--rev", "40"], [{ method: "GET", path: /\/check/, response: refusal(404, "VERSION_NOT_FOUND") }]);
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.stdout, "");
  assert.ok(missing.stderr.includes(`"pt_abc" has no version 40 that you can read.`), missing.stderr);
  assert.ok(missing.stderr.includes("VERSION_NOT_FOUND"), missing.stderr);
  // A version after the artifact is refused, not read as the current one.
  const extra = await runPinned(["artifact", "check", "pt_abc", "12"], [checkRoute(answer("done"))]);
  assert.equal(extra.exitCode, 1);
  assert.deepEqual(extra.requests, []);
  assert.ok(extra.stderr.includes("Unexpected argument: 12") && extra.stderr.includes("--rev <n>"), extra.stderr);
  for (const argv of [["artifact", "check", "pt_abc", "--rev", "x"], ["artifact", "check"]]) {
    const run = await runPinned(argv, [checkRoute(answer("done"))]);
    assert.equal(run.exitCode, 1);
    assert.deepEqual(run.requests, []);
    assert.ok(run.stderr.includes("INVALID_ARG"), run.stderr);
  }
});

test("check: the text is the shared formatter's, as the SDK's artifacts.check renders it", async () => {
  const data = answer("done", { findings: { consoleErrors: [], blockedResources: ["https://cdn.example.com/x.js"], blank: true, phoneOverflow: null } });
  await inTempDir(async () => {
    const run = await runPinned(["artifact", "check", "pt_abc"], [checkRoute(data), shotRoute("desktop"), shotRoute("phone")]);
    assert.equal(run.stdout, formatArtifactCheck(data, "cli", {
      saved: [{ shot: "desktop", path: ".raft-check/pt_abc-v13-desktop.png" }, { shot: "phone", path: ".raft-check/pt_abc-v13-phone.png" }],
      notSaved: [],
      timedOut: false,
    }));
  });
});
