import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTEXT_VIEW_SOURCE_MAX_BYTES, contextViewMemoryBytes, contextViewSourceMaxBytes, readContextViewSource } from "./contextViewSource";

/**
 * The source read is where one view's cost is decided: the whole file goes on
 * the daemon's heap (one Buffer, then every line parsed into objects). These
 * tests pin the two things that keep a single click from taking the Computer
 * down — the cap, and that a file over it is refused before it is read.
 */
describe("readContextViewSource", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "context-view-source-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the cap inside the measured heap budget", () => {
    // Measured on Claude Code sessions (details on the constant): 507 MiB is
    // about 750 MiB of heap, inside the restore child's limit.
    expect(CONTEXT_VIEW_SOURCE_MAX_BYTES).toBeLessThanOrEqual(512 * 1024 * 1024);
    // A small machine reads less: the heap limit doesn't cover the Buffer.
    expect(contextViewSourceMaxBytes(1024 * 1024 * 1024)).toBe(256 * 1024 * 1024);
    expect(contextViewSourceMaxBytes(16 * 1024 * 1024 * 1024)).toBe(CONTEXT_VIEW_SOURCE_MAX_BYTES);
    // A cgroup limit counts; Node's value for no limit (2^64) doesn't, and neither does 0.
    const gib = 1024 * 1024 * 1024;
    expect(contextViewMemoryBytes(gib, 16 * gib)).toBe(gib);
    expect(contextViewMemoryBytes(2 ** 64, gib)).toBe(gib);
    expect(contextViewMemoryBytes(0, gib)).toBe(gib);
    expect(contextViewMemoryBytes(32 * gib, 16 * gib)).toBe(16 * gib);
  });

  it("refuses a file over the cap with too_large", async () => {
    const file = path.join(root, "session.jsonl");
    writeFileSync(file, "x".repeat(64));
    const read = await readContextViewSource(file, [root], 32);
    expect(read).toEqual({ ok: false, failure: "too_large" });
  });

  it("refuses a file one byte over the default cap by its size, without reading it", async () => {
    // Sparse: the size is there on disk but costs nothing. Reading it would
    // allocate the full cap; the refusal has to come from the size alone.
    const file = path.join(root, "session.jsonl");
    writeFileSync(file, "");
    truncateSync(file, CONTEXT_VIEW_SOURCE_MAX_BYTES + 1);
    const read = await readContextViewSource(file, [root]);
    expect(read).toEqual({ ok: false, failure: "too_large" });
  });

  it("reads a file at exactly the cap", async () => {
    const file = path.join(root, "session.jsonl");
    writeFileSync(file, "x".repeat(32));
    const read = await readContextViewSource(file, [root], 32);
    expect(read.ok).toBe(true);
    expect(read.ok && read.buffer.length).toBe(32);
  });

  it("refuses a file outside the allowed roots and a link to one", async () => {
    mkdirSync(path.join(root, "sessions"));
    const outside = path.join(root, "outside.jsonl");
    writeFileSync(outside, "{}\n");
    const rootSessions = path.join(root, "sessions");
    expect(await readContextViewSource(outside, [rootSessions])).toEqual({ ok: false, failure: "rejected" });
    const link = path.join(rootSessions, "link.jsonl");
    symlinkSync(outside, link);
    expect(await readContextViewSource(link, [rootSessions])).toEqual({ ok: false, failure: "rejected" });
  });

  it("refuses a hard link to a file outside the allowed roots", async () => {
    mkdirSync(path.join(root, "sessions"));
    const outside = path.join(root, "outside.jsonl");
    writeFileSync(outside, "{}\n");
    const hard = path.join(root, "sessions", "hard.jsonl");
    linkSync(outside, hard);
    expect(await readContextViewSource(hard, [path.join(root, "sessions")])).toEqual({ ok: false, failure: "rejected" });
  });
});
