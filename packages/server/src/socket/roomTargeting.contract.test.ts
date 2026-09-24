// Guard: Socket.IO `in(a).in(b)` / `to(a).to(b)` target the UNION of the
// rooms, not the intersection. A chained room target on a subscription grant
// (`socketsJoin`) or emit therefore widens the audience to every socket in the
// broader room. Send-time grants for one user's sockets in one server must use
// the single `socketUserServerRoom` room instead.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

const CHAINED_ROOM_TARGET = /\.(?:in|to)\((?:[^()]|\([^()]*\))*\)\s*\.(?:in|to)\(/gs;

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "generated") continue;
      yield* sourceFiles(full);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

test("no production code chains Socket.IO room targets (union semantics)", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const offenders: string[] = [];
  for await (const file of sourceFiles(root)) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(CHAINED_ROOM_TARGET)) {
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${path.relative(root, file)}:${line}: ${match[0].replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(offenders, [], "chained .in()/.to() room targets widen the audience to the union of rooms; use socketUserServerRoom or a single room");
});
