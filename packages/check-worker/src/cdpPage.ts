// What browser.ts asks of Chromium in its own words: the viewport, emulated and shot on the
// check's own CDP session, and where a puppeteer `pageerror` was thrown. Puppeteer-free, so the
// tests reach it with a fake session.
//
// The viewport is emulated on the check's CDP session (`Emulation.setDeviceMetricsOverride`, not
// `page.setViewport`, which reloads the page when the mobile flag changes), and it is shot on that
// same session with `Page.captureScreenshot`. An emulation is a session's own: Chromium sizes a
// session's screenshot by that session's override, so `page.screenshot` (puppeteer's own session,
// which emulates nothing) took the phone at its CSS size and a device scale of 1 (390×844, not the
// contract's 780×1688 at 2x). Viewport only, never the full page: no clip, nothing beyond it.
import type { ArtifactCheckViewport } from "@botiverse/raft-shared/src/artifactCheckContract";

/** One CDP command on the check's own session (browser.ts passes its `CDPSession.send`). */
export type CdpSend = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export interface SessionViewport {
  /** `viewport`'s CSS size, device scale, mobile flag and orientation, and touch, on the session. */
  emulate(viewport: ArtifactCheckViewport): Promise<void>;
  /** A PNG of the viewport as last emulated on the session: its CSS size times its device scale. */
  screenshot(): Promise<Uint8Array>;
}

/** The viewport, emulated and shot on one CDP session (`send`'s): the shot is at that session's device scale. */
export function sessionViewport(send: CdpSend): SessionViewport {
  return {
    async emulate({ width, height, deviceScaleFactor, mobile }) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor,
        mobile,
        screenOrientation: mobile ? { angle: 0, type: "portraitPrimary" } : { angle: 0, type: "landscapePrimary" },
      });
      await send("Emulation.setTouchEmulationEnabled", mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    },
    async screenshot() {
      const answer = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
      const data = typeof answer === "object" && answer !== null && "data" in answer ? answer.data : undefined;
      if (typeof data !== "string" || data === "") throw new Error("Page.captureScreenshot answered no data");
      return bytesOfBase64(data);
    },
  };
}

function bytesOfBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** A frame of puppeteer's `pageerror` stack (its createClientError): `    at <name> (<url>:<line>:<column>)`, the line 1-based. */
const STACK_FRAME = /^ {4}at .* \((.+):(\d+):\d+\)$/;

/**
 * Where an exception puppeteer reported (`pageerror`) was thrown: the URL and 1-based line of its
 * first frame, else nulls (no stack, a thrown value that isn't an Error, a frame with no URL).
 * Puppeteer writes the stack as the message's lines, then one line per CDP call frame.
 */
export function thrownAt(error: unknown): { source: string | null; line: number | null } {
  if (!(error instanceof Error) || typeof error.stack !== "string") return { source: null, line: null };
  const first = error.stack.split("\n")[error.message.split("\n").length];
  const frame = first === undefined ? null : STACK_FRAME.exec(first);
  if (frame === null) return { source: null, line: null };
  const line = Number(frame[2]);
  return { source: frame[1]!, line: Number.isSafeInteger(line) ? line : null };
}
