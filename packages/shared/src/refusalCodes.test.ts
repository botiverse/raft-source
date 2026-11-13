// The closed list of refusal codes clients may branch on (refusalCodes.ts):
// every entry is well formed, so a reviewer adding one sees what it must say.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { AGENT_API_USER_NOT_FOUND_CODE } from "./agentApiContract";
import { REFUSAL_CODE_PATTERN } from "./refusal";
import { isRefusalCode, REFUSAL_CODES, type RefusalClient, type RefusalKind } from "./refusalCodes";

const KINDS: readonly RefusalKind[] = ["wait_retry", "poll", "stale", "already_done", "auth", "client_too_old", "plan_limit", "unsupported", "terminal", "alternate"];
const CLIENTS: readonly RefusalClient[] = ["shared", "cli", "sdk", "daemon", "computer", "web"];

test("every listed code is a code, with a kind, an in-code action in one sentence, and the clients that branch on it", () => {
  const entries = Object.entries(REFUSAL_CODES);
  assert.ok(entries.length > 0);
  for (const [code, entry] of entries) {
    assert.match(code, REFUSAL_CODE_PATTERN, code);
    assert.ok(KINDS.includes(entry.kind), `${code}: kind ${entry.kind}`);
    assert.ok(entry.action.trim().length > 0 && !/[\r\n]/.test(entry.action) && /\s/.test(entry.action), `${code}: action`);
    assert.ok(entry.clients.length > 0, `${code}: clients`);
    for (const client of entry.clients) assert.ok(CLIENTS.includes(client), `${code}: client ${client}`);
    assert.equal(new Set(entry.clients).size, entry.clients.length, `${code}: a client listed twice`);
  }
  // Every kind is in use: an unused kind is a sign the list and the kinds drifted apart.
  for (const kind of KINDS) assert.ok(entries.some(([, entry]) => entry.kind === kind), `no code of kind ${kind}`);
});

test("no code is listed twice in the source (an object literal would keep only the last)", () => {
  const source = readFileSync(new URL("./refusalCodes.ts", import.meta.url), "utf8");
  const keys = [...source.matchAll(/^\s+([A-Za-z0-9_.:-]+): \{ kind:/gm)].map((match) => match[1]!);
  assert.equal(keys.length, Object.keys(REFUSAL_CODES).length);
  assert.equal(new Set(keys).size, keys.length, keys.filter((key, i) => keys.indexOf(key) !== i).join(", "));
});

test("isRefusalCode(): only listed codes, never an inherited property", () => {
  assert.equal(isRefusalCode("RATE_LIMITED"), true);
  assert.equal(isRefusalCode("TITLE_REQUIRED"), false);
  assert.equal(isRefusalCode("constructor"), false);
  assert.equal(isRefusalCode("toString"), false);
  assert.equal(isRefusalCode(undefined), false);
});

test("a code a contract constant names is listed under that same value", () => {
  // shared userInfo branches on AGENT_API_USER_NOT_FOUND_CODE (agentOps/server.ts).
  assert.equal(isRefusalCode(AGENT_API_USER_NOT_FOUND_CODE), true);
});
