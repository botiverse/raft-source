import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AppWebhookConfigError,
  isPublicWebhookAddress,
  normalizeAppWebhookEndpoint,
} from "./appWebhookConfigService.js";

test("webhook endpoints require credential-free public HTTPS", () => {
  assert.equal(
    normalizeAppWebhookEndpoint(" https://hooks.example.com/raft?source=test#fragment "),
    "https://hooks.example.com/raft?source=test",
  );
  for (const endpoint of [
    "http://hooks.example.com/raft",
    "https://user:pass@hooks.example.com/raft",
    "https://localhost/raft",
    "https://api.localhost/raft",
    "https://127.0.0.1/raft",
    "https://10.0.0.1/raft",
    "https://169.254.169.254/raft",
    "https://[::1]/raft",
    "https://[::169.254.169.254]/raft",
    "https://[::127.0.0.1]/raft",
    "https://[::a9fe:a9fe]/raft",
    "https://[::7f00:1]/raft",
    "https://[fd00::1]/raft",
  ]) {
    assert.throws(() => normalizeAppWebhookEndpoint(endpoint), AppWebhookConfigError, endpoint);
  }
});

test("resolved webhook addresses reject private and special-use ranges", () => {
  const rejected = [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "::",
    "::1",
    "64:ff9b::1",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
    "5f00::1",
    "fc00::1",
    "fe80::1%en0",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:192.0.2.1",
    "::a9fe:a9fe",
    "::7f00:1",
  ];
  for (const address of rejected) assert.equal(isPublicWebhookAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicWebhookAddress(address), true, address);
  }
});
