import assert from "node:assert/strict";

import { shouldBypassProxy } from "./noProxy";

test("shouldBypassProxy: no NO_PROXY means every target uses the proxy", () => {
  assert.equal(shouldBypassProxy("https://api.raft.example/x", {}), false);
  assert.equal(shouldBypassProxy("https://api.raft.example/x", { NO_PROXY: "" }), false);
});

test("shouldBypassProxy: hosts, domain suffixes and wildcards, case-insensitive", () => {
  const env = { NO_PROXY: " localhost , .internal,*.corp.example,Example.COM" };
  assert.equal(shouldBypassProxy("http://LOCALHOST:3000/", env), true);
  assert.equal(shouldBypassProxy("https://a.b.internal/", env), true);
  assert.equal(shouldBypassProxy("https://internal/", env), true);
  assert.equal(shouldBypassProxy("https://x.corp.example/", env), true);
  assert.equal(shouldBypassProxy("https://www.example.com/", env), true);
  assert.equal(shouldBypassProxy("https://notexample.com/", env), false);
  assert.equal(shouldBypassProxy("https://api.raft.example/", env), false);
  assert.equal(shouldBypassProxy("https://anything/", { no_proxy: "*" }), true);
});

test("shouldBypassProxy: a port in the rule must match the target's port, defaulted by scheme", () => {
  const env = { NO_PROXY: "raft.example:443" };
  assert.equal(shouldBypassProxy("https://raft.example/", env), true);
  assert.equal(shouldBypassProxy("wss://raft.example/ws", env), true);
  assert.equal(shouldBypassProxy("http://raft.example/", env), false);
  assert.equal(shouldBypassProxy("https://raft.example:8443/", env), false);
  assert.equal(shouldBypassProxy("ws://raft.example/", { NO_PROXY: "raft.example:80" }), true);
});

test("shouldBypassProxy: NO_PROXY wins over no_proxy when both are set", () => {
  assert.equal(shouldBypassProxy("https://a.example/", { NO_PROXY: "b.example", no_proxy: "a.example" }), false);
});
