import "./helpers/domSetup";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import {
  createInlineAudioKeepAliveScope,
  keepInlineAudioPlaying,
  releaseInlineAudioKeepAliveScope,
  resumeKeptInlineAudio,
} from "../src/utils/inlineAudioKeepAlive";

// The virtual timeline unmounts a row scrolled far out of view: an inline
// audio player playing there must play on, and pick up where it is when the
// row comes back. Its timeline going away stops it (the timeline-level
// behaviour: inlineAudioTimelineScope.behavior.test.tsx (removed in the 2026-11 web DOM test prune)).

function audioElement({ paused }: { paused: boolean }) {
  const audio = document.createElement("audio");
  let isPaused = paused;
  Object.defineProperty(audio, "paused", { configurable: true, get: () => isPaused });
  Object.defineProperty(audio, "ended", { configurable: true, get: () => false });
  const calls = { play: 0, pause: 0 };
  audio.play = () => {
    calls.play += 1;
    isPaused = false;
    return Promise.resolve();
  };
  audio.pause = () => {
    calls.pause += 1;
    if (isPaused) return;
    isPaused = true;
    audio.dispatchEvent(new window.Event("pause"));
  };
  return { audio, calls };
}

afterEach(() => {
  document.body.innerHTML = "";
});

test("a playing player that unmounts keeps playing, and its next mount takes it over", () => {
  const scope = createInlineAudioKeepAliveScope();
  const row = document.createElement("div");
  document.body.appendChild(row);
  const playing = audioElement({ paused: false });
  row.appendChild(playing.audio);
  playing.audio.currentTime = 42;
  playing.audio.volume = 0.4;

  // Unmount (before React removes the row): moved out of the row, not paused.
  keepInlineAudioPlaying(scope, "attachment-1", playing.audio);
  row.remove();
  assert.ok(playing.audio.isConnected, "still in the document");
  assert.ok(!row.contains(playing.audio));
  assert.equal(playing.calls.pause, 0);
  assert.equal(scope.kept.size, 1);

  // Mounted again: the new element plays from the same place.
  const next = audioElement({ paused: true });
  document.body.appendChild(next.audio);
  assert.equal(resumeKeptInlineAudio(scope, "attachment-1", next.audio), true);
  assert.equal(next.audio.currentTime, 42);
  assert.equal(next.audio.volume, 0.4);
  assert.equal(next.calls.play, 1);
  next.audio.dispatchEvent(new window.Event("playing"));
  assert.ok(!playing.audio.isConnected, "the kept element is dropped once the new one plays");
  assert.equal(scope.kept.size, 0);
});

test("a paused player is not kept, and a kept one that stops is dropped", () => {
  const scope = createInlineAudioKeepAliveScope();
  const paused = audioElement({ paused: true });
  document.body.appendChild(paused.audio);
  keepInlineAudioPlaying(scope, "attachment-2", paused.audio);
  assert.equal(scope.kept.size, 0);

  const playing = audioElement({ paused: false });
  document.body.appendChild(playing.audio);
  keepInlineAudioPlaying(scope, "attachment-3", playing.audio);
  assert.equal(scope.kept.size, 1);
  playing.audio.pause();
  assert.equal(scope.kept.size, 0);
  assert.ok(!playing.audio.isConnected);
  assert.equal(resumeKeptInlineAudio(scope, "attachment-3", audioElement({ paused: true }).audio), false);
});

test("releasing a scope stops and removes what it keeps, and keeps nothing after", () => {
  const scope = createInlineAudioKeepAliveScope();
  const kept = audioElement({ paused: false });
  document.body.appendChild(kept.audio);
  keepInlineAudioPlaying(scope, "attachment-4", kept.audio);
  assert.equal(scope.kept.size, 1);

  releaseInlineAudioKeepAliveScope(scope);
  assert.equal(kept.calls.pause, 1);
  assert.ok(!kept.audio.isConnected);
  assert.equal(scope.kept.size, 0);

  // A row of the released timeline unmounting after it: stopped, not kept.
  const late = audioElement({ paused: false });
  document.body.appendChild(late.audio);
  keepInlineAudioPlaying(scope, "attachment-5", late.audio);
  assert.equal(late.calls.pause, 1);
  assert.equal(scope.kept.size, 0);

  // Outside a virtual timeline there is no scope: nothing is kept.
  const unscoped = audioElement({ paused: false });
  document.body.appendChild(unscoped.audio);
  keepInlineAudioPlaying(null, "attachment-6", unscoped.audio);
  assert.equal(resumeKeptInlineAudio(null, "attachment-6", audioElement({ paused: true }).audio), false);
});
