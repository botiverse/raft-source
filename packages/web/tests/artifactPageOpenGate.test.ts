// How often a page may open Raft's comment box (or the fork question) by itself, now that no proof
// of a click is asked of it (xxchan, #proj-workspace:#271; Tenny's condition on the change).
import assert from "node:assert/strict";

import { PAGE_COMMENT_COOLDOWN_MS } from "../src/apps/artifacts/artifactPageComments";
import { createPageOpenGate, PAGE_OPEN_FORGET_MS, PAGE_OPEN_FREE_CLOSES, PAGE_OPEN_WAITS_MS } from "../src/apps/artifacts/artifactPageOpenGate";

test("at most one open a second, whatever the person does with it", () => {
  const gate = createPageOpenGate();
  assert.equal(gate.ask(0, false), true, "the first");
  assert.equal(gate.ask(PAGE_COMMENT_COOLDOWN_MS - 1, true), false);
  assert.equal(gate.ask(PAGE_COMMENT_COOLDOWN_MS, true), true, "its own box, still open: moved, a second later");
});

test("closed with nothing done in it: three in a row are free, then 4 s, 16 s, a minute, and a minute from then on", () => {
  const gate = createPageOpenGate();
  let now = 0;
  // Each open is closed by the person before the next ask (`stillOpen` false), a second apart.
  for (let i = 0; i < PAGE_OPEN_FREE_CLOSES; i += 1) {
    assert.equal(gate.ask(now, false), true, `open ${i + 1}`);
    now += PAGE_COMMENT_COOLDOWN_MS;
  }
  for (const wait of [...PAGE_OPEN_WAITS_MS, PAGE_OPEN_WAITS_MS.at(-1)!]) {
    const last = now - PAGE_COMMENT_COOLDOWN_MS;
    assert.equal(gate.ask(now, false), false, `a second after the last: held for ${wait} ms`);
    assert.equal(gate.ask(last + wait - 1, false), false);
    assert.equal(gate.ask(last + wait, false), true, `${wait} ms after the last open`);
    now = last + wait + PAGE_COMMENT_COOLDOWN_MS;
  }
});

test("a refused ask counts nothing: asking often while held back doesn't lengthen the wait", () => {
  const gate = createPageOpenGate();
  for (let i = 0; i < PAGE_OPEN_FREE_CLOSES; i += 1) assert.equal(gate.ask(i * PAGE_COMMENT_COOLDOWN_MS, false), true);
  const last = (PAGE_OPEN_FREE_CLOSES - 1) * PAGE_COMMENT_COOLDOWN_MS;
  for (let at = last + 100; at < last + PAGE_OPEN_WAITS_MS[0]!; at += 100) assert.equal(gate.ask(at, false), false);
  assert.equal(gate.ask(last + PAGE_OPEN_WAITS_MS[0]!, false), true, "still the first wait");
});

test("the person acting in what was opened ends the count; so do two minutes without an open; the page moving its own box is no close", () => {
  const acted = createPageOpenGate();
  for (let i = 0; i < PAGE_OPEN_FREE_CLOSES; i += 1) assert.equal(acted.ask(i * PAGE_COMMENT_COOLDOWN_MS, false), true);
  acted.acted();
  assert.equal(acted.ask(PAGE_OPEN_FREE_CLOSES * PAGE_COMMENT_COOLDOWN_MS, false), true, "they used the last one");
  assert.equal(acted.ask((PAGE_OPEN_FREE_CLOSES + 1) * PAGE_COMMENT_COOLDOWN_MS, false), true, "and the count starts over");

  const forgot = createPageOpenGate();
  for (let i = 0; i < PAGE_OPEN_FREE_CLOSES; i += 1) assert.equal(forgot.ask(i * PAGE_COMMENT_COOLDOWN_MS, false), true);
  const later = PAGE_OPEN_FREE_CLOSES * PAGE_COMMENT_COOLDOWN_MS + PAGE_OPEN_FORGET_MS;
  assert.equal(forgot.ask(later, false), true);
  assert.equal(forgot.ask(later + PAGE_COMMENT_COOLDOWN_MS, false), true, "one close counted since, not four");

  const moved = createPageOpenGate();
  for (let i = 0; i < PAGE_OPEN_FREE_CLOSES + 3; i += 1) assert.equal(moved.ask(i * PAGE_COMMENT_COOLDOWN_MS, i > 0), true, "its own box, moved each second");
});
