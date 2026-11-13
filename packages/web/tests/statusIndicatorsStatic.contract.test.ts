/**
 * Contract (task #136): agent status indicators never run an infinite animation.
 *
 * Status dots mark AMBIENT state. An infinite pulse on any of them keeps
 * Chromium producing frames at display refresh rate for as long as an agent
 * works; under a full-window blurred modal each frame is ~3x more expensive.
 * Controlled CDP measurement on live staging (12 working dots): modal open
 * 144 fps / 80% GPU main thread; only the dots paused → 2 fps / 3%.
 * Raft Design System: status lights never animate, so the allowlist of
 * bounded waits that may pulse is empty (AddMachineDialog's "waiting for
 * connection" banner left it; since raft-ui 0.22 that banner leads with a
 * Spinner, not a status light). Add a site only with a product decision.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "vitest";
import { AGENT_ACTIVITIES } from "@botiverse/raft-shared";
import { activityPresence } from "../src/utils/activity";

const src = resolve(import.meta.dirname, "../src");
const ALLOWED_PULSE_SITES = new Set<string>();

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

test("every activity maps to one of the five fixed presence lights (never an animation)", () => {
  const lights = new Set(["online", "busy", "error", "offline", "external"]);
  for (const activity of AGENT_ACTIVITIES) {
    assert.ok(lights.has(activityPresence(activity)), activity);
  }
});

test("no status indicator is rendered with `pulse` outside the explicit allowlist", () => {
  const offenders: string[] = [];
  for (const file of walk(src)) {
    const rel = relative(src, file);
    if (ALLOWED_PULSE_SITES.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    // <StatusDot …pulse…>, <AgentActivityDot …pulse…>, raft-ui <Status …pulse…>, incl. multi-line JSX.
    for (const m of text.matchAll(/<(StatusDot|AgentActivityDot|Status)\b([^>]*)>/g)) {
      if (/(^|\s)pulse(\s|=|\/|$)/.test(m[2])) offenders.push(`${rel}: <${m[1]} … pulse>`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("raft-ui LiveAgentActivityBarStatus defaults to pulse: true — any use must opt out explicitly", () => {
  const offenders: string[] = [];
  for (const file of walk(src)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/<LiveAgentActivityBarStatus\b([^>]*)>/g)) {
      if (!/pulse=\{false\}/.test(m[1])) offenders.push(relative(src, file));
    }
  }
  assert.deepEqual(offenders, []);
});

