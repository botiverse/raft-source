import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";

const webRoot = resolve(import.meta.dirname, "..");

type HeaderRule = {
  pattern: string;
  lines: string[];
};

function loadHeaderRules(): HeaderRule[] {
  const source = readFileSync(resolve(webRoot, "public/_headers"), "utf8");
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;

  for (const rawLine of source.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    if (!rawLine.startsWith(" ") && !rawLine.startsWith("\t")) {
      current = { pattern: rawLine.trim(), lines: [] };
      rules.push(current);
      continue;
    }
    assert.ok(current, `header line has no route: ${rawLine}`);
    current.lines.push(rawLine.trim());
  }

  return rules;
}

function matchHeaderPattern(pattern: string, pathname: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(pathname);
}

function headersForPath(pathname: string): Map<string, string> {
  const headers = new Map<string, string>();

  for (const rule of loadHeaderRules()) {
    if (!matchHeaderPattern(rule.pattern, pathname)) continue;
    for (const line of rule.lines) {
      if (line.startsWith("! ")) {
        headers.delete(line.slice(2).toLowerCase());
        continue;
      }

      const separator = line.indexOf(":");
      assert.notEqual(separator, -1, `invalid header line: ${line}`);
      headers.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim());
    }
  }

  return headers;
}

describe("Cloudflare Pages cache headers", () => {
  test("keeps the app shell revalidated for root and deep SPA routes", () => {
    assert.equal(headersForPath("/").get("cache-control"), "no-cache");
    assert.equal(headersForPath("/index.html").get("cache-control"), "no-cache");
    assert.equal(headersForPath("/s/dev/channel/general").get("cache-control"), "no-cache");
  });

  test("keeps the service worker quickly revalidated", () => {
    assert.equal(headersForPath("/sw.js").get("cache-control"), "no-cache");
  });

  test("caches content-hashed assets immutably", () => {
    const immutable = "public, max-age=31536000, immutable";

    assert.equal(headersForPath("/assets/index-abc123.js").get("cache-control"), immutable);
    assert.equal(headersForPath("/assets/index-def456.css").get("cache-control"), immutable);
  });

  test("forces desktop manifest revalidation and JSON sniff protection", () => {
    const headers = headersForPath("/desktop-manifest.json");
    assert.equal(headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(headers.get("cache-control"), "no-cache, must-revalidate");
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.equal(headers.get("etag"), "__RAFT_DESKTOP_MANIFEST_ETAG__");
  });
});
