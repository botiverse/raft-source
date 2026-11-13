import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveServerSwitch } from "../src/utils/serverSwitchTarget";

// Task #139: ⌘1…⌘9 send { serverId }, ⌘⇧[ / ⌘⇧] send { delta } (switch-server host commands), resolved in switcher order.

const servers = [
  { id: "a", slug: "alpha" },
  { id: "b", slug: "beta" },
  { id: "c", slug: "gamma" },
];

test("a direct pick lands on that server; the current one, an unknown id or junk is a no-op", () => {
  assert.equal(resolveServerSwitch(servers, "a", { serverId: "c" })?.slug, "gamma");
  assert.equal(resolveServerSwitch(servers, "a", { serverId: "a" }), null);
  assert.equal(resolveServerSwitch(servers, "a", { serverId: "zzz" }), null);
  for (const junk of [null, undefined, 1, "b", {}, { delta: 2 }, { delta: "1" }]) assert.equal(resolveServerSwitch(servers, "a", junk), null, String(JSON.stringify(junk)));
});

test("next / previous step in switcher order and wrap around", () => {
  assert.equal(resolveServerSwitch(servers, "a", { delta: 1 })?.id, "b");
  assert.equal(resolveServerSwitch(servers, "c", { delta: 1 })?.id, "a");
  assert.equal(resolveServerSwitch(servers, "a", { delta: -1 })?.id, "c");
  assert.equal(resolveServerSwitch(servers, "b", { delta: -1 })?.id, "a");
});

test("stepping with no current server starts at an end; one or zero servers never moves", () => {
  assert.equal(resolveServerSwitch(servers, null, { delta: 1 })?.id, "a");
  assert.equal(resolveServerSwitch(servers, null, { delta: -1 })?.id, "c");
  assert.equal(resolveServerSwitch([servers[0]], "a", { delta: 1 }), null);
  assert.equal(resolveServerSwitch([], null, { delta: 1 }), null);
});
