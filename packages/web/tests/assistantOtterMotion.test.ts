// The otter's looping and moving motion (#proj-assistant:#24; Jasper's exception
// to "status never loops", Tenny's ask): with reduced motion nothing loops and
// nothing flies or wakes, only its place changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, test, vi } from "vitest";
import { playOtterFlight, playOtterLanding } from "../src/assistant/assistantOtterEdgeArt";

const css = readFileSync(resolve(__dirname, "../src/index.css"), "utf8");

/** The body of every `@media (prefers-reduced-motion: reduce)` block. */
function reducedBlocks(source: string): string {
  const out: string[] = [];
  const marker = "@media (prefers-reduced-motion: reduce)";
  for (let i = source.indexOf(marker); i !== -1; i = source.indexOf(marker, i + 1)) {
    let depth = 0;
    let start = -1;
    for (let j = source.indexOf("{", i); j < source.length; j++) {
      if (source[j] === "{") { depth++; if (start === -1) start = j + 1; }
      if (source[j] === "}") { depth--; if (depth === 0) { out.push(source.slice(start, j)); break; } }
    }
  }
  return out.join("\n");
}

test("reduced motion stops the breathing, the z's and the wake", () => {
  const reduced = reducedBlocks(css);
  assert.match(reduced, /\.assistant-otter-breathe\s*\{\s*animation:\s*none/);
  assert.match(reduced, /\.assistant-otter-zzz > span\s*\{\s*animation:\s*none/);
  assert.match(reduced, /\.assistant-otter-wake\s*\{\s*animation:\s*none/);
  // One still z stays: the others are hidden.
  assert.match(reduced, /\.assistant-otter-zzz > span:nth-child\(n \+ 2\)\s*\{\s*display:\s*none/);
});

afterEach(() => vi.unstubAllGlobals());

function element() {
  const calls: unknown[] = [];
  return { calls, el: { animate: (...args: unknown[]) => { calls.push(args); return { onfinish: null }; }, getAnimations: () => [] } as unknown as HTMLElement };
}

test("with reduced motion it neither flies nor squashes; without, it does", () => {
  vi.stubGlobal("window", { matchMedia: (q: string) => ({ matches: q.includes("reduce") }) });
  const still = element();
  playOtterFlight(still.el, 200, -80, "up");
  playOtterLanding(still.el, "right");
  assert.equal(still.calls.length, 0);

  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  const moving = element();
  playOtterFlight(moving.el, 200, -80, "up");
  assert.equal(moving.calls.length, 1, "the arc");
  playOtterFlight(moving.el, 1, 1, "up");
  assert.equal(moving.calls.length, 1, "a move under 2px does not fly");
});
