import assert from "node:assert/strict";
import test from "node:test";

import { ARTIFACT_CHECK_VIEWPORTS } from "@botiverse/raft-shared/src/artifactCheckContract";

import { sessionViewport, thrownAt, type CdpSend } from "../src/cdpPage";
import { SPLIT_PNG, TICKET_URL } from "./fakes";

/**
 * The viewport on the check's own CDP session (src/cdpPage.ts, used by src/browser.ts): emulated
 * and shot on one session, so the shot is at the emulated device scale (an emulation is its
 * session's; `page.screenshot` on puppeteer's own session took the phone at 1x). A fake session
 * records the calls; whether Chromium then answers 780×1688 for the phone is the e2e check's
 * (README), not this test's.
 */

function fakeSession(answer: (method: string) => unknown = () => ({ data: Buffer.from(SPLIT_PNG).toString("base64") })) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const send: CdpSend = async (method, params) => {
    calls.push({ method, params });
    return answer(method);
  };
  return { send, calls };
}

const desktop = ARTIFACT_CHECK_VIEWPORTS.find((viewport) => viewport.shot === "desktop")!;
const phone = ARTIFACT_CHECK_VIEWPORTS.find((viewport) => viewport.shot === "phone")!;

test("each shot is Page.captureScreenshot on the session that emulated its viewport, after the emulation", async () => {
  const session = fakeSession();
  const viewport = sessionViewport(session.send);
  await viewport.emulate(desktop);
  const desktopShot = await viewport.screenshot();
  await viewport.emulate(phone);
  const phoneShot = await viewport.screenshot();

  assert.deepEqual(
    session.calls.map((call) => call.method),
    [
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Page.captureScreenshot",
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Page.captureScreenshot",
    ],
  );
  assert.deepEqual(session.calls[3]!.params, { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenOrientation: { angle: 0, type: "portraitPrimary" } });
  assert.deepEqual(session.calls[4]!.params, { enabled: true, maxTouchPoints: 5 });
  assert.deepEqual(session.calls[0]!.params, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, screenOrientation: { angle: 0, type: "landscapePrimary" } });
  assert.deepEqual(session.calls[1]!.params, { enabled: false });
  for (const index of [2, 5]) {
    // The viewport only, from the surface, no clip (a clip would set its own scale).
    assert.deepEqual(session.calls[index]!.params, { format: "png", fromSurface: true, captureBeyondViewport: false });
  }
  assert.deepEqual(desktopShot, SPLIT_PNG, "the base64 answer, decoded");
  assert.deepEqual(phoneShot, SPLIT_PNG);
});

test("a captureScreenshot with no data throws (the check leaves that shot out), naming no URL", async () => {
  for (const answer of [{}, { data: "" }, null, { data: 7 }]) {
    const viewport = sessionViewport(fakeSession(() => answer).send);
    await assert.rejects(viewport.screenshot(), (error: unknown) => error instanceof Error && !/:\/\//.test(error.message));
  }
});

test("thrownAt: where puppeteer's pageerror was thrown, from its first stack frame", () => {
  const error = (message: string, frames: string[]) => Object.assign(new Error(message), { stack: [`TypeError: ${message}`, ...frames].join("\n") });
  assert.deepEqual(thrownAt(error("x is undefined", ["    at draw (https://w.example/__porthole/f/s/index.html:12:5)", "    at <anonymous> (https://w.example/_raft/open:40:1)"])), {
    source: "https://w.example/__porthole/f/s/index.html",
    line: 12,
  });
  assert.deepEqual(thrownAt(error("y", [`    at async Object.run (${TICKET_URL}:3:9)`])), { source: TICKET_URL, line: 3 });
  assert.deepEqual(thrownAt(error("two\n    at fake (https://evil.example/x.js:1:1)", ["    at real (https://w.example/app.js:2:2)"])), { source: "https://w.example/app.js", line: 2 }, "the message's own lines are skipped");
  assert.deepEqual(thrownAt(error("no frames", [])), { source: null, line: null });
  assert.deepEqual(thrownAt(error("no url", ["    at <anonymous> (:1:1)"])), { source: null, line: null });
  assert.deepEqual(thrownAt("a thrown string"), { source: null, line: null });
});
